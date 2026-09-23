use anyhow::{anyhow, Context, Result};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use clap::{Args, Parser, Subcommand};
use globset::Glob;
use hyper::server::conn::http1;
use hyper_util::{rt::TokioIo, service::TowerToHyperService};
use ignore::{gitignore::GitignoreBuilder, WalkBuilder};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use tantivy::{
    collector::TopDocs,
    query::{BooleanQuery, Query, TermQuery},
    schema::{
        Field, IndexRecordOption, Schema, TantivyDocument, TextFieldIndexing, TextOptions, Value,
        STORED, STRING,
    },
    tokenizer::{NgramTokenizer, TextAnalyzer},
    Index, IndexReader, IndexWriter, ReloadPolicy, TantivyError, Term,
};
use tokio::{net::UnixListener, sync::mpsc, time::sleep};

const INDEX_FAMILY: &str = "workspace.candidates";
const INDEX_SCHEMA_VERSION: u32 = 1;
const INDEX_ANALYZER_VERSION: &str = "trigram-v1";
const INDEX_WRITER_MEMORY_BYTES: usize = 64 * 1024 * 1024;
const MAX_INDEXED_FILE_BYTES: u64 = 4 * 1024 * 1024;
const UPDATE_DEBOUNCE: Duration = Duration::from_secs(3);
const DEFAULT_QUERY_LIMIT: usize = 1000;
const MAX_QUERY_LIMIT: usize = 5000;
const INDEX_RETRY_DELAY: Duration = Duration::from_secs(5);
const FILE_SNAPSHOT_NAME: &str = "files.json";
const PATH_SNAPSHOT_NAME: &str = "paths.json";
const FILE_SNAPSHOT_DIRTY_NAME: &str = ".files-dirty";
const PATH_SNAPSHOT_DIRTY_NAME: &str = ".paths-dirty";
const REBUILD_DIRTY_NAME: &str = ".rebuild-dirty";
const PATH_INDEX_FAMILY: &str = "workspace.paths";
const PATH_SCHEMA_VERSION: u32 = 1;

#[derive(Parser)]
#[command(name = "cohub-search", version, about = "Cohub workspace search index")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Serve(ServeArgs),
    Full(IndexArgs),
    Update(UpdateArgs),
    Query(QueryArgs),
    Status(IndexArgs),
}

#[derive(Args, Clone)]
struct ServeArgs {
    #[command(flatten)]
    index: IndexArgs,
    #[arg(long)]
    socket: PathBuf,
}

#[derive(Args, Clone)]
struct IndexArgs {
    #[arg(long)]
    workspace: PathBuf,
    #[arg(long)]
    index: PathBuf,
    #[arg(long = "ignore", action = clap::ArgAction::Append, allow_hyphen_values = true)]
    ignore_patterns: Vec<String>,
}

#[derive(Args, Clone)]
struct UpdateArgs {
    #[command(flatten)]
    index: IndexArgs,
    #[arg(long)]
    changes: Option<PathBuf>,
}

#[derive(Args, Clone)]
struct QueryArgs {
    #[command(flatten)]
    index: IndexArgs,
    #[arg(long = "literal", action = clap::ArgAction::Append)]
    literals: Vec<String>,
    #[arg(long, default_value = "")]
    path_prefix: String,
    #[arg(long)]
    glob: Option<String>,
    #[arg(long, default_value_t = DEFAULT_QUERY_LIMIT)]
    limit: usize,
}

#[derive(Clone)]
struct AppState {
    store: Arc<IndexStore>,
    jobs: mpsc::Sender<Job>,
    status: Arc<Mutex<IndexStatus>>,
    reconcile_retry_scheduled: Arc<AtomicBool>,
}

struct IndexStore {
    workspace: PathBuf,
    index_dir: PathBuf,
    ignore_patterns: Vec<String>,
    manifest: IndexManifest,
    path_field: Field,
    content_field: Field,
    snapshot: Mutex<Option<HashMap<String, FileFingerprint>>>,
    paths: Mutex<Option<HashSet<String>>>,
    /// True once the in-memory snapshot was produced or verified by this
    /// process. A snapshot loaded from disk beside a dirty marker is untrusted
    /// until reconcile confirms it; the dirty marker itself only tracks
    /// whether `files.json` lags the live index for restart recovery.
    snapshot_verified: AtomicBool,
    path_snapshot_verified: AtomicBool,
    reader: Mutex<IndexReader>,
    writer: Mutex<IndexWriter>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexManifest {
    family: String,
    generation: String,
    schema_version: u32,
    analyzer_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FileFingerprint {
    size: u64,
    mtime_ns: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathSnapshot {
    family: String,
    schema_version: u32,
    paths: HashSet<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexChange {
    path: String,
    #[serde(default)]
    old_path: Option<String>,
    kind: String,
    #[serde(default)]
    node_type: Option<String>,
}

enum Job {
    Full,
    Reconcile,
    Update(Vec<IndexChange>),
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexStatus {
    family: String,
    generation: String,
    schema_version: u32,
    analyzer_version: String,
    state: String,
    coverage: String,
    document_count: u64,
    pending_changes: usize,
    last_commit_at: Option<u64>,
    last_error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateRequest {
    changes: Vec<IndexChange>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryRequest {
    literals: Vec<String>,
    #[serde(default)]
    path_prefix: String,
    #[serde(default)]
    glob: Option<String>,
    #[serde(default)]
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathQueryRequest {
    pattern: String,
    #[serde(default)]
    path_prefix: String,
    #[serde(default)]
    full_path: bool,
    #[serde(default)]
    ignore: Vec<String>,
    #[serde(default)]
    limit: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryResponse {
    matches: Vec<String>,
    truncated: bool,
    state: String,
    index_family: String,
    schema_version: u32,
    coverage: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PathQueryResponse {
    matches: Vec<String>,
    truncated: bool,
    state: String,
    index_family: String,
    schema_version: u32,
    coverage: String,
}

struct PathQueryResult {
    matches: Vec<String>,
    truncated: bool,
    index_family: String,
    schema_version: u32,
    coverage: String,
}

#[derive(Debug, Serialize)]
struct AcceptedResponse {
    accepted: bool,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(ErrorResponse { error: self.1 })).into_response()
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Serve(args) => serve(args).await,
        Command::Full(args) => {
            let store =
                IndexStore::open_with_ignores(&args.workspace, &args.index, args.ignore_patterns)?;
            store.full_rebuild()?;
            print_status(&store)
        }
        Command::Update(args) => {
            let store = IndexStore::open_with_ignores(
                &args.index.workspace,
                &args.index.index,
                args.index.ignore_patterns,
            )?;
            let changes = read_changes(args.changes)?;
            store.apply_changes(&changes)?;
            print_status(&store)
        }
        Command::Query(args) => {
            let store = IndexStore::open_with_ignores(
                &args.index.workspace,
                &args.index.index,
                args.index.ignore_patterns,
            )?;
            let result = store.query(&QueryRequest {
                literals: args.literals,
                path_prefix: args.path_prefix,
                glob: args.glob,
                limit: args.limit,
            })?;
            println!("{}", serde_json::to_string_pretty(&result)?);
            Ok(())
        }
        Command::Status(args) => {
            let store =
                IndexStore::open_with_ignores(&args.workspace, &args.index, args.ignore_patterns)?;
            print_status(&store)
        }
    }
}

async fn serve(args: ServeArgs) -> Result<()> {
    if let Some(parent) = args.socket.parent() {
        ensure_socket_directory(parent)?;
    }
    remove_stale_socket(&args.socket)?;

    let store = Arc::new(open_store_for_serve(
        &args.index.workspace,
        &args.index.index,
        args.index.ignore_patterns,
    )?);
    let (jobs, receiver) = mpsc::channel(64);
    let status = Arc::new(Mutex::new(IndexStatus::ready(&store)));
    let state = AppState {
        store,
        jobs,
        status,
        reconcile_retry_scheduled: Arc::new(AtomicBool::new(false)),
    };
    tokio::spawn(index_worker(receiver, state.clone()));

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/status", get(status_handler))
        .route("/index/full", post(full_handler))
        .route("/index/reconcile", post(reconcile_handler))
        .route("/index/update", post(update_handler))
        .route("/query", post(query_handler))
        .route("/paths/query", post(path_query_handler))
        .with_state(state);

    let listener = UnixListener::bind(&args.socket)
        .with_context(|| format!("bind unix socket {}", args.socket.display()))?;
    secure_socket(&args.socket)?;
    eprintln!("cohub-search listening on {}", args.socket.display());

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted.context("accept unix connection")?;
                let service = app.clone().into_service();
                tokio::spawn(async move {
                    if let Err(error) = http1::Builder::new()
                        .serve_connection(
                            TokioIo::new(stream),
                            TowerToHyperService::new(service),
                        )
                        .await
                    {
                        eprintln!("cohub-search http connection failed: {error}");
                    }
                });
            }
            signal = tokio::signal::ctrl_c() => {
                signal.context("wait for shutdown signal")?;
                break;
            }
        }
    }

    let _ = fs::remove_file(&args.socket);
    Ok(())
}

fn ensure_socket_directory(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty() || path == Path::new(".") {
        return Err(anyhow!("socket must be placed inside a private directory"));
    }

    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_dir() {
                return Err(anyhow!(
                    "socket parent is not a directory: {}",
                    path.display()
                ));
            }
            validate_socket_directory(path, &metadata)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(path)
                .with_context(|| format!("create socket directory {}", path.display()))?;
            secure_new_socket_directory(path)
        }
        Err(error) => {
            Err(error).with_context(|| format!("inspect socket directory {}", path.display()))
        }
    }
}

#[cfg(unix)]
fn validate_socket_directory(path: &Path, metadata: &fs::Metadata) -> Result<()> {
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(anyhow!(
            "socket directory must have mode 0700: {}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn validate_socket_directory(_path: &Path, _metadata: &fs::Metadata) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn secure_new_socket_directory(path: &Path) -> Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("secure socket directory {}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn secure_new_socket_directory(_path: &Path) -> Result<()> {
    Ok(())
}

fn remove_stale_socket(path: &Path) -> Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error).with_context(|| format!("inspect socket {}", path.display()))
        }
    };
    if !metadata.file_type().is_socket() {
        return Err(anyhow!(
            "refusing to replace non-socket path: {}",
            path.display()
        ));
    }
    fs::remove_file(path).with_context(|| format!("remove stale socket {}", path.display()))?;
    Ok(())
}

#[cfg(unix)]
fn secure_socket(path: &Path) -> Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("secure unix socket {}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn secure_socket(_path: &Path) -> Result<()> {
    Ok(())
}

async fn healthz() -> impl IntoResponse {
    Json(AcceptedResponse { accepted: true })
}

async fn status_handler(State(state): State<AppState>) -> Json<IndexStatus> {
    Json(status_snapshot(&state))
}

async fn full_handler(
    State(state): State<AppState>,
) -> Result<(StatusCode, Json<AcceptedResponse>), ApiError> {
    state.jobs.send(Job::Full).await.map_err(|_| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "index worker is stopped".to_string(),
        )
    })?;
    Ok((
        StatusCode::ACCEPTED,
        Json(AcceptedResponse { accepted: true }),
    ))
}

