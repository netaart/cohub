mod content;
mod pattern;
mod socket;
mod store;
mod walk;

use anyhow::{anyhow, Context, Result};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use clap::{Args, Parser, Subcommand};
use hyper::server::conn::http1;
use hyper_util::{rt::TokioIo, service::TowerToHyperService};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use store::{
    open_store_for_serve, Fallback, IndexChange, IndexStore, PathOutcome, PathQueryRequest,
    QueryOutcome, QueryPlan, QueryRequest, INDEX_FAMILY, PATH_INDEX_FAMILY,
};
use tokio::{net::UnixListener, sync::mpsc, time::sleep};

/// Version of the HTTP query contract. The sandbox refuses to serve index
/// queries from a binary that reports a different version.
const API_VERSION: u32 = 2;
const UPDATE_DEBOUNCE: Duration = Duration::from_millis(500);
const INDEX_RETRY_DELAY: Duration = Duration::from_secs(5);
const DEFAULT_QUERY_LIMIT: usize = 1000;

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
    #[arg(long)]
    pattern: String,
    #[arg(long)]
    fixed_strings: bool,
    #[arg(long)]
    ignore_case: bool,
    #[arg(long, default_value = "")]
    path_prefix: String,
    #[arg(long)]
    glob: Option<String>,
    #[arg(long, default_value_t = DEFAULT_QUERY_LIMIT)]
    limit: usize,
}

/// Accepted work is numbered and jobs run in acceptance order, so coverage is
/// complete only once the newest accepted job has run. A failed job leaves the
/// index behind the workspace until a later rescan succeeds.
#[derive(Default)]
struct Progress {
    received: AtomicU64,
    applied: AtomicU64,
    needs_rescan: AtomicBool,
}

impl Progress {
    fn accept(&self) -> u64 {
        self.received.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn complete(&self, seq: u64) {
        self.applied.fetch_max(seq, Ordering::SeqCst);
    }

    fn pending(&self) -> u64 {
        let applied = self.applied.load(Ordering::SeqCst);
        self.received.load(Ordering::SeqCst).saturating_sub(applied)
    }
}

#[derive(Clone)]
struct AppState {
    store: Arc<IndexStore>,
    jobs: Submitter,
    progress: Arc<Progress>,
    worker: Arc<Mutex<WorkerStatus>>,
    retry_scheduled: Arc<AtomicBool>,
}

/// Numbers and enqueues jobs under one lock so the worker receives them in
/// sequence order; completing a job then covers every earlier one.
#[derive(Clone)]
struct Submitter {
    sender: mpsc::Sender<Job>,
    progress: Arc<Progress>,
    order: Arc<tokio::sync::Mutex<()>>,
}

impl Submitter {
    async fn submit(&self, job: impl FnOnce(u64) -> Job) -> Result<(), ApiError> {
        let _order = self.order.lock().await;
        let seq = self.progress.accept();
        self.sender.send(job(seq)).await.map_err(|_| {
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "index worker is stopped".to_string(),
            )
        })
    }
}

#[derive(Debug, Clone)]
struct WorkerStatus {
    state: &'static str,
    last_commit_at: Option<u64>,
    last_error: Option<String>,
}

enum Job {
    Full(u64),
    Reconcile(u64),
    Update(Vec<IndexChange>, u64),
}

enum Work {
    Full,
    Reconcile,
    Update(Vec<IndexChange>),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexStatus {
    api_version: u32,
    family: String,
    generation: String,
    schema_version: u32,
    analyzer_version: String,
    state: &'static str,
    coverage: &'static str,
    document_count: u64,
    pending_jobs: u64,
    last_commit_at: Option<u64>,
    last_error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateRequest {
    changes: Vec<IndexChange>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    fallback: Option<Fallback>,
    #[serde(flatten)]
    plan: QueryPlan,
    state: &'static str,
    coverage: &'static str,
    index_family: &'static str,
    schema_version: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PathQueryResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    fallback: Option<Fallback>,
    matches: Vec<String>,
    truncated: bool,
    dirs: Vec<String>,
    state: &'static str,
    coverage: &'static str,
    index_family: &'static str,
    schema_version: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    ok: bool,
    api_version: u32,
}

#[derive(Debug, Serialize)]
struct AcceptedResponse {
    accepted: bool,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Debug)]
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
            let store = IndexStore::open(&args.workspace, &args.index, args.ignore_patterns)?;
            store.full_rebuild()?;
            print_json(&cli_status(&store))
        }
        Command::Update(args) => {
            let store = IndexStore::open(
                &args.index.workspace,
                &args.index.index,
                args.index.ignore_patterns,
            )?;
            store.apply_changes(&read_changes(args.changes)?)?;
            print_json(&cli_status(&store))
        }
        Command::Query(args) => {
            let store = IndexStore::open(
                &args.index.workspace,
                &args.index.index,
                args.index.ignore_patterns,
            )?;
            store.reconcile()?;
            let outcome = store.query(&QueryRequest {
                pattern: args.pattern,
                fixed_strings: args.fixed_strings,
                case_insensitive: args.ignore_case,
                path_prefix: args.path_prefix,
                glob: args.glob,
                limit: args.limit,
            })?;
            print_json(&query_response(
                outcome,
                "ready",
                "complete",
                store.manifest.schema_version,
            ))
        }
        Command::Status(args) => {
            let store = IndexStore::open(&args.workspace, &args.index, args.ignore_patterns)?;
            print_json(&cli_status(&store))
        }
    }
}

