mod engine;

use anyhow::{anyhow, Context, Result};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use clap::{Args, Parser, Subcommand};
use engine::{
    CursorConflict, Engine, IndexDefinition, InvalidInput, MutationBatch, QueryRequest,
    MAX_BODY_BYTES, PROTOCOL_VERSION,
};
use hyper::server::conn::http1;
use hyper_util::{rt::TokioIo, service::TowerToHyperService};
use serde::{de::DeserializeOwned, Serialize};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{net::UnixListener, sync::Semaphore};

#[derive(Parser)]
#[command(
    name = "cohub-search",
    version,
    about = "String document index / 字符串文档索引"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Serve(ServeArgs),
    Apply(InputArgs),
    Query(InputArgs),
    Status(IndexArgs),
}

#[derive(Args)]
struct IndexArgs {
    #[arg(long)]
    index: PathBuf,
    #[arg(long)]
    schema: PathBuf,
}

#[derive(Args)]
struct ServeArgs {
    #[command(flatten)]
    index: IndexArgs,
    #[arg(long)]
    socket: PathBuf,
}

#[derive(Args)]
struct InputArgs {
    #[command(flatten)]
    index: IndexArgs,
    /// Read a JSON request from this file, or stdin / 从文件或标准输入读取 JSON 请求
    #[arg(long)]
    input: Option<PathBuf>,
}

fn read_json<T: DeserializeOwned>(path: Option<&Path>) -> Result<T> {
    let reader: Box<dyn Read> = match path {
        Some(path) => Box::new(fs::File::open(path)?),
        None => Box::new(io::stdin()),
    };
    let mut bytes = Vec::new();
    reader
        .take((MAX_BODY_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(anyhow!("JSON exceeds 32 MiB / JSON 超过 32 MiB"));
    }
    serde_json::from_slice(&bytes).context("invalid JSON request / JSON 请求无效")
}

fn open(args: &IndexArgs) -> Result<Engine> {
    let definition: IndexDefinition = read_json(Some(&args.schema))?;
    Engine::open(&args.index, definition)
}

fn print_json(value: &impl Serialize) -> Result<()> {
    println!("{}", serde_json::to_string(value)?);
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Serve(args) => serve(args).await,
        Command::Status(args) => print_json(&open(&args)?.status()),
        Command::Apply(args) => {
            print_json(
                &open(&args.index)?.apply(&read_json::<MutationBatch>(args.input.as_deref())?)?,
            )
        }
        Command::Query(args) => print_json(
            &open(&args.index)?.query(&read_json::<QueryRequest>(args.input.as_deref())?)?,
        ),
    }
}

#[derive(Clone)]
struct AppState {
    engine: Arc<Engine>,
    permits: Arc<Semaphore>,
}

struct ApiError(anyhow::Error);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = if self.0.is::<InvalidInput>() {
            StatusCode::BAD_REQUEST
        } else if self.0.is::<CursorConflict>() {
            StatusCode::CONFLICT
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        };
        (
            status,
            Json(serde_json::json!({"error": self.0.to_string()})),
        )
            .into_response()
    }
}

async fn blocking<T: Send + 'static>(
    state: AppState,
    task: impl FnOnce(&Engine) -> Result<T> + Send + 'static,
) -> Result<T, ApiError> {
    let permit = state
        .permits
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError(anyhow!("search busy; retry later / 搜索繁忙，请重试")))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        task(&state.engine)
    })
    .await
    .map_err(|error| ApiError(error.into()))?
    .map_err(ApiError)
}

async fn status(State(state): State<AppState>) -> Result<Json<engine::IndexStatus>, ApiError> {
    blocking(state, |engine| Ok(engine.status()))
        .await
        .map(Json)
}
async fn apply(
    State(state): State<AppState>,
    Json(request): Json<MutationBatch>,
) -> Result<Json<engine::IndexStatus>, ApiError> {
    blocking(state, move |engine| engine.apply(&request))
        .await
        .map(Json)
}
async fn query(
    State(state): State<AppState>,
    Json(request): Json<QueryRequest>,
) -> Result<Json<engine::QueryResponse>, ApiError> {
    blocking(state, move |engine| engine.query(&request))
        .await
        .map(Json)
}

async fn serve(args: ServeArgs) -> Result<()> {
    let parent = args
        .socket
        .parent()
        .context("socket requires a private parent directory / socket 需要私有目录")?;
    ensure_socket_directory(parent)?;
    // Acquire the index writer lock before touching the socket of another process.
    let engine = Arc::new(open(&args.index)?);
    match fs::symlink_metadata(&args.socket) {
        Ok(metadata) => {
            if !metadata.file_type().is_socket() {
                return Err(anyhow!(
                    "refusing to replace non-socket path / 拒绝覆盖非 socket 文件"
                ));
            }
            fs::remove_file(&args.socket)?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let listener = UnixListener::bind(&args.socket)?;
    fs::set_permissions(&args.socket, fs::Permissions::from_mode(0o600))?;
    let app = Router::new()
        .route(
            "/healthz",
            get(|| async { Json(serde_json::json!({"protocolVersion": PROTOCOL_VERSION})) }),
        )
        .route("/status", get(status))
        .route("/documents/apply", post(apply))
        .route("/query", post(query))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(AppState {
            engine,
            permits: Arc::new(Semaphore::new(8)),
        });
    eprintln!(
        "cohub-search listening / 搜索已启动: {}",
        args.socket.display()
    );
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let service = app.clone();
                tokio::spawn(async move {
                    if let Err(error) = http1::Builder::new().serve_connection(TokioIo::new(stream), TowerToHyperService::new(service)).await {
                        eprintln!("search HTTP error / 搜索请求错误: {error}");
                    }
                });
            }
            signal = tokio::signal::ctrl_c() => { signal?; break; }
        }
    }
    fs::remove_file(&args.socket)?;
    Ok(())
}

fn ensure_socket_directory(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty() || path == Path::new(".") {
        return Err(anyhow!(
            "socket needs a private directory / socket 需要私有目录"
        ));
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
                return Err(anyhow!(
                    "socket parent must be a directory with mode 0700 / socket 目录权限必须为 0700"
                ));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(path)?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_socket_directory_permissions_are_never_changed() {
        let root = tempfile::tempdir().unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(ensure_socket_directory(root.path()).is_err());
        assert_eq!(
            fs::metadata(root.path()).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
    #[test]
    fn new_socket_directory_is_private() {
        let root = tempfile::tempdir().unwrap();
        let socket = root.path().join("run/search");
        ensure_socket_directory(&socket).unwrap();
        assert_eq!(
            fs::metadata(socket).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}