async fn reconcile_handler(
    State(state): State<AppState>,
) -> Result<(StatusCode, Json<AcceptedResponse>), ApiError> {
    state.jobs.send(Job::Reconcile).await.map_err(|_| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "index worker is stopped".to_string(),
        )
    })?;
    Ok((
        StatusCode::ACCEPTED,
        Json(AcceptedResponse { accepted: true }),
    ))
}

async fn update_handler(
    State(state): State<AppState>,
    Json(request): Json<UpdateRequest>,
) -> Result<(StatusCode, Json<AcceptedResponse>), ApiError> {
    if request.changes.is_empty() {
        return Ok((
            StatusCode::ACCEPTED,
            Json(AcceptedResponse { accepted: true }),
        ));
    }
    let count = request.changes.len();
    {
        let mut status = state.status.lock().expect("index status mutex poisoned");
        status.pending_changes = status.pending_changes.saturating_add(count);
    }
    state
        .jobs
        .send(Job::Update(request.changes))
        .await
        .map_err(|_| {
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "index worker is stopped".to_string(),
            )
        })?;
    Ok((
        StatusCode::ACCEPTED,
        Json(AcceptedResponse { accepted: true }),
    ))
}

async fn query_handler(
    State(state): State<AppState>,
    Json(request): Json<QueryRequest>,
) -> Result<Json<QueryResponse>, ApiError> {
    let result = state
        .store
        .query(&request)
        .map_err(|error| ApiError(StatusCode::BAD_REQUEST, error.to_string()))?;
    let status = status_snapshot(&state);
    Ok(Json(QueryResponse {
        matches: result.matches,
        truncated: result.truncated,
        state: status.state,
        index_family: result.index_family,
        schema_version: result.schema_version,
        coverage: status.coverage,
    }))
}

async fn path_query_handler(
    State(state): State<AppState>,
    Json(request): Json<PathQueryRequest>,
) -> Result<Json<PathQueryResponse>, ApiError> {
    let result = state
        .store
        .path_query(&request)
        .map_err(|error| ApiError(StatusCode::BAD_REQUEST, error.to_string()))?;
    let status = status_snapshot(&state);
    let coverage = if status.coverage == "complete" {
        result.coverage
    } else {
        status.coverage
    };
    Ok(Json(PathQueryResponse {
        matches: result.matches,
        truncated: result.truncated,
        state: status.state,
        index_family: result.index_family,
        schema_version: result.schema_version,
        coverage,
    }))
}

async fn index_worker(mut receiver: mpsc::Receiver<Job>, state: AppState) {
    while let Some(job) = receiver.recv().await {
        match job {
            Job::Full => run_full(&state).await,
            Job::Reconcile => {
                let mut changes = Vec::new();
                let mut full_requested = false;
                while let Ok(next) = receiver.try_recv() {
                    match next {
                        Job::Update(more) => changes.extend(more),
                        Job::Reconcile => {}
                        Job::Full => {
                            full_requested = true;
                            break;
                        }
                    }
                }
                if full_requested {
                    run_full(&state).await;
                } else {
                    run_reconcile(&state).await;
                    if !changes.is_empty() {
                        run_update(&state, changes).await;
                    }
                }
            }
            Job::Update(mut changes) => {
                let mut reconcile_requested = false;
                let mut full_requested = false;
                let mut deadline = Box::pin(sleep(UPDATE_DEBOUNCE));
                loop {
                    tokio::select! {
                        _ = &mut deadline => break,
                        next = receiver.recv() => match next {
                            Some(Job::Update(more)) => {
                                changes.extend(more);
                                deadline = Box::pin(sleep(UPDATE_DEBOUNCE));
                            }
                            Some(Job::Reconcile) => {
                                reconcile_requested = true;
                            }
                            Some(Job::Full) => {
                                full_requested = true;
                                break;
                            }
                            None => break,
                        }
                    }
                }
                if full_requested {
                    run_full(&state).await;
                } else if reconcile_requested {
                    run_reconcile(&state).await;
                    if !changes.is_empty() {
                        run_update(&state, changes).await;
                    }
                } else {
                    run_update(&state, changes).await;
                }
            }
        }
    }
}

async fn run_full(state: &AppState) {
    set_indexing(&state.status, 0);
    let store = state.store.clone();
    let result = tokio::task::spawn_blocking(move || store.full_rebuild()).await;
    match result {
        Ok(Ok(())) => set_ready(state),
        Ok(Err(error)) => {
            set_error(state, error);
            run_reconcile(state).await;
        }
        Err(error) => {
            set_error(state, anyhow!("full index task failed: {error}"));
            run_reconcile(state).await;
        }
    }
}

async fn run_reconcile(state: &AppState) {
    set_indexing(&state.status, 0);
    let store = state.store.clone();
    let result = tokio::task::spawn_blocking(move || store.reconcile()).await;
    match result {
        Ok(Ok(())) => set_ready(state),
        Ok(Err(error)) => {
            set_error(state, error);
            schedule_reconcile_retry(state);
        }
        Err(error) => {
            set_error(state, anyhow!("reconcile task failed: {error}"));
            schedule_reconcile_retry(state);
        }
    }
}

fn schedule_reconcile_retry(state: &AppState) {
    if state
        .reconcile_retry_scheduled
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    let jobs = state.jobs.clone();
    let scheduled = state.reconcile_retry_scheduled.clone();
    tokio::spawn(async move {
        sleep(INDEX_RETRY_DELAY).await;
        scheduled.store(false, Ordering::Release);
        let _ = jobs.send(Job::Reconcile).await;
    });
}

async fn run_update(state: &AppState, changes: Vec<IndexChange>) {
    set_indexing(&state.status, 0);
    let store = state.store.clone();
    let result = tokio::task::spawn_blocking(move || store.apply_changes(&changes)).await;
    match result {
        Ok(Ok(())) => set_ready(state),
        Ok(Err(error)) => {
            set_error(state, error);
            run_reconcile(state).await;
        }
        Err(error) => {
            set_error(state, anyhow!("incremental index task failed: {error}"));
            run_reconcile(state).await;
        }
    }
}

fn set_indexing(status: &Mutex<IndexStatus>, pending_changes: usize) {
    let mut snapshot = status.lock().expect("index status mutex poisoned");
    snapshot.state = "indexing".to_string();
    snapshot.coverage = "partial".to_string();
    snapshot.pending_changes = pending_changes;
}

fn set_ready(state: &AppState) {
    state
        .reconcile_retry_scheduled
        .store(false, Ordering::Release);
    let mut snapshot = state.status.lock().expect("index status mutex poisoned");
    snapshot.state = "ready".to_string();
    snapshot.coverage = state.store.coverage().to_string();
    snapshot.document_count = state.store.doc_count();
    snapshot.pending_changes = 0;
    snapshot.last_commit_at = Some(now_ms());
    snapshot.last_error = None;
}

fn set_error(state: &AppState, error: anyhow::Error) {
    let mut snapshot = state.status.lock().expect("index status mutex poisoned");
    snapshot.state = "error".to_string();
    snapshot.coverage = "partial".to_string();
    snapshot.document_count = state.store.doc_count();
    snapshot.pending_changes = 0;
    snapshot.last_error = Some(error.to_string());
}

impl IndexStatus {
    fn ready(store: &IndexStore) -> Self {
        let coverage = store.coverage().to_string();
        Self {
            family: store.manifest.family.clone(),
            generation: store.manifest.generation.clone(),
            schema_version: store.manifest.schema_version,
            analyzer_version: store.manifest.analyzer_version.clone(),
            state: if coverage == "complete" {
                "ready".to_string()
            } else {
                "indexing".to_string()
            },
            coverage,
            document_count: store.doc_count(),
            pending_changes: 0,
            last_commit_at: None,
            last_error: None,
        }
    }
}

fn status_snapshot(state: &AppState) -> IndexStatus {
    let mut status = state
        .status
        .lock()
        .expect("index status mutex poisoned")
        .clone();
    // Accepted but not yet committed changes are invisible to queries; a
    // caller must not treat the index as authoritative during the debounce.
    if status.pending_changes > 0 {
        status.coverage = "partial".to_string();
    }
    status
}