async fn serve(args: ServeArgs) -> Result<()> {
    if let Some(parent) = args.socket.parent() {
        socket::ensure_socket_directory(parent)?;
    }
    socket::remove_stale_socket(&args.socket)?;

    let store = Arc::new(open_store_for_serve(
        &args.index.workspace,
        &args.index.index,
        args.index.ignore_patterns,
    )?);
    let (sender, receiver) = mpsc::channel(64);
    let progress = Arc::new(Progress::default());
    let state = AppState {
        store,
        jobs: Submitter {
            sender,
            progress: progress.clone(),
            order: Arc::new(tokio::sync::Mutex::new(())),
        },
        progress,
        worker: Arc::new(Mutex::new(WorkerStatus {
            state: "ready",
            last_commit_at: None,
            last_error: None,
        })),
        retry_scheduled: Arc::new(AtomicBool::new(false)),
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
    socket::secure_socket(&args.socket)?;
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

async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        api_version: API_VERSION,
    })
}

async fn status_handler(State(state): State<AppState>) -> Json<IndexStatus> {
    Json(status_snapshot(&state))
}

async fn full_handler(
    State(state): State<AppState>,
) -> Result<(StatusCode, Json<AcceptedResponse>), ApiError> {
    state.jobs.submit(Job::Full).await?;
    Ok(accepted())
}

async fn reconcile_handler(
    State(state): State<AppState>,
) -> Result<(StatusCode, Json<AcceptedResponse>), ApiError> {
    state.jobs.submit(Job::Reconcile).await?;
    Ok(accepted())
}

async fn update_handler(
    State(state): State<AppState>,
    Json(request): Json<UpdateRequest>,
) -> Result<(StatusCode, Json<AcceptedResponse>), ApiError> {
    if !request.changes.is_empty() {
        let changes = request.changes;
        state
            .jobs
            .submit(move |seq| Job::Update(changes, seq))
            .await?;
    }
    Ok(accepted())
}

fn accepted() -> (StatusCode, Json<AcceptedResponse>) {
    (
        StatusCode::ACCEPTED,
        Json(AcceptedResponse { accepted: true }),
    )
}

async fn query_handler(
    State(state): State<AppState>,
    Json(request): Json<QueryRequest>,
) -> Result<Json<QueryResponse>, ApiError> {
    let status = status_snapshot(&state);
    let outcome = match coverage_fallback(status.coverage) {
        Some(fallback) => QueryOutcome::Fallback(fallback),
        None => {
            let store = state.store.clone();
            tokio::task::spawn_blocking(move || store.query(&request))
                .await
                .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
                .map_err(|error| ApiError(StatusCode::BAD_REQUEST, error.to_string()))?
        }
    };
    Ok(Json(query_response(
        outcome,
        status.state,
        status.coverage,
        status.schema_version,
    )))
}

async fn path_query_handler(
    State(state): State<AppState>,
    Json(request): Json<PathQueryRequest>,
) -> Result<Json<PathQueryResponse>, ApiError> {
    let status = status_snapshot(&state);
    let outcome = match coverage_fallback(status.coverage) {
        Some(fallback) => PathOutcome::Fallback(fallback),
        None => {
            let store = state.store.clone();
            tokio::task::spawn_blocking(move || store.path_query(&request))
                .await
                .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
                .map_err(|error| ApiError(StatusCode::BAD_REQUEST, error.to_string()))?
        }
    };
    let (fallback, matches, truncated, dirs) = match outcome {
        PathOutcome::Fallback(fallback) => (Some(fallback), Vec::new(), false, Vec::new()),
        PathOutcome::Matches {
            matches,
            truncated,
            dirs,
        } => (None, matches, truncated, dirs),
    };
    Ok(Json(PathQueryResponse {
        fallback,
        matches,
        truncated,
        dirs,
        state: status.state,
        coverage: status.coverage,
        index_family: PATH_INDEX_FAMILY,
        schema_version: status.schema_version,
    }))
}