fn open_store_for_serve(
    workspace: &Path,
    index_dir: &Path,
    ignore_patterns: Vec<String>,
) -> Result<IndexStore> {
    if !workspace.is_dir() {
        return Err(anyhow!(
            "workspace is not a directory: {}",
            workspace.display()
        ));
    }
    match IndexStore::open_with_ignores(workspace, index_dir, ignore_patterns.clone()) {
        Ok(store) => Ok(store),
        Err(error) if should_quarantine_index(&error) => {
            quarantine_index_contents(index_dir)?;
            IndexStore::open_with_ignores(workspace, index_dir, ignore_patterns)
                .with_context(|| format!("recreate recovered index {}", index_dir.display()))
        }
        Err(error) => Err(error),
    }
}

fn should_quarantine_index(error: &anyhow::Error) -> bool {
    if error.to_string().contains("parse manifest")
        || error
            .to_string()
            .contains("unsupported search index manifest")
        || error.to_string().contains("parse file snapshot")
        || error.to_string().contains("parse path snapshot")
        || error.to_string().contains("unsupported path snapshot")
    {
        return true;
    }
    error.chain().any(|cause| {
        cause.downcast_ref::<TantivyError>().is_some_and(|error| {
            matches!(
                error,
                TantivyError::DataCorruption(_)
                    | TantivyError::SchemaError(_)
                    | TantivyError::IndexBuilderMissingArgument(_)
            )
        })
    })
}

fn quarantine_index_contents(index_dir: &Path) -> Result<()> {
    if !index_dir.exists() {
        return Ok(());
    }
    let mut suffix = 0u32;
    let quarantine = loop {
        let name = if suffix == 0 {
            format!(".corrupt-{}", now_ms())
        } else {
            format!(".corrupt-{}-{}", now_ms(), suffix)
        };
        let candidate = index_dir.join(name);
        match fs::create_dir(&candidate) {
            Ok(()) => break candidate,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                suffix = suffix.saturating_add(1);
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("create quarantine directory {}", candidate.display())
                });
            }
        }
    };
    for entry in fs::read_dir(index_dir)
        .with_context(|| format!("read index directory {}", index_dir.display()))?
    {
        let entry = entry.context("read index directory entry")?;
        if entry.path() == quarantine {
            continue;
        }
        fs::rename(entry.path(), quarantine.join(entry.file_name()))
            .with_context(|| format!("quarantine index entry in {}", quarantine.display()))?;
    }
    eprintln!(
        "cohub-search: quarantined invalid index at {}",
        quarantine.display()
    );
    Ok(())
}

fn expected_manifest() -> IndexManifest {
    IndexManifest {
        family: INDEX_FAMILY.to_string(),
        generation: format!("{}-{}", now_ms(), std::process::id()),
        schema_version: INDEX_SCHEMA_VERSION,
        analyzer_version: INDEX_ANALYZER_VERSION.to_string(),
    }
}

fn load_or_create_manifest(index_dir: &Path) -> Result<IndexManifest> {
    let path = index_dir.join("manifest.json");
    if path.exists() {
        let data = fs::read(&path).with_context(|| format!("read manifest {}", path.display()))?;
        let manifest: IndexManifest = serde_json::from_slice(&data)
            .with_context(|| format!("parse manifest {}", path.display()))?;
        if manifest.family != INDEX_FAMILY
            || manifest.schema_version != INDEX_SCHEMA_VERSION
            || manifest.analyzer_version != INDEX_ANALYZER_VERSION
        {
            return Err(anyhow!("unsupported search index manifest"));
        }
        return Ok(manifest);
    }

    let manifest = expected_manifest();
    let data = serde_json::to_vec_pretty(&manifest).context("serialize index manifest")?;
    let temporary = index_dir.join(format!(".manifest-{}.tmp", std::process::id()));
    fs::write(&temporary, data)
        .with_context(|| format!("write manifest {}", temporary.display()))?;
    fs::rename(&temporary, &path)
        .with_context(|| format!("install manifest {}", path.display()))?;
    Ok(manifest)
}

fn snapshot_path(index_dir: &Path) -> PathBuf {
    index_dir.join(FILE_SNAPSHOT_NAME)
}

fn path_snapshot_path(index_dir: &Path) -> PathBuf {
    index_dir.join(PATH_SNAPSHOT_NAME)
}

fn snapshot_dirty_path(index_dir: &Path) -> PathBuf {
    index_dir.join(FILE_SNAPSHOT_DIRTY_NAME)
}

fn path_snapshot_dirty_path(index_dir: &Path) -> PathBuf {
    index_dir.join(PATH_SNAPSHOT_DIRTY_NAME)
}

fn rebuild_dirty_path(index_dir: &Path) -> PathBuf {
    index_dir.join(REBUILD_DIRTY_NAME)
}

fn mark_snapshot_dirty(index_dir: &Path) -> Result<()> {
    let path = snapshot_dirty_path(index_dir);
    if !path.exists() {
        fs::write(&path, b"dirty")
            .with_context(|| format!("mark snapshot dirty {}", path.display()))?;
    }
    Ok(())
}

fn mark_path_snapshot_dirty(index_dir: &Path) -> Result<()> {
    let path = path_snapshot_dirty_path(index_dir);
    if !path.exists() {
        fs::write(&path, b"dirty")
            .with_context(|| format!("mark path snapshot dirty {}", path.display()))?;
    }
    Ok(())
}

fn mark_rebuild_dirty(index_dir: &Path) -> Result<()> {
    let path = rebuild_dirty_path(index_dir);
    if !path.exists() {
        fs::write(&path, b"dirty")
            .with_context(|| format!("mark rebuild dirty {}", path.display()))?;
    }
    Ok(())
}

fn clear_file_dirty_markers(index_dir: &Path) -> Result<()> {
    match fs::remove_file(snapshot_dirty_path(index_dir)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("clear dirty file snapshot marker"),
    }
}

fn clear_rebuild_dirty_marker(index_dir: &Path) -> Result<()> {
    match fs::remove_file(rebuild_dirty_path(index_dir)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("clear dirty rebuild marker"),
    }
}

fn clear_path_dirty_marker(index_dir: &Path) -> Result<()> {
    match fs::remove_file(path_snapshot_dirty_path(index_dir)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("clear dirty path snapshot marker"),
    }
}

fn load_snapshot(index_dir: &Path) -> Result<Option<HashMap<String, FileFingerprint>>> {
    let path = snapshot_path(index_dir);
    if !path.exists() {
        return Ok(None);
    }
    let data = fs::read(&path).with_context(|| format!("read file snapshot {}", path.display()))?;
    let snapshot = serde_json::from_slice(&data)
        .with_context(|| format!("parse file snapshot {}", path.display()))?;
    Ok(Some(snapshot))
}

fn load_path_snapshot(index_dir: &Path) -> Result<Option<HashSet<String>>> {
    let path = path_snapshot_path(index_dir);
    if !path.exists() {
        return Ok(None);
    }
    let data = fs::read(&path).with_context(|| format!("read path snapshot {}", path.display()))?;
    let snapshot: PathSnapshot = serde_json::from_slice(&data)
        .with_context(|| format!("parse path snapshot {}", path.display()))?;
    if snapshot.family != PATH_INDEX_FAMILY || snapshot.schema_version != PATH_SCHEMA_VERSION {
        return Err(anyhow!("unsupported path snapshot"));
    }
    Ok(Some(snapshot.paths))
}

fn persist_snapshot(index_dir: &Path, snapshot: &HashMap<String, FileFingerprint>) -> Result<()> {
    let path = snapshot_path(index_dir);
    let temporary = index_dir.join(format!(".files-{}.tmp", std::process::id()));
    let data = serde_json::to_vec(snapshot).context("serialize file snapshot")?;
    fs::write(&temporary, data)
        .with_context(|| format!("write file snapshot {}", temporary.display()))?;
    fs::rename(&temporary, &path)
        .with_context(|| format!("install file snapshot {}", path.display()))?;
    clear_file_dirty_markers(index_dir)?;
    Ok(())
}

fn persist_path_snapshot(index_dir: &Path, paths: &HashSet<String>) -> Result<()> {
    let path = path_snapshot_path(index_dir);
    let temporary = index_dir.join(format!(".paths-{}.tmp", std::process::id()));
    let snapshot = PathSnapshot {
        family: PATH_INDEX_FAMILY.to_string(),
        schema_version: PATH_SCHEMA_VERSION,
        paths: paths.clone(),
    };
    let data = serde_json::to_vec(&snapshot).context("serialize path snapshot")?;
    fs::write(&temporary, data)
        .with_context(|| format!("write path snapshot {}", temporary.display()))?;
    fs::rename(&temporary, &path)
        .with_context(|| format!("install path snapshot {}", path.display()))?;
    clear_path_dirty_marker(index_dir)?;
    clear_rebuild_dirty_marker(index_dir)?;
    Ok(())
}

fn file_fingerprint(path: &Path) -> Result<FileFingerprint> {
    let metadata = fs::symlink_metadata(path).map_err(anyhow::Error::from)?;
    let mtime_ns = metadata
        .modified()
        .ok()
        .and_then(|mtime| mtime.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    Ok(FileFingerprint {
        size: metadata.len(),
        mtime_ns,
    })
}

fn is_not_found_error(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<io::Error>()
        .is_some_and(|error| error.kind() == io::ErrorKind::NotFound)
}

fn scan_workspace_state(
    workspace: &Path,
    ignore_patterns: &[String],
) -> Result<(HashMap<String, FileFingerprint>, HashSet<String>)> {
    let mut snapshot = HashMap::new();
    let mut paths = HashSet::new();
    let filter_workspace = workspace.to_path_buf();
    let filter_ignore_patterns = ignore_patterns.to_vec();
    for entry in WalkBuilder::new(workspace)
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .parents(false)
        .filter_entry(move |entry| {
            !is_ignored_workspace_path(&filter_workspace, entry.path(), &filter_ignore_patterns)
        })
        .build()
    {
        let entry = entry.context("walk workspace while reconciling")?;
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() && !file_type.is_dir() && !file_type.is_symlink() {
            continue;
        }
        let path = entry.into_path();
        let relative = path
            .strip_prefix(workspace)
            .with_context(|| format!("path outside workspace: {}", path.display()))?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let relative = normalize_relative_path(&relative.to_string_lossy())?;
        paths.insert(relative.clone());
        if !file_type.is_file() {
            continue;
        }
        let fingerprint = match file_fingerprint(&path) {
            Ok(fingerprint) => fingerprint,
            Err(error) if is_not_found_error(&error) => continue,
            Err(error) => {
                return Err(error).with_context(|| format!("fingerprint {}", path.display()))
            }
        };
        snapshot.insert(relative, fingerprint);
    }
    Ok((snapshot, paths))
}

impl IndexStore {
    #[cfg(test)]
    fn open(workspace: &Path, index_dir: &Path) -> Result<Self> {
        Self::open_with_ignores(workspace, index_dir, Vec::new())
    }

    fn open_with_ignores(
        workspace: &Path,
        index_dir: &Path,
        ignore_patterns: Vec<String>,
    ) -> Result<Self> {
        if !workspace.is_dir() {
            return Err(anyhow!(
                "workspace is not a directory: {}",
                workspace.display()
            ));
        }
        fs::create_dir_all(index_dir)
            .with_context(|| format!("create index directory {}", index_dir.display()))?;

        let schema_path = index_dir.join("meta.json");
        let (index, schema) = if schema_path.exists() {
            let index = Index::open_in_dir(index_dir)
                .with_context(|| format!("open index {}", index_dir.display()))?;
            let schema = index.schema();
            (index, schema)
        } else {
            let schema = build_schema();
            let index = Index::create_in_dir(index_dir, schema.clone())
                .with_context(|| format!("create index {}", index_dir.display()))?;
            (index, schema)
        };

        validate_schema(&schema)?;
        let manifest = load_or_create_manifest(index_dir)?;
        let snapshot = load_snapshot(index_dir)?;
        let paths = load_path_snapshot(index_dir)?;
        let snapshot_verified = snapshot.is_some()
            && !snapshot_dirty_path(index_dir).exists()
            && !rebuild_dirty_path(index_dir).exists();
        let path_snapshot_verified = paths.is_some()
            && !path_snapshot_dirty_path(index_dir).exists()
            && !rebuild_dirty_path(index_dir).exists();
        register_tokenizer(&index)?;
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()
            .context("create tantivy reader")?;
        let writer = index
            .writer(INDEX_WRITER_MEMORY_BYTES)
            .context("create tantivy writer")?;

        Ok(Self {
            workspace: workspace.to_path_buf(),
            index_dir: index_dir.to_path_buf(),
            ignore_patterns: normalize_ignore_patterns(ignore_patterns),
            manifest,
            path_field: schema.get_field("path").context("path field missing")?,
            content_field: schema
                .get_field("content")
                .context("content field missing")?,
            snapshot: Mutex::new(snapshot),
            paths: Mutex::new(paths),
            snapshot_verified: AtomicBool::new(snapshot_verified),
            path_snapshot_verified: AtomicBool::new(path_snapshot_verified),
            reader: Mutex::new(reader),
            writer: Mutex::new(writer),
        })
    }

    fn coverage(&self) -> &'static str {
        if self.snapshot_verified.load(Ordering::Acquire) {
            "complete"
        } else {
            "stale"
        }
    }

    fn install_snapshot(&self, snapshot: HashMap<String, FileFingerprint>) {
        *self.snapshot.lock().expect("file snapshot mutex poisoned") = Some(snapshot);
        self.snapshot_verified.store(true, Ordering::Release);
    }

    fn path_coverage(&self) -> &'static str {
        if self.path_snapshot_verified.load(Ordering::Acquire) {
            "complete"
        } else {
            "stale"
        }
    }

    fn install_paths(&self, paths: HashSet<String>) {
        *self.paths.lock().expect("path snapshot mutex poisoned") = Some(paths);
        self.path_snapshot_verified.store(true, Ordering::Release);
    }

    fn path_query(&self, request: &PathQueryRequest) -> Result<PathQueryResult> {
        let limit = if request.limit == 0 {
            DEFAULT_QUERY_LIMIT
        } else {
            request.limit.min(MAX_QUERY_LIMIT)
        };
        let pattern = if request.pattern.is_empty() {
            "**"
        } else {
            request.pattern.as_str()
        };
        let mut matcher_builder = globset::GlobBuilder::new(pattern);
        matcher_builder
            .literal_separator(request.full_path)
            .case_insensitive(!pattern.chars().any(char::is_uppercase));
        let matcher = matcher_builder
            .build()
            .context("invalid path glob")?
            .compile_matcher();
        let path_prefix = normalize_prefix(&request.path_prefix);
        let ignore_matchers = request
            .ignore
            .iter()
            .filter(|pattern| !pattern.trim().is_empty())
            .map(|pattern| {
                let mut builder = globset::GlobBuilder::new(pattern);
                builder
                    .literal_separator(false)
                    .case_insensitive(!pattern.chars().any(char::is_uppercase));
                builder
                    .build()
                    .with_context(|| format!("invalid path ignore glob: {pattern}"))
                    .map(|glob| glob.compile_matcher())
            })
            .collect::<Result<Vec<_>>>()?;

        let mut paths = self
            .paths
            .lock()
            .expect("path snapshot mutex poisoned")
            .clone()
            .unwrap_or_default()
            .into_iter()
            .collect::<Vec<_>>();
        paths.sort();
        let mut matches = Vec::with_capacity(limit);
        let mut truncated = false;
        for path in paths {
            if path_prefix
                .as_deref()
                .is_some_and(|prefix| path == prefix || !path_has_prefix(&path, prefix))
            {
                continue;
            }
            if path_matches_ignore_globs(&path, &ignore_matchers) {
                continue;
            }
            let candidate = if request.full_path {
                path.as_str()
            } else {
                Path::new(&path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(path.as_str())
            };
            if !matcher.is_match(candidate) {
                continue;
            }
            if matches.len() == limit {
                truncated = true;
                break;
            }
            matches.push(path);
        }

        Ok(PathQueryResult {
            matches,
            truncated,
            index_family: PATH_INDEX_FAMILY.to_string(),
            schema_version: PATH_SCHEMA_VERSION,
            coverage: self.path_coverage().to_string(),
        })
    }

    fn full_rebuild(&self) -> Result<()> {
        // Mark the snapshot invalid before touching the live index. If the
        // rebuild fails after clearing documents, the next reconcile must not
        // trust the previous file snapshot.
        mark_rebuild_dirty(&self.index_dir)?;
        self.snapshot_verified.store(false, Ordering::Release);
        self.path_snapshot_verified.store(false, Ordering::Release);
        let mut writer = self.writer.lock().expect("tantivy writer mutex poisoned");
        let result = (|| -> Result<()> {
            writer.delete_all_documents().context("clear index")?;
            writer.commit().context("commit cleared index")?;
            self.reload_reader()?;

            let mut next_snapshot = HashMap::new();
            let mut next_paths = HashSet::new();
            let filter_workspace = self.workspace.clone();
            let filter_ignore_patterns = self.ignore_patterns.clone();
            let walker = WalkBuilder::new(&self.workspace)
                .hidden(false)
                .git_ignore(true)
                .git_global(false)
                .git_exclude(false)
                .parents(false)
                .filter_entry(move |entry| {
                    !is_ignored_workspace_path(
                        &filter_workspace,
                        entry.path(),
                        &filter_ignore_patterns,
                    )
                })
                .build();

            for entry in walker {
                let entry = entry.context("walk workspace while building index")?;
                let Some(file_type) = entry.file_type() else {
                    continue;
                };
                let is_file = file_type.is_file();
                let is_path = is_file || file_type.is_dir() || file_type.is_symlink();
                let path = entry.into_path();
                let relative = path
                    .strip_prefix(&self.workspace)
                    .with_context(|| format!("path outside workspace: {}", path.display()))?;
                if relative.as_os_str().is_empty() {
                    continue;
                }
                let relative = normalize_relative_path(&relative.to_string_lossy())?;
                if is_path {
                    next_paths.insert(relative.clone());
                }
                if !is_file {
                    continue;
                }
                let fingerprint = match file_fingerprint(&path) {
                    Ok(fingerprint) => fingerprint,
                    Err(error) if is_not_found_error(&error) => continue,
                    Err(error) => {
                        return Err(error)
                            .with_context(|| format!("fingerprint {}", path.display()))
                    }
                };
                next_snapshot.insert(relative, fingerprint);
                if let Some(document) = self.document_for_path(&path)? {
                    writer
                        .add_document(document)
                        .context("add indexed document")?;
                }
            }
            writer.commit().context("commit full index")?;
            self.reload_reader()?;
            persist_snapshot(&self.index_dir, &next_snapshot)?;
            persist_path_snapshot(&self.index_dir, &next_paths)?;
            self.install_snapshot(next_snapshot);
            self.install_paths(next_paths);
            Ok(())
        })();
        if let Err(error) = result {
            let _ = writer.rollback();
            return Err(error);
        }
        Ok(())
    }

    fn reconcile(&self) -> Result<()> {
        let previous = self
            .snapshot
            .lock()
            .expect("file snapshot mutex poisoned")
            .clone();
        let Some(previous) = previous else {
            return self.full_rebuild();
        };
        if rebuild_dirty_path(&self.index_dir).exists() {
            return self.full_rebuild();
        }
        let (current, current_paths) =
            scan_workspace_state(&self.workspace, &self.ignore_patterns)?;
        let mut changes = Vec::new();

        for (path, fingerprint) in &current {
            match previous.get(path) {
                None => changes.push(IndexChange {
                    path: path.clone(),
                    old_path: None,
                    kind: "create".to_string(),
                    node_type: Some("file".to_string()),
                }),
                Some(previous_fingerprint) if previous_fingerprint != fingerprint => {
                    changes.push(IndexChange {
                        path: path.clone(),
                        old_path: None,
                        kind: "modify".to_string(),
                        node_type: Some("file".to_string()),
                    })
                }
                Some(_) => {}
            }
        }
        for path in previous.keys() {
            if !current.contains_key(path) {
                changes.push(IndexChange {
                    path: path.clone(),
                    old_path: None,
                    kind: "delete".to_string(),
                    node_type: Some("file".to_string()),
                });
            }
        }
        changes.sort_by(|left, right| left.path.cmp(&right.path));
        if changes.is_empty() {
            if snapshot_dirty_path(&self.index_dir).exists() {
                persist_snapshot(&self.index_dir, &current)?;
            }
            persist_path_snapshot(&self.index_dir, &current_paths)?;
            self.install_snapshot(current);
            self.install_paths(current_paths);
            return Ok(());
        }
        self.apply_document_changes(&changes, current, true)?;
        persist_path_snapshot(&self.index_dir, &current_paths)?;
        self.install_paths(current_paths);
        Ok(())
    }

    fn apply_changes(&self, changes: &[IndexChange]) -> Result<()> {
        if changes.iter().any(|change| {
            Path::new(&change.path)
                .file_name()
                .is_some_and(|name| name == ".gitignore")
        }) {
            return self.reconcile();
        }
        let previous = self
            .snapshot
            .lock()
            .expect("file snapshot mutex poisoned")
            .clone();
        let Some(mut next_snapshot) = previous else {
            return self.full_rebuild();
        };
        let previous_paths = self
            .paths
            .lock()
            .expect("path snapshot mutex poisoned")
            .clone();
        let Some(mut next_paths) = previous_paths else {
            return self.reconcile();
        };

        let mut delete_prefixes = HashSet::new();
        for change in changes {
            if let Some(old_path) = change.old_path.as_deref() {
                delete_prefixes.insert(normalize_relative_path(old_path)?);
            }
            if change.kind == "delete" {
                delete_prefixes.insert(normalize_relative_path(&change.path)?);
            }
        }
        let delete_prefixes = compact_path_prefixes(delete_prefixes);
        next_paths.retain(|path| {
            !delete_prefixes
                .iter()
                .any(|prefix| path_has_prefix(path, prefix))
        });

        let mut deleted_paths = Vec::new();
        next_snapshot.retain(|path, _| {
            if delete_prefixes
                .iter()
                .any(|prefix| path_has_prefix(path, prefix))
            {
                deleted_paths.push(path.clone());
                false
            } else {
                true
            }
        });

        let mut document_changes = deleted_paths
            .into_iter()
            .map(|path| IndexChange {
                path,
                old_path: None,
                kind: "delete".to_string(),
                node_type: Some("file".to_string()),
            })
            .collect::<Vec<_>>();
        document_changes.sort_by(|left, right| left.path.cmp(&right.path));

        for change in changes {
            let normalized = normalize_relative_path(&change.path)?;
            if change.kind != "delete" {
                if let Some(path) = self.path_snapshot_entry(&normalized)? {
                    next_paths.insert(path);
                } else {
                    next_paths.remove(&normalized);
                }
            }
            if change.kind == "delete" || change.node_type.as_deref() == Some("dir") {
                continue;
            }
            if let Some((path, fingerprint)) = self.snapshot_entry(&normalized)? {
                next_snapshot.insert(path.clone(), fingerprint);
                document_changes.push(IndexChange {
                    path,
                    old_path: None,
                    kind: change.kind.clone(),
                    node_type: Some("file".to_string()),
                });
            } else {
                next_snapshot.remove(&normalized);
                document_changes.push(IndexChange {
                    path: normalized,
                    old_path: None,
                    kind: "delete".to_string(),
                    node_type: Some("file".to_string()),
                });
            }
        }
        if document_changes.is_empty() {
            mark_path_snapshot_dirty(&self.index_dir)?;
            self.install_paths(next_paths);
            return Ok(());
        }
        self.apply_document_changes(&document_changes, next_snapshot, false)?;
        mark_path_snapshot_dirty(&self.index_dir)?;
        self.install_paths(next_paths);
        Ok(())
    }

    fn apply_document_changes(
        &self,
        changes: &[IndexChange],
        next_snapshot: HashMap<String, FileFingerprint>,
        persist_snapshot_now: bool,
    ) -> Result<()> {
        if changes.is_empty() {
            return Ok(());
        }

        // Read every replacement before mutating the writer. A transient NAS
        // read failure must not leave an uncommitted delete for a later batch.
        let mut prepared = Vec::with_capacity(changes.len());
        for change in changes {
            let path = normalize_relative_path(&change.path)?;
            let old_path = change
                .old_path
                .as_deref()
                .map(normalize_relative_path)
                .transpose()?;
            let document = if change.kind == "delete" || change.node_type.as_deref() == Some("dir")
            {
                None
            } else {
                self.document_for_relative_path(&path)?
            };
            prepared.push((path, old_path, document));
        }

        let mut writer = self.writer.lock().expect("tantivy writer mutex poisoned");
        for (path, old_path, document) in prepared {
            if let Some(old_path) = old_path.as_deref() {
                if let Err(error) = self.delete_path(&mut writer, old_path) {
                    let _ = writer.rollback();
                    return Err(error);
                }
            }
            if let Err(error) = self.delete_path(&mut writer, &path) {
                let _ = writer.rollback();
                return Err(error);
            }
            if let Some(document) = document {
                if let Err(error) = writer
                    .add_document(document)
                    .context("add changed document")
                {
                    let _ = writer.rollback();
                    return Err(error);
                }
            }
        }
        if let Err(error) = writer.commit().context("commit incremental index") {
            let _ = writer.rollback();
            return Err(error);
        }
        self.reload_reader()?;
        if persist_snapshot_now {
            persist_snapshot(&self.index_dir, &next_snapshot)?;
        } else {
            mark_snapshot_dirty(&self.index_dir)?;
        }
        self.install_snapshot(next_snapshot);
        Ok(())
    }

    fn path_snapshot_entry(&self, relative: &str) -> Result<Option<String>> {
        let normalized = normalize_relative_path(relative)?;
        let absolute = self.workspace.join(&normalized);
        let metadata = match fs::symlink_metadata(&absolute) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(error).with_context(|| format!("stat {}", absolute.display()))
            }
        };
        if !metadata.file_type().is_file()
            && !metadata.file_type().is_dir()
            && !metadata.file_type().is_symlink()
        {
            return Ok(None);
        }
        if is_ignored_path(&normalized, &self.ignore_patterns)
            || is_git_ignored(&self.workspace, &absolute, metadata.is_dir())
        {
            return Ok(None);
        }
        Ok(Some(normalized))
    }

    fn snapshot_entry(&self, relative: &str) -> Result<Option<(String, FileFingerprint)>> {
        let normalized = normalize_relative_path(relative)?;
        let absolute = self.workspace.join(&normalized);
        let metadata = match fs::symlink_metadata(&absolute) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(error).with_context(|| format!("stat {}", absolute.display()))
            }
        };
        if !metadata.file_type().is_file()
            || is_ignored_path(&normalized, &self.ignore_patterns)
            || is_git_ignored(&self.workspace, &absolute, false)
        {
            return Ok(None);
        }
        Ok(Some((normalized, file_fingerprint(&absolute)?)))
    }

    fn delete_path(&self, writer: &mut IndexWriter, relative: &str) -> Result<()> {
        let path = normalize_relative_path(relative)?;
        writer.delete_term(Term::from_field_text(self.path_field, &path));
        Ok(())
    }

    fn document_for_relative_path(&self, relative: &str) -> Result<Option<TantivyDocument>> {
        let relative = normalize_relative_path(relative)?;
        let absolute = self.workspace.join(&relative);
        self.document_for_path(&absolute)
    }

    fn document_for_path(&self, path: &Path) -> Result<Option<TantivyDocument>> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).with_context(|| format!("stat {}", path.display())),
        };
        if !metadata.file_type().is_file() || metadata.len() > MAX_INDEXED_FILE_BYTES {
            return Ok(None);
        }
        let relative = path
            .strip_prefix(&self.workspace)
            .with_context(|| format!("path outside workspace: {}", path.display()))?;
        let relative = normalize_relative_path(&relative.to_string_lossy())?;
        if relative.is_empty()
            || is_ignored_path(&relative, &self.ignore_patterns)
            || is_git_ignored(&self.workspace, path, metadata.is_dir())
        {
            return Ok(None);
        }

        let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
        if bytes.iter().take(8192).any(|byte| *byte == 0) {
            return Ok(None);
        }
        let content = match String::from_utf8(bytes) {
            Ok(content) => content.to_lowercase(),
            Err(_) => return Ok(None),
        };

        let mut document = TantivyDocument::default();
        document.add_text(self.path_field, &relative);
        document.add_text(self.content_field, content);
        Ok(Some(document))
    }

    fn reload_reader(&self) -> Result<()> {
        self.reader
            .lock()
            .expect("tantivy reader mutex poisoned")
            .reload()
            .context("reload tantivy reader")
    }

    fn doc_count(&self) -> u64 {
        self.reader
            .lock()
            .expect("tantivy reader mutex poisoned")
            .searcher()
            .num_docs()
    }

    fn query(&self, request: &QueryRequest) -> Result<QueryResponse> {
        let limit = request.limit.clamp(1, MAX_QUERY_LIMIT);
        let grams = query_grams(&request.literals)?;
        let queries: Vec<Box<dyn Query>> = grams
            .iter()
            .map(|gram| {
                Box::new(TermQuery::new(
                    Term::from_field_text(self.content_field, gram),
                    IndexRecordOption::Basic,
                )) as Box<dyn Query>
            })
            .collect();
        let query: Box<dyn Query> = if queries.len() == 1 {
            queries.into_iter().next().expect("one query")
        } else {
            Box::new(BooleanQuery::intersection(queries))
        };

        let path_prefix = normalize_prefix(&request.path_prefix);
        let glob = request
            .glob
            .as_deref()
            .map(Glob::new)
            .transpose()
            .context("invalid glob")?
            .map(|glob| glob.compile_matcher());
        let candidate_limit = limit.saturating_mul(8).clamp(limit + 1, 10_000);
        let searcher = self
            .reader
            .lock()
            .expect("tantivy reader mutex poisoned")
            .searcher();
        let mut offset = 0usize;
        let mut inspected = 0usize;
        let mut matches = Vec::with_capacity(limit);
        let mut exhausted = false;
        let mut reached_limit = false;
        while matches.len() < limit && !exhausted {
            let page = searcher
                .search(
                    query.as_ref(),
                    &TopDocs::with_limit(candidate_limit).and_offset(offset),
                )
                .context("query tantivy index")?;
            if page.is_empty() {
                exhausted = true;
                break;
            }
            inspected += page.len();
            for (_, address) in &page {
                let document: TantivyDocument =
                    searcher.doc(*address).context("read tantivy document")?;
                let Some(path) = document
                    .get_first(self.path_field)
                    .and_then(|value| value.as_str())
                else {
                    continue;
                };
                if path_prefix
                    .as_deref()
                    .is_some_and(|prefix| !path_has_prefix(path, prefix))
                {
                    continue;
                }
                if glob.as_ref().is_some_and(|matcher| !matcher.is_match(path)) {
                    continue;
                }
                matches.push(path.to_string());
                if matches.len() >= limit {
                    reached_limit = true;
                    break;
                }
            }
            offset += page.len();
            if page.len() < candidate_limit {
                exhausted = true;
            }
        }

        Ok(QueryResponse {
            matches,
            truncated: reached_limit || (!exhausted && inspected >= candidate_limit),
            state: "ready".to_string(),
            index_family: self.manifest.family.clone(),
            schema_version: self.manifest.schema_version,
            coverage: self.coverage().to_string(),
        })
    }
}