fn coverage_fallback(coverage: &str) -> Option<Fallback> {
    match coverage {
        "complete" => None,
        "stale" => Some(Fallback::Stale),
        _ => Some(Fallback::Partial),
    }
}

fn query_response(
    outcome: QueryOutcome,
    state: &'static str,
    coverage: &'static str,
    schema_version: u32,
) -> QueryResponse {
    let (fallback, plan) = match outcome {
        QueryOutcome::Fallback(fallback) => (Some(fallback), QueryPlan::default()),
        QueryOutcome::Plan(plan) => (None, plan),
    };
    QueryResponse {
        fallback,
        plan,
        state,
        coverage,
        index_family: INDEX_FAMILY,
        schema_version,
    }
}

async fn index_worker(mut receiver: mpsc::Receiver<Job>, state: AppState) {
    while let Some(job) = receiver.recv().await {
        match job {
            Job::Full(seq) => run(&state, Work::Full, seq).await,
            Job::Reconcile(seq) => {
                // A reconcile rescans everything, so queued jobs fold into it.
                let mut last = seq;
                let mut full = false;
                while let Ok(next) = receiver.try_recv() {
                    let (next_seq, next_full) = match next {
                        Job::Full(seq) => (seq, true),
                        Job::Reconcile(seq) | Job::Update(_, seq) => (seq, false),
                    };
                    last = last.max(next_seq);
                    full |= next_full;
                }
                let work = if full { Work::Full } else { Work::Reconcile };
                run(&state, work, last).await;
            }
            Job::Update(mut changes, mut last) => {
                let mut escalation = None;
                let mut deadline = Box::pin(sleep(UPDATE_DEBOUNCE));
                loop {
                    tokio::select! {
                        _ = &mut deadline => break,
                        next = receiver.recv() => match next {
                            Some(Job::Update(more, seq)) => {
                                changes.extend(more);
                                last = last.max(seq);
                                deadline = Box::pin(sleep(UPDATE_DEBOUNCE));
                            }
                            Some(Job::Reconcile(seq)) => {
                                last = last.max(seq);
                                escalation = Some(Work::Reconcile);
                                break;
                            }
                            Some(Job::Full(seq)) => {
                                last = last.max(seq);
                                escalation = Some(Work::Full);
                                break;
                            }
                            None => break,
                        }
                    }
                }
                run(&state, escalation.unwrap_or(Work::Update(changes)), last).await;
            }
        }
    }
}

async fn run(state: &AppState, work: Work, seq: u64) {
    // After a failure only a full rescan can restore coverage.
    let work = match work {
        Work::Update(_) if state.progress.needs_rescan.load(Ordering::SeqCst) => Work::Reconcile,
        work => work,
    };
    let rescan = !matches!(work, Work::Update(_));
    let result = execute(state, work).await;
    match result {
        Ok(()) => {
            if rescan {
                state.progress.needs_rescan.store(false, Ordering::SeqCst);
            }
            set_ready(state);
        }
        Err(error) => {
            state.progress.needs_rescan.store(true, Ordering::SeqCst);
            set_error(state, error);
            schedule_retry(state);
        }
    }
    state.progress.complete(seq);
}

async fn execute(state: &AppState, work: Work) -> Result<()> {
    set_state(state, "indexing");
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || match work {
        Work::Full => store.full_rebuild(),
        Work::Reconcile => store.reconcile(),
        Work::Update(changes) => store.apply_changes(&changes),
    })
    .await
    .map_err(|error| anyhow!("index task failed: {error}"))?
}

fn schedule_retry(state: &AppState) {
    if state
        .retry_scheduled
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    let jobs = state.jobs.clone();
    let scheduled = state.retry_scheduled.clone();
    tokio::spawn(async move {
        sleep(INDEX_RETRY_DELAY).await;
        scheduled.store(false, Ordering::Release);
        let _ = jobs.submit(Job::Reconcile).await;
    });
}

fn set_state(state: &AppState, value: &'static str) {
    state
        .worker
        .lock()
        .expect("worker status mutex poisoned")
        .state = value;
}

fn set_ready(state: &AppState) {
    let mut worker = state.worker.lock().expect("worker status mutex poisoned");
    worker.state = "ready";
    worker.last_commit_at = Some(store::now_ms());
    worker.last_error = None;
}

fn set_error(state: &AppState, error: anyhow::Error) {
    eprintln!("cohub-search: index job failed: {error:#}");
    let mut worker = state.worker.lock().expect("worker status mutex poisoned");
    worker.state = "error";
    worker.last_error = Some(format!("{error:#}"));
}