fn build_schema() -> Schema {
    let mut builder = Schema::builder();
    builder.add_text_field("path", STRING | STORED);
    let indexing = TextFieldIndexing::default()
        .set_tokenizer("trigram")
        .set_index_option(IndexRecordOption::Basic);
    let content = TextOptions::default().set_indexing_options(indexing);
    builder.add_text_field("content", content);
    builder.build()
}

fn validate_schema(schema: &Schema) -> Result<()> {
    let version = schema.get_field("path").is_ok() && schema.get_field("content").is_ok();
    if !version {
        return Err(anyhow!("unsupported index schema"));
    }
    Ok(())
}

fn register_tokenizer(index: &Index) -> Result<()> {
    let tokenizer = NgramTokenizer::new(3, 3, false).context("create trigram tokenizer")?;
    index
        .tokenizers()
        .register("trigram", TextAnalyzer::builder(tokenizer).build());
    Ok(())
}

fn query_grams(literals: &[String]) -> Result<Vec<String>> {
    let mut grams = HashSet::new();
    for literal in literals {
        let value = literal.trim().to_lowercase();
        let chars: Vec<char> = value.chars().collect();
        if chars.len() < 3 {
            return Err(anyhow!(
                "search literals must contain at least 3 characters"
            ));
        }
        for window in chars.windows(3) {
            grams.insert(window.iter().collect::<String>());
        }
    }
    if grams.is_empty() {
        return Err(anyhow!("at least one search literal is required"));
    }
    let mut grams: Vec<String> = grams.into_iter().collect();
    grams.sort();
    Ok(grams)
}

fn is_ignored_directory(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            matches!(
                name,
                ".git"
                    | ".hg"
                    | ".svn"
                    | "node_modules"
                    | ".pnpm-store"
                    | ".yarn"
                    | ".bun"
                    | "vendor"
                    | "dist"
                    | "build"
                    | "out"
                    | "target"
                    | ".next"
                    | ".nuxt"
                    | ".svelte-kit"
                    | ".vite"
                    | ".vercel"
                    | ".output"
                    | "coverage"
                    | ".cache"
                    | ".turbo"
                    | ".parcel-cache"
                    | ".rollup.cache"
                    | ".pytest_cache"
                    | "__pycache__"
                    | ".mypy_cache"
                    | ".ruff_cache"
                    | "tmp"
                    | "temp"
                    | ".tmp"
            )
        })
}

fn normalize_ignore_patterns(patterns: Vec<String>) -> Vec<String> {
    let mut normalized = patterns
        .into_iter()
        .map(|pattern| {
            pattern
                .replace('\\', "/")
                .trim_matches('/')
                .trim()
                .to_string()
        })
        .filter(|pattern| {
            !pattern.is_empty() && !Path::new(pattern).is_absolute() && !pattern.contains("..")
        })
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    normalized
}

fn path_matches_ignore_pattern(path: &str, pattern: &str) -> bool {
    if pattern.contains('/') {
        path_has_prefix(path, pattern)
    } else {
        path.split('/').any(|segment| segment == pattern)
    }
}

fn is_ignored_path(path: &str, ignore_patterns: &[String]) -> bool {
    path.split('/')
        .any(|segment| is_ignored_directory(Path::new(segment)))
        || ignore_patterns
            .iter()
            .any(|pattern| path_matches_ignore_pattern(path, pattern))
}

fn path_matches_ignore_globs(path: &str, matchers: &[globset::GlobMatcher]) -> bool {
    if matchers.is_empty() {
        return false;
    }
    let basename = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path);
    matchers.iter().any(|matcher| {
        matcher.is_match(path)
            || matcher.is_match(basename)
            || path.split('/').any(|segment| matcher.is_match(segment))
    })
}

fn is_ignored_workspace_path(workspace: &Path, path: &Path, ignore_patterns: &[String]) -> bool {
    let Ok(relative) = path.strip_prefix(workspace) else {
        return true;
    };
    let relative = relative.to_string_lossy().replace('\\', "/");
    !relative.is_empty() && is_ignored_path(&relative, ignore_patterns)
}

fn path_has_prefix(path: &str, prefix: &str) -> bool {
    if prefix.is_empty() {
        return true;
    }
    path == prefix
        || (path.len() > prefix.len()
            && path.as_bytes()[prefix.len()] == b'/'
            && path.starts_with(prefix))
}

fn compact_path_prefixes(prefixes: HashSet<String>) -> Vec<String> {
    let mut prefixes = prefixes.into_iter().collect::<Vec<_>>();
    prefixes.sort();
    let mut compact = Vec::with_capacity(prefixes.len());
    for prefix in prefixes {
        if compact
            .iter()
            .any(|kept: &String| path_has_prefix(&prefix, kept))
        {
            continue;
        }
        compact.push(prefix);
    }
    compact
}

// Incremental updates do not pass through ignore::WalkBuilder, so evaluate the
// applicable .gitignore files explicitly before re-adding a changed file.
fn is_git_ignored(workspace: &Path, path: &Path, is_dir: bool) -> bool {
    let mut directories = Vec::new();
    let mut current = path.parent();
    while let Some(directory) = current {
        if !directory.starts_with(workspace) {
            break;
        }
        directories.push(directory.to_path_buf());
        if directory == workspace {
            break;
        }
        current = directory.parent();
    }
    directories.reverse();

    let mut ignored = false;
    for directory in directories {
        let ignore_file = directory.join(".gitignore");
        if !ignore_file.is_file() {
            continue;
        }
        let mut builder = GitignoreBuilder::new(&directory);
        if builder.add(&ignore_file).is_some() {
            continue;
        }
        let Ok(matcher) = builder.build() else {
            continue;
        };
        let matched = matcher.matched_path_or_any_parents(path, is_dir);
        if matched.is_ignore() {
            ignored = true;
        } else if matched.is_whitelist() {
            ignored = false;
        }
    }
    ignored
}

fn normalize_relative_path(path: &str) -> Result<String> {
    let normalized = path.replace('\\', "/");
    if Path::new(&normalized).is_absolute() {
        return Err(anyhow!("path must stay inside the workspace: {path}"));
    }
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(anyhow!("path must stay inside the workspace: {path}")),
            value => parts.push(value),
        }
    }
    if parts.is_empty() {
        return Err(anyhow!("path must name a workspace file"));
    }
    Ok(parts.join("/"))
}

fn normalize_prefix(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/").trim_matches('/').to_string();
    if normalized.is_empty() || normalized == "." {
        None
    } else {
        Some(normalized)
    }
}

fn read_changes(path: Option<PathBuf>) -> Result<Vec<IndexChange>> {
    let input = match path {
        Some(path) => {
            fs::read_to_string(&path).with_context(|| format!("read changes {}", path.display()))?
        }
        None => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .context("read changes from stdin")?;
            input
        }
    };
    input
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).context("parse change JSON"))
        .collect()
}