fn status_snapshot(state: &AppState) -> IndexStatus {
    let worker = state
        .worker
        .lock()
        .expect("worker status mutex poisoned")
        .clone();
    let pending_jobs = state.progress.pending();
    let coverage = if !state.store.verified() {
        "stale"
    } else if pending_jobs > 0 || state.progress.needs_rescan.load(Ordering::SeqCst) {
        "partial"
    } else {
        "complete"
    };
    IndexStatus {
        api_version: API_VERSION,
        family: state.store.manifest.family.clone(),
        generation: state.store.manifest.generation.clone(),
        schema_version: state.store.manifest.schema_version,
        analyzer_version: state.store.manifest.analyzer_version.clone(),
        state: worker.state,
        coverage,
        document_count: state.store.doc_count(),
        pending_jobs,
        last_commit_at: worker.last_commit_at,
        last_error: worker.last_error,
    }
}

fn cli_status(store: &IndexStore) -> IndexStatus {
    IndexStatus {
        api_version: API_VERSION,
        family: store.manifest.family.clone(),
        generation: store.manifest.generation.clone(),
        schema_version: store.manifest.schema_version,
        analyzer_version: store.manifest.analyzer_version.clone(),
        state: "ready",
        coverage: if store.verified() {
            "complete"
        } else {
            "stale"
        },
        document_count: store.doc_count(),
        pending_jobs: 0,
        last_commit_at: None,
        last_error: None,
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

fn print_json(value: &impl Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn service(workspace: &TempDir, index: &TempDir) -> AppState {
        let store = Arc::new(
            IndexStore::open(workspace.path(), index.path(), Vec::new()).expect("open store"),
        );
        let (sender, receiver) = mpsc::channel(64);
        let progress = Arc::new(Progress::default());
        let state = AppState {
            store,
            jobs: Submitter {
                sender,
                progress: progress.clone(),
                order: Arc::new(tokio::sync::Mutex::new(())),
            },
            progress,
            worker: Arc::new(Mutex::new(WorkerStatus {
                state: "ready",
                last_commit_at: None,
                last_error: None,
            })),
            // Keep retries out of the test; it drives rescans explicitly.
            retry_scheduled: Arc::new(AtomicBool::new(true)),
        };
        tokio::spawn(index_worker(receiver, state.clone()));
        state
    }

    /// Paused time skips the update debounce; tokio does not advance it while
    /// an index job runs on the blocking pool.
    async fn settle(state: &AppState) -> &'static str {
        for _ in 0..400 {
            if state.progress.pending() == 0 {
                return status_snapshot(state).coverage;
            }
            sleep(Duration::from_millis(25)).await;
        }
        panic!("index worker did not settle");
    }

    fn update(path: &str) -> impl FnOnce(u64) -> Job {
        let changes = vec![IndexChange {
            path: path.to_string(),
            old_path: None,
            kind: "modify".to_string(),
        }];
        move |seq| Job::Update(changes, seq)
    }

    #[tokio::test(start_paused = true)]
    async fn coverage_stays_partial_from_a_failed_job_until_a_rescan() {
        let workspace = TempDir::new().unwrap();
        let index = TempDir::new().unwrap();
        fs::write(workspace.path().join("a.txt"), "needle\n").unwrap();
        let state = service(&workspace, &index);
        assert_eq!(status_snapshot(&state).coverage, "stale");

        state.jobs.submit(Job::Reconcile).await.unwrap();
        assert_eq!(settle(&state).await, "complete");

        // An invalid path fails the batch; a later successful batch must not
        // hide the loss.
        state.jobs.submit(update("../outside")).await.unwrap();
        assert_eq!(settle(&state).await, "partial");
        assert_eq!(status_snapshot(&state).state, "error");
        state.jobs.submit(update("a.txt")).await.unwrap();
        assert_eq!(settle(&state).await, "complete");
        assert!(!state.progress.needs_rescan.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn accepted_jobs_keep_coverage_partial_until_they_run() {
        let workspace = TempDir::new().unwrap();
        let index = TempDir::new().unwrap();
        let state = service(&workspace, &index);
        state.jobs.submit(Job::Reconcile).await.unwrap();
        assert_eq!(settle(&state).await, "complete");

        fs::write(workspace.path().join("b.txt"), "needle\n").unwrap();
        state.jobs.submit(update("b.txt")).await.unwrap();
        // The update waits out its debounce window before it runs.
        assert_eq!(status_snapshot(&state).coverage, "partial");
        assert_eq!(settle(&state).await, "complete");
        assert_eq!(state.store.doc_count(), 1);
    }
}