fn print_status(store: &IndexStore) -> Result<()> {
    let status = IndexStatus::ready(store);
    println!("{}", serde_json::to_string_pretty(&status)?);
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn full_and_incremental_queries_follow_workspace_changes() {
        let workspace = TempDir::new().expect("workspace tempdir");
        let index = TempDir::new().expect("index tempdir");
        let source = workspace.path().join("src");
        fs::create_dir_all(&source).expect("source directory");
        fs::write(source.join("main.ts"), "const needle = true;\n").expect("initial file");
        fs::write(workspace.path().join("README.md"), "nothing here\n").expect("readme");

        let store = IndexStore::open(workspace.path(), index.path()).expect("open store");
        store.full_rebuild().expect("full rebuild");
        let result = store
            .query(&QueryRequest {
                literals: vec!["needle".to_string()],
                path_prefix: "src".to_string(),
                glob: Some("*.ts".to_string()),
                limit: 10,
            })
            .expect("query initial index");
        assert_eq!(result.matches, vec!["src/main.ts"]);

        fs::write(source.join("main.ts"), "const changed = true;\n").expect("changed file");
        store
            .apply_changes(&[IndexChange {
                path: "src/main.ts".to_string(),
                old_path: None,
                kind: "modify".to_string(),
                node_type: Some("file".to_string()),
            }])
            .expect("incremental update");

        let result = store
            .query(&QueryRequest {
                literals: vec!["needle".to_string()],
                path_prefix: String::new(),
                glob: None,
                limit: 10,
            })
            .expect("query removed term");
        assert!(result.matches.is_empty());
        let result = store
            .query(&QueryRequest {
                literals: vec!["changed".to_string()],
                path_prefix: String::new(),
                glob: None,
                limit: 10,
            })
            .expect("query new term");
        assert_eq!(result.matches, vec!["src/main.ts"]);
        assert!(snapshot_dirty_path(index.path()).exists());
        // The live index is current; only the on-disk snapshot lags. Coverage
        // must not report stale for the rest of the session.
        assert_eq!(store.coverage(), "complete");
        store.reconcile().expect("persist reconciled snapshot");
        assert!(!snapshot_dirty_path(index.path()).exists());
    }

    #[test]
    fn reopened_store_beside_dirty_marker_is_stale_until_reconciled() {
        let workspace = TempDir::new().expect("workspace tempdir");
        let index = TempDir::new().expect("index tempdir");
        fs::write(workspace.path().join("a.txt"), "needle one\n").expect("file");

        {
            let store = IndexStore::open(workspace.path(), index.path()).expect("open store");
            store.full_rebuild().expect("full rebuild");
            fs::write(workspace.path().join("a.txt"), "needle two\n").expect("changed file");
            store
                .apply_changes(&[IndexChange {
                    path: "a.txt".to_string(),
                    old_path: None,
                    kind: "modify".to_string(),
                    node_type: Some("file".to_string()),
                }])
                .expect("incremental update");
            assert!(snapshot_dirty_path(index.path()).exists());
        }

        // Simulates a restart: files.json predates the last commit, so the
        // loaded snapshot cannot be trusted until reconcile verifies it.
        let store = IndexStore::open(workspace.path(), index.path()).expect("reopen store");
        assert_eq!(store.coverage(), "stale");
        store.reconcile().expect("reconcile");
        assert_eq!(store.coverage(), "complete");
        assert!(!snapshot_dirty_path(index.path()).exists());
    }

    #[test]
    fn reconcile_updates_only_files_changed_since_the_last_snapshot() {
        let workspace = TempDir::new().expect("workspace tempdir");
        let index = TempDir::new().expect("index tempdir");
        fs::write(workspace.path().join("stable.txt"), "stable needle\n").expect("stable file");
        fs::write(workspace.path().join("changed.txt"), "old needle\n").expect("changed file");

        let store = IndexStore::open(workspace.path(), index.path()).expect("open store");
        store.full_rebuild().expect("full rebuild");
        assert_eq!(store.coverage(), "complete");

        fs::write(workspace.path().join("changed.txt"), "new needle\n").expect("changed content");
        fs::remove_file(workspace.path().join("stable.txt")).expect("removed file");
        fs::write(workspace.path().join("created.txt"), "created needle\n").expect("created file");
        store.reconcile().expect("reconcile workspace");

        let result = store
            .query(&QueryRequest {
                literals: vec!["new".to_string()],
                path_prefix: String::new(),
                glob: None,
                limit: 10,
            })
            .expect("query changed file");
        assert_eq!(result.matches, vec!["changed.txt"]);
        let result = store
            .query(&QueryRequest {
                literals: vec!["created".to_string()],
                path_prefix: String::new(),
                glob: None,
                limit: 10,
            })
            .expect("query created file");
        assert_eq!(result.matches, vec!["created.txt"]);
        let result = store
            .query(&QueryRequest {
                literals: vec!["stable".to_string()],
                path_prefix: String::new(),
                glob: None,
                limit: 10,
            })
            .expect("query removed file");
        assert!(result.matches.is_empty());
    }

    #[test]
    fn query_filters_candidates_across_pages_without_missing_matches() {
        let workspace = TempDir::new().expect("workspace tempdir");
        let index = TempDir::new().expect("index tempdir");
        let other = workspace.path().join("a-other");
        let target = workspace.path().join("z-target");
        fs::create_dir_all(&other).expect("other directory");
        fs::create_dir_all(&target).expect("target directory");
        for number in 0..20 {
            fs::write(other.join(format!("file-{number}.txt")), "common needle\n")
                .expect("other file");
        }
        fs::write(target.join("result.txt"), "common needle\n").expect("target file");

        let store = IndexStore::open(workspace.path(), index.path()).expect("open store");
        store.full_rebuild().expect("full rebuild");
        let result = store
            .query(&QueryRequest {
                literals: vec!["common".to_string()],
                path_prefix: "z-target".to_string(),
                glob: Some("*.txt".to_string()),
                limit: 1,
            })
            .expect("query target directory");
        assert_eq!(result.matches, vec!["z-target/result.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn socket_parent_permissions_are_not_changed_for_existing_directories() {
        use std::os::unix::fs::PermissionsExt;

        let root = TempDir::new().expect("socket root");
        let parent = root.path().join("shared");
        fs::create_dir(&parent).expect("shared directory");
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o755))
            .expect("shared permissions");
        let result = ensure_socket_directory(&parent);
        assert!(result.is_err());
        assert_eq!(
            fs::metadata(&parent).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[cfg(unix)]
    #[test]
    fn socket_parent_permissions_are_private_for_new_directories() {
        let root = TempDir::new().expect("socket root");
        let parent = root.path().join("private");
        ensure_socket_directory(&parent).expect("private directory");
        assert_eq!(
            fs::metadata(&parent).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[cfg(unix)]
    #[test]
    fn socket_parent_creates_nested_private_directory() {
        let root = TempDir::new().expect("socket root");
        let parent = root.path().join("run").join("cohub-search");
        ensure_socket_directory(&parent).expect("nested private directory");
        assert_eq!(
            fs::metadata(&parent).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[test]
    fn only_explicit_index_corruption_is_quarantined() {
        assert!(should_quarantine_index(&anyhow!("parse manifest failed")));
        assert!(should_quarantine_index(&anyhow!(
            "unsupported search index manifest"
        )));
        assert!(!should_quarantine_index(&anyhow!("permission denied")));
        assert!(!should_quarantine_index(&anyhow!(
            "Failed to acquire Lockfile: LockBusy"
        )));
    }

    #[test]
    fn serve_quarantines_invalid_index_without_deleting_it() {
        let workspace = TempDir::new().expect("workspace tempdir");
        let index = TempDir::new().expect("index tempdir");
        let marker = index.path().join("meta.json");
        fs::write(&marker, "not a tantivy index").expect("invalid index");

        let store = open_store_for_serve(workspace.path(), index.path(), Vec::new())
            .expect("recover index");
        assert_eq!(store.doc_count(), 0);
        let quarantined = fs::read_dir(index.path())
            .expect("read recovered index")
            .filter_map(Result::ok)
            .find(|entry| entry.file_name().to_string_lossy().starts_with(".corrupt-"))
            .expect("quarantine directory");
        assert_eq!(
            fs::read_to_string(quarantined.path().join("meta.json")).unwrap(),
            "not a tantivy index"
        );
    }

    #[test]
    fn directory_delete_removes_indexed_descendants_without_reconcile() {
        let workspace = TempDir::new().expect("workspace tempdir");
        let index = TempDir::new().expect("index tempdir");
        let source = workspace.path().join("src").join("nested");
        fs::create_dir_all(&source).expect("source directory");
        fs::write(source.join("one.txt"), "deleted needle\n").expect("first file");
        fs::write(source.join("two.txt"), "deleted needle\n").expect("second file");

        let store = IndexStore::open(workspace.path(), index.path()).expect("open store");
        store.full_rebuild().expect("full rebuild");
        fs::remove_dir_all(workspace.path().join("src")).expect("remove source directory");
        store
            .apply_changes(&[IndexChange {
                path: "src".to_string(),
                old_path: None,
                kind: "delete".to_string(),
                node_type: Some("unknown".to_string()),
            }])
            .expect("apply directory delete");

        let result = store
            .query(&QueryRequest {
                literals: vec!["needle".to_string()],
                path_prefix: String::new(),
                glob: None,
                limit: 10,
            })
            .expect("query deleted directory");
        assert!(result.matches.is_empty());
    }

    #[test]
    fn directory_rename_replaces_old_prefix_without_reconcile() {
        let workspace = TempDir::new().expect("workspace tempdir");
        let index = TempDir::new().expect("index tempdir");
        let old = workspace.path().join("old");
        fs::create_dir(&old).expect("old directory");
        fs::write(old.join("file.txt"), "renamed needle\n").expect("old file");

        let store = IndexStore::open(workspace.path(), index.path()).expect("open store");
        store.full_rebuild().expect("full rebuild");
        fs::rename(&old, workspace.path().join("new")).expect("rename directory");
        store
            .apply_changes(&[
                IndexChange {
                    path: "old".to_string(),
                    old_path: None,
                    kind: "delete".to_string(),
                    node_type: Some("unknown".to_string()),
                },
                IndexChange {
                    path: "new/file.txt".to_string(),
                    old_path: None,
                    kind: "create".to_string(),
                    node_type: Some("file".to_string()),
                },
            ])
            .expect("apply directory rename");

        let result = store
            .query(&QueryRequest {
                literals: vec!["needle".to_string()],
                path_prefix: String::new(),
                glob: None,
                limit: 10,
            })
            .expect("query renamed directory");
        assert_eq!(result.matches, vec!["new/file.txt"]);
    }

    #[test]
    fn same_path_directory_replacement_keeps_new_snapshot_entries() {
        let workspace = TempDir::new().expect("workspace tempdir");
        let index = TempDir::new().expect("index tempdir");
        let source = workspace.path().join("src");
        fs::create_dir(&source).expect("source directory");
        fs::write(source.join("file.txt"), "before needle\n").expect("old file");

        let store = IndexStore::open(workspace.path(), index.path()).expect("open store");
        store.full_rebuild().expect("full rebuild");
        fs::remove_dir_all(&source).expect("remove source directory");
        fs::create_dir(&source).expect("recreate source directory");
        fs::write(source.join("file.txt"), "after needle\n").expect("new file");
        store
            .apply_changes(&[
                IndexChange {
                    path: "src".to_string(),
                    old_path: None,
                    kind: "delete".to_string(),
                    node_type: Some("unknown".to_string()),
                },
                IndexChange {
                    path: "src/file.txt".to_string(),
                    old_path: None,
                    kind: "create".to_string(),
                    node_type: Some("file".to_string()),
                },
            ])
            .expect("apply directory replacement");

        let snapshot = store.snapshot.lock().expect("file snapshot mutex poisoned");
        assert!(snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.contains_key("src/file.txt")));
        drop(snapshot);
        let result = store
            .query(&QueryRequest {
                literals: vec!["after".to_string()],
                path_prefix: String::new(),
                glob: None,
                limit: 10,
            })
            .expect("query replacement");
        assert_eq!(result.matches, vec!["src/file.txt"]);
    }

    #[test]
    fn configured_ignore_patterns_apply_to_full_and_incremental_indexing() {
        let workspace = TempDir::new().expect("workspace tempdir");
        let index = TempDir::new().expect("index tempdir");
        let ignored = workspace.path().join("custom").join("cache");
        fs::create_dir_all(&ignored).expect("ignored directory");
        fs::write(ignored.join("secret.txt"), "private needle\n").expect("ignored file");
        fs::write(workspace.path().join("visible.txt"), "visible needle\n").expect("visible file");

        let store = IndexStore::open_with_ignores(
            workspace.path(),
            index.path(),
            vec!["custom/cache".to_string()],
        )
        .expect("open store");
        store.full_rebuild().expect("full rebuild");
        let result = store
            .query(&QueryRequest {
                literals: vec!["needle".to_string()],
                path_prefix: String::new(),
                glob: None,
                limit: 10,
            })
            .expect("query ignored path");
        assert_eq!(result.matches, vec!["visible.txt"]);

        fs::write(ignored.join("secret.txt"), "changed needle\n").expect("change ignored file");
        store
            .apply_changes(&[IndexChange {
                path: "custom/cache/secret.txt".to_string(),
                old_path: None,
                kind: "modify".to_string(),
                node_type: Some("file".to_string()),
            }])
            .expect("apply ignored update");
        assert_eq!(store.doc_count(), 1);
    }

    #[test]
    fn incremental_updates_respect_gitignore_rules() {
        let workspace = TempDir::new().expect("workspace tempdir");
        let index = TempDir::new().expect("index tempdir");
        fs::write(workspace.path().join(".gitignore"), "ignored.txt\n").expect("gitignore");
        fs::write(workspace.path().join("ignored.txt"), "secret needle\n").expect("ignored file");
        fs::write(workspace.path().join("visible.txt"), "visible needle\n").expect("visible file");

        let store = IndexStore::open(workspace.path(), index.path()).expect("open store");
        store.full_rebuild().expect("full rebuild");
        let result = store
            .query(&QueryRequest {
                literals: vec!["needle".to_string()],
                path_prefix: String::new(),
                glob: None,
                limit: 10,
            })
            .expect("query ignored file");
        assert_eq!(result.matches, vec!["visible.txt"]);

        fs::write(workspace.path().join("ignored.txt"), "new needle\n")
            .expect("changed ignored file");
        store
            .apply_changes(&[IndexChange {
                path: "ignored.txt".to_string(),
                old_path: None,
                kind: "modify".to_string(),
                node_type: Some("file".to_string()),
            }])
            .expect("incremental ignored update");
        let result = store
            .query(&QueryRequest {
                literals: vec!["new".to_string()],
                path_prefix: String::new(),
                glob: None,
                limit: 10,
            })
            .expect("query ignored update");
        assert!(result.matches.is_empty());

        fs::write(workspace.path().join(".gitignore"), "").expect("clear gitignore");
        store
            .apply_changes(&[IndexChange {
                path: ".gitignore".to_string(),
                old_path: None,
                kind: "modify".to_string(),
                node_type: Some("file".to_string()),
            }])
            .expect("rebuild after gitignore change");
        assert!(!is_git_ignored(
            workspace.path(),
            &workspace.path().join("ignored.txt"),
            false
        ));
        assert_eq!(store.doc_count(), 3);
        let result = store
            .query(&QueryRequest {
                literals: vec!["new".to_string()],
                path_prefix: String::new(),
                glob: None,
                limit: 10,
            })
            .expect("query newly visible file");
        assert_eq!(result.matches, vec!["ignored.txt"]);
    }

    #[test]
    fn path_query_matches_files_and_directories_with_fd_style_globs() {
        let workspace = TempDir::new().expect("workspace tempdir");
        let index = TempDir::new().expect("index tempdir");
        fs::create_dir_all(workspace.path().join("src/nested")).expect("source directory");
        fs::write(workspace.path().join("src/main.ts"), "main").expect("main file");
        fs::write(workspace.path().join("src/nested/child.ts"), "child").expect("child file");
        fs::write(workspace.path().join("README.md"), "readme").expect("readme");

        let store = IndexStore::open(workspace.path(), index.path()).expect("open store");
        store.full_rebuild().expect("full rebuild");

        let result = store
            .path_query(&PathQueryRequest {
                pattern: "*.ts".to_string(),
                path_prefix: String::new(),
                full_path: false,
                ignore: Vec::new(),
                limit: 10,
            })
            .expect("basename path query");
        assert_eq!(result.matches, vec!["src/main.ts", "src/nested/child.ts"]);

        let result = store
            .path_query(&PathQueryRequest {
                pattern: "readme.md".to_string(),
                path_prefix: String::new(),
                full_path: false,
                ignore: Vec::new(),
                limit: 10,
            })
            .expect("smart-case path query");
        assert_eq!(result.matches, vec!["README.md"]);

        let result = store
            .path_query(&PathQueryRequest {
                pattern: "**/src/*.ts".to_string(),
                path_prefix: String::new(),
                full_path: true,
                ignore: Vec::new(),
                limit: 10,
            })
            .expect("full path query");
        assert_eq!(result.matches, vec!["src/main.ts"]);

        let result = store
            .path_query(&PathQueryRequest {
                pattern: "*".to_string(),
                path_prefix: "src".to_string(),
                full_path: false,
                ignore: vec!["nested".to_string()],
                limit: 10,
            })
            .expect("scoped path query");
        assert_eq!(result.matches, vec!["src/main.ts"]);
    }

    #[test]
    fn path_query_updates_incrementally_and_reports_truncation() {
        let workspace = TempDir::new().expect("workspace tempdir");
        let index = TempDir::new().expect("index tempdir");
        fs::write(workspace.path().join("one.ts"), "one").expect("first file");

        let store = IndexStore::open(workspace.path(), index.path()).expect("open store");
        store.full_rebuild().expect("full rebuild");
        fs::write(workspace.path().join("two.ts"), "two").expect("second file");
        fs::create_dir(workspace.path().join("new-dir")).expect("new directory");
        store
            .apply_changes(&[
                IndexChange {
                    path: "two.ts".to_string(),
                    old_path: None,
                    kind: "create".to_string(),
                    node_type: Some("file".to_string()),
                },
                IndexChange {
                    path: "new-dir".to_string(),
                    old_path: None,
                    kind: "create".to_string(),
                    node_type: Some("dir".to_string()),
                },
            ])
            .expect("incremental update");

        let directory_result = store
            .path_query(&PathQueryRequest {
                pattern: "new-dir".to_string(),
                path_prefix: String::new(),
                full_path: false,
                ignore: Vec::new(),
                limit: 10,
            })
            .expect("directory path query");
        assert_eq!(directory_result.matches, vec!["new-dir"]);

        let result = store
            .path_query(&PathQueryRequest {
                pattern: "*.ts".to_string(),
                path_prefix: String::new(),
                full_path: false,
                ignore: Vec::new(),
                limit: 1,
            })
            .expect("path query");
        assert_eq!(result.matches, vec!["one.ts"]);
        assert!(result.truncated);
        assert_eq!(store.path_coverage(), "complete");
    }

    #[test]
    fn path_prefix_matches_do_not_treat_partial_names_as_children() {
        assert!(path_has_prefix("src/main.ts", "src"));
        assert!(path_has_prefix("src", "src"));
        assert!(!path_has_prefix("srcfoo/main.ts", "src"));
        assert!(!path_has_prefix("src", "src/main.ts"));
    }

    #[test]
    fn compact_path_prefixes_drops_paths_covered_by_a_parent() {
        let compact = compact_path_prefixes(HashSet::from([
            "src".to_string(),
            "src/nested".to_string(),
            "lib".to_string(),
        ]));
        assert_eq!(compact, vec!["lib", "src"]);
    }
}
