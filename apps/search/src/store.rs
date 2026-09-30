//! Persistent content index plus the in-memory walk domain.
//!
//! Every file in the watched domain has one tantivy document holding its path,
//! fingerprint and content kind, so a reconcile compares the workspace with
//! the committed index itself and never trusts a separate snapshot. The walk
//! domain (directories, excluded entries, rule notes) is rebuilt by each
//! reconcile and only kept in memory: until the first reconcile in a process
//! the index reports stale coverage.

use crate::{
    content::{self, ContentKind, BINARY_PROBE_BYTES},
    pattern,
    walk::{
        self, changes_walk_rules, has_prefix, EntryKind, Fingerprint, Found, NameRules, RuleNotes,
    },
};
use anyhow::{anyhow, Context, Result};
use globset::GlobBuilder;
use ignore::overrides::{Override, OverrideBuilder};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fmt, fs,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tantivy::{
    collector::DocSetCollector,
    schema::{
        Field, IndexRecordOption, Schema, TantivyDocument, TextFieldIndexing, TextOptions, Value,
        STORED, STRING,
    },
    tokenizer::{NgramTokenizer, TextAnalyzer},
    Index, IndexReader, IndexWriter, ReloadPolicy, TantivyError, Term,
};

pub const INDEX_FAMILY: &str = "workspace.candidates";
pub const PATH_INDEX_FAMILY: &str = "workspace.paths";
pub const INDEX_SCHEMA_VERSION: u32 = 2;
pub const INDEX_ANALYZER_VERSION: &str = "trigram-v2";
pub const MAX_INDEXED_FILE_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_QUERY_LIMIT: usize = 5000;
const INDEX_WRITER_MEMORY_BYTES: usize = 64 * 1024 * 1024;
const STORE_CACHE_BLOCKS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexManifest {
    pub family: String,
    pub generation: String,
    pub schema_version: u32,
    pub analyzer_version: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexChange {
    pub path: String,
    #[serde(default)]
    pub old_path: Option<String>,
    pub kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRequest {
    pub pattern: String,
    #[serde(default)]
    pub fixed_strings: bool,
    #[serde(default)]
    pub case_insensitive: bool,
    #[serde(default)]
    pub path_prefix: String,
    #[serde(default)]
    pub glob: Option<String>,
    #[serde(default)]
    pub limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathQueryRequest {
    pub pattern: String,
    #[serde(default)]
    pub path_prefix: String,
    #[serde(default)]
    pub full_path: bool,
    #[serde(default)]
    pub limit: usize,
}

/// Why a query cannot be answered from the index. The caller must run the
/// real rg or fd walk instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Fallback {
    /// The domain has not been verified by this process yet.
    Stale,
    /// Accepted changes are not applied yet.
    Partial,
    /// The workspace has ignore rules the index does not mirror.
    Rules,
    /// The search root is not an indexed directory.
    Scope,
    /// The pattern yields no trigram requirement.
    Pattern,
    /// A glob re-includes a directory that ignore rules hide.
    Glob,
    /// More search targets than the requested limit.
    Targets,
}

/// Explicit rg targets whose union searches exactly what an rg walk of the
/// search root would search. Paths are workspace-relative.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueryPlan {
    /// Text candidates, searched as explicit rg file arguments.
    pub files: Vec<String>,
    /// Files that must be searched through a directory walk: candidates cut
    /// at a NUL byte, and files whose content is not indexed.
    pub walk_files: Vec<String>,
    /// Directories outside the watched domain, walked by rg.
    pub dirs: Vec<String>,
}

impl QueryPlan {
    fn len(&self) -> usize {
        self.files.len() + self.walk_files.len() + self.dirs.len()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum QueryOutcome {
    Fallback(Fallback),
    Plan(QueryPlan),
}

#[derive(Debug, PartialEq, Eq)]
pub enum PathOutcome {
    Fallback(Fallback),
    Matches {
        matches: Vec<String>,
        truncated: bool,
        /// Directories outside the watched domain; fd must walk them.
        dirs: Vec<String>,
    },
}

#[derive(Debug)]
pub struct IncompatibleIndex(String);

impl fmt::Display for IncompatibleIndex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "incompatible search index: {}", self.0)
    }
}

impl std::error::Error for IncompatibleIndex {}

#[derive(Clone, Copy)]
struct Fields {
    path: Field,
    content: Field,
    size: Field,
    mtime: Field,
    ctime: Field,
    kind: Field,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileMeta {
    fingerprint: Fingerprint,
    kind: ContentKind,
}

struct Domain {
    files: HashMap<String, FileMeta>,
    entries: BTreeMap<String, EntryKind>,
    excluded: BTreeMap<String, bool>,
    unindexed: BTreeSet<String>,
    hidden: BTreeMap<String, bool>,
    rules: RuleNotes,
}

pub struct IndexStore {
    workspace: PathBuf,
    names: NameRules,
    pub manifest: IndexManifest,
    fields: Fields,
    domain: Mutex<Option<Domain>>,
    reader: Mutex<IndexReader>,
    writer: Mutex<IndexWriter>,
}

impl IndexStore {
    pub fn open(workspace: &Path, index_dir: &Path, name_patterns: Vec<String>) -> Result<Self> {
        if !workspace.is_dir() {
            return Err(anyhow!(
                "workspace is not a directory: {}",
                workspace.display()
            ));
        }
        fs::create_dir_all(index_dir)
            .with_context(|| format!("create index directory {}", index_dir.display()))?;
        let manifest = load_or_create_manifest(index_dir)?;
        let index = if index_dir.join("meta.json").exists() {
            Index::open_in_dir(index_dir)
                .with_context(|| format!("open index {}", index_dir.display()))?
        } else {
            Index::create_in_dir(index_dir, build_schema())
                .with_context(|| format!("create index {}", index_dir.display()))?
        };
        let fields = Fields::from_schema(&index.schema())?;
        let tokenizer = NgramTokenizer::new(pattern::GRAM_CHARS, pattern::GRAM_CHARS, false)
            .context("create trigram tokenizer")?;
        index
            .tokenizers()
            .register("trigram", TextAnalyzer::builder(tokenizer).build());
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
            names: NameRules::new(name_patterns),
            manifest,
            fields,
            domain: Mutex::new(None),
            reader: Mutex::new(reader),
            writer: Mutex::new(writer),
        })
    }

    pub fn verified(&self) -> bool {
        self.domain.lock().expect("domain mutex poisoned").is_some()
    }

    pub fn doc_count(&self) -> u64 {
        self.reader
            .lock()
            .expect("tantivy reader mutex poisoned")
            .searcher()
            .num_docs()
    }

    /// Reindexes every file and rebuilds the domain.
    pub fn full_rebuild(&self) -> Result<()> {
        self.synchronize(true)
    }

    /// Brings the index in line with the workspace, reading only files whose
    /// fingerprint differs from their indexed document.
    pub fn reconcile(&self) -> Result<()> {
        self.synchronize(false)
    }

    fn synchronize(&self, rebuild: bool) -> Result<()> {
        let observation = walk::observe(&self.workspace, &self.names)?;
        let partition = walk::partition(observation.found);
        let indexed = if rebuild {
            HashMap::new()
        } else {
            self.indexed_files()?
        };
        let mut writer = self.writer.lock().expect("tantivy writer mutex poisoned");
        let result = (|| -> Result<(HashMap<String, FileMeta>, bool)> {
            let mut changed = rebuild;
            if rebuild {
                writer.delete_all_documents().context("clear index")?;
            }
            let mut files = HashMap::with_capacity(partition.files.len());
            for (path, fingerprint) in &partition.files {
                if let Some(meta) = indexed
                    .get(path)
                    .filter(|meta| meta.fingerprint == *fingerprint)
                {
                    files.insert(path.clone(), *meta);
                    continue;
                }
                changed = true;
                writer.delete_term(self.path_term(path));
                if let Some((document, kind)) = self.document(path, *fingerprint)? {
                    writer
                        .add_document(document)
                        .context("add indexed document")?;
                    files.insert(
                        path.clone(),
                        FileMeta {
                            fingerprint: *fingerprint,
                            kind,
                        },
                    );
                }
            }
            for path in indexed.keys() {
                if !partition.files.contains_key(path) {
                    changed = true;
                    writer.delete_term(self.path_term(path));
                }
            }
            if changed {
                writer.commit().context("commit index")?;
            }
            Ok((files, changed))
        })();
        let (files, changed) = match result {
            Ok(outcome) => outcome,
            Err(error) => {
                let _ = writer.rollback();
                return Err(error);
            }
        };
        drop(writer);
        if changed {
            self.reload_reader()?;
        }
        let unindexed = unindexed_paths(&files);
        *self.domain.lock().expect("domain mutex poisoned") = Some(Domain {
            files,
            entries: partition.entries,
            excluded: partition.excluded,
            unindexed,
            hidden: observation.hidden,
            rules: observation.rules,
        });
        Ok(())
    }

    /// Applies watcher changes. Changes that can alter ignore rules fall back
    /// to a reconcile, because they change the visibility of other paths.
    pub fn apply_changes(&self, changes: &[IndexChange]) -> Result<()> {
        let rule_change = changes.iter().any(|change| {
            changes_walk_rules(&change.path)
                || change.old_path.as_deref().is_some_and(changes_walk_rules)
        });
        if rule_change || !self.verified() {
            return self.reconcile();
        }

        let mut removed = BTreeSet::new();
        let mut targets = BTreeSet::new();
        for change in changes {
            let path = normalize_relative_path(&change.path)?;
            if let Some(old_path) = change.old_path.as_deref() {
                removed.insert(normalize_relative_path(old_path)?);
            }
            if change.kind == "delete" {
                removed.insert(path.clone());
            }
            targets.insert(path);
        }
        let found = walk::observe_targets(&self.workspace, &self.names, &targets)?;
        // Everything below a target that is no longer a directory is gone;
        // directory targets keep their children, which arrive as their own
        // changes.
        for target in &targets {
            if !matches!(found.get(target), Some(Found::Entry(EntryKind::Dir, _))) {
                removed.insert(target.clone());
            }
        }
        let removed = compact_prefixes(removed);
        // A target the walk did not reach but that exists is hidden by ignore
        // rules; only entries of traversed directories matter to rg.
        let mut hidden = BTreeMap::new();
        for target in &targets {
            if found.contains_key(target) {
                continue;
            }
            if let Ok(metadata) = fs::symlink_metadata(self.workspace.join(target)) {
                if metadata.is_file() || metadata.is_dir() {
                    hidden.insert(target.clone(), metadata.is_dir());
                }
            }
        }

        let stale: Vec<String> = {
            let guard = self.domain.lock().expect("domain mutex poisoned");
            let Some(domain) = guard.as_ref() else {
                drop(guard);
                return self.reconcile();
            };
            domain
                .files
                .keys()
                .filter(|path| removed.iter().any(|prefix| has_prefix(path, prefix)))
                .cloned()
                .collect()
        };

        // Every reported file is read again: an edit can keep size and mtime
        // when timestamps are coarse.
        let changed_files: Vec<(String, Fingerprint)> = found
            .iter()
            .filter_map(|(path, observed)| match observed {
                Found::Entry(EntryKind::File, Some(fingerprint)) => {
                    Some((path.clone(), *fingerprint))
                }
                _ => None,
            })
            .collect();

        let mut writer = self.writer.lock().expect("tantivy writer mutex poisoned");
        let result = (|| -> Result<HashMap<String, FileMeta>> {
            for path in &stale {
                writer.delete_term(self.path_term(path));
            }
            let mut added = HashMap::new();
            for (path, fingerprint) in &changed_files {
                writer.delete_term(self.path_term(path));
                if let Some((document, kind)) = self.document(path, *fingerprint)? {
                    writer
                        .add_document(document)
                        .context("add changed document")?;
                    added.insert(
                        path.clone(),
                        FileMeta {
                            fingerprint: *fingerprint,
                            kind,
                        },
                    );
                }
            }
            writer.commit().context("commit incremental index")?;
            Ok(added)
        })();
        let added = match result {
            Ok(added) => added,
            Err(error) => {
                let _ = writer.rollback();
                return Err(error);
            }
        };
        drop(writer);
        self.reload_reader()?;

        let mut guard = self.domain.lock().expect("domain mutex poisoned");
        let Some(domain) = guard.as_mut() else {
            return Ok(());
        };
        let under_removed = |path: &String| removed.iter().any(|prefix| has_prefix(path, prefix));
        domain.files.retain(|path, _| !under_removed(path));
        domain.entries.retain(|path, _| !under_removed(path));
        domain.excluded.retain(|path, _| !under_removed(path));
        domain.unindexed.retain(|path| !under_removed(path));
        domain.hidden.retain(|path, _| !under_removed(path));
        for (path, is_dir) in hidden {
            let parent = path.rsplit_once('/').map_or("", |(parent, _)| parent);
            if parent.is_empty() || domain.entries.get(parent) == Some(&EntryKind::Dir) {
                domain.hidden.insert(path, is_dir);
            }
        }
        for (path, observed) in found {
            domain.hidden.remove(&path);
            match observed {
                Found::Entry(kind, _) => {
                    domain.entries.insert(path.clone(), kind);
                    if let Some(meta) = added.get(&path) {
                        if meta.kind == ContentKind::Unindexed {
                            domain.unindexed.insert(path.clone());
                        }
                        domain.files.insert(path, *meta);
                    }
                }
                Found::Excluded { dir } => {
                    domain.excluded.insert(path, dir);
                }
            }
        }
        Ok(())
    }

    pub fn query(&self, request: &QueryRequest) -> Result<QueryOutcome> {
        let guard = self.domain.lock().expect("domain mutex poisoned");
        let Some(domain) = guard.as_ref() else {
            return Ok(QueryOutcome::Fallback(Fallback::Stale));
        };
        if domain.rules.content_mismatch() || walk::global_excludes_present() {
            return Ok(QueryOutcome::Fallback(Fallback::Rules));
        }
        let root = normalize_prefix(&request.path_prefix);
        if !is_indexed_dir(domain, root.as_deref()) {
            return Ok(QueryOutcome::Fallback(Fallback::Scope));
        }
        let Some(requirement) = pattern::requirement(
            &request.pattern,
            request.fixed_strings,
            request.case_insensitive,
        ) else {
            return Ok(QueryOutcome::Fallback(Fallback::Pattern));
        };
        let limit = request.limit.clamp(1, MAX_QUERY_LIMIT);
        let globs = build_globs(&self.workspace, request.glob.as_deref())?;
        let allowed = |path: &str, is_dir: bool| {
            globs
                .as_ref()
                .is_none_or(|globs| glob_allows(globs, root.as_deref(), path, is_dir))
        };

        let mut plan = QueryPlan::default();
        // A whitelist glob overrides ignore rules for the entries it matches,
        // so rg also searches rule-hidden files in traversed directories and
        // descends into rule-hidden directories the glob names.
        if let Some(globs) = globs.as_ref().filter(|globs| globs.num_whitelists() > 0) {
            for (path, is_dir) in descendants(&domain.hidden, root.as_deref()) {
                if !glob_allows(globs, root.as_deref(), path, *is_dir)
                    || !globs.matched(path, *is_dir).is_whitelist()
                {
                    continue;
                }
                if *is_dir {
                    return Ok(QueryOutcome::Fallback(Fallback::Glob));
                }
                plan.walk_files.push(path.clone());
            }
        }
        for (path, is_dir) in descendants(&domain.excluded, root.as_deref()) {
            if allowed(path, *is_dir) {
                if *is_dir {
                    plan.dirs.push(path.clone());
                } else {
                    plan.walk_files.push(path.clone());
                }
            }
        }
        for path in descendants_set(&domain.unindexed, root.as_deref()) {
            if allowed(path, false) {
                plan.walk_files.push(path.clone());
            }
        }
        if plan.len() > limit {
            return Ok(QueryOutcome::Fallback(Fallback::Targets));
        }

        let searcher = self
            .reader
            .lock()
            .expect("tantivy reader mutex poisoned")
            .searcher();
        let query = pattern::build_query(&requirement, self.fields.content);
        let mut addresses: Vec<_> = searcher
            .search(query.as_ref(), &DocSetCollector)
            .context("query tantivy index")?
            .into_iter()
            .collect();
        addresses.sort();
        for address in addresses {
            let document: TantivyDocument =
                searcher.doc(address).context("read tantivy document")?;
            let Some((path, meta)) = self.read_meta(&document) else {
                continue;
            };
            if !root
                .as_deref()
                .is_none_or(|root| has_prefix(&path, root) && path != root)
                || !allowed(&path, false)
            {
                continue;
            }
            match meta.kind {
                ContentKind::Text => plan.files.push(path),
                ContentKind::Binary => plan.walk_files.push(path),
                // Empty documents never match a trigram query.
                ContentKind::Unindexed => continue,
            }
            if plan.len() > limit {
                return Ok(QueryOutcome::Fallback(Fallback::Targets));
            }
        }
        Ok(QueryOutcome::Plan(plan))
    }

    /// Answers an fd `--glob` query: the pattern is matched against the file
    /// name, or the absolute path with `full_path`, smart-case like fd.
    pub fn path_query(&self, request: &PathQueryRequest) -> Result<PathOutcome> {
        let guard = self.domain.lock().expect("domain mutex poisoned");
        let Some(domain) = guard.as_ref() else {
            return Ok(PathOutcome::Fallback(Fallback::Stale));
        };
        if domain.rules.paths_mismatch() || walk::global_excludes_present() {
            return Ok(PathOutcome::Fallback(Fallback::Rules));
        }
        let root = normalize_prefix(&request.path_prefix);
        if !is_indexed_dir(domain, root.as_deref()) {
            return Ok(PathOutcome::Fallback(Fallback::Scope));
        }
        if request.limit > MAX_QUERY_LIMIT {
            return Ok(PathOutcome::Fallback(Fallback::Targets));
        }
        let limit = request.limit.max(1);
        let pattern = if request.pattern.is_empty() {
            "**"
        } else {
            request.pattern.as_str()
        };
        let matcher = GlobBuilder::new(pattern)
            .literal_separator(true)
            .case_insensitive(!pattern.chars().any(char::is_uppercase))
            .build()
            .context("invalid path glob")?
            .compile_matcher();
        let workspace = self.workspace.to_string_lossy();
        let is_match = |path: &str| {
            if request.full_path {
                matcher.is_match(format!("{workspace}/{path}"))
            } else {
                matcher.is_match(path.rsplit('/').next().unwrap_or(path))
            }
        };

        let mut matches: Vec<String> = descendants(&domain.entries, root.as_deref())
            .map(|(path, _)| path)
            .chain(descendants(&domain.excluded, root.as_deref()).map(|(path, _)| path))
            .filter(|path| is_match(path))
            .cloned()
            .collect();
        matches.sort();
        let truncated = matches.len() > limit;
        matches.truncate(limit);
        let dirs = descendants(&domain.excluded, root.as_deref())
            .filter(|(_, is_dir)| **is_dir)
            .map(|(path, _)| path.clone())
            .collect();
        Ok(PathOutcome::Matches {
            matches,
            truncated,
            dirs,
        })
    }

    /// Reads a file and builds its document. Returns `None` when the file
    /// disappeared; other read failures produce an unindexed document so rg
    /// still scans the file and reports the same error.
    fn document(
        &self,
        relative: &str,
        fingerprint: Fingerprint,
    ) -> Result<Option<(TantivyDocument, ContentKind)>> {
        let path = self.workspace.join(relative);
        let prepared = match read_prepared(&path, fingerprint.size) {
            Ok(prepared) => prepared,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => None,
        };
        let (text, kind) = match prepared {
            Some(prepared) => (prepared.text, prepared.kind),
            None => (String::new(), ContentKind::Unindexed),
        };
        let mut document = TantivyDocument::default();
        document.add_text(self.fields.path, relative);
        document.add_text(self.fields.content, text);
        document.add_u64(self.fields.size, fingerprint.size);
        document.add_u64(self.fields.mtime, fingerprint.mtime_ns);
        document.add_u64(self.fields.ctime, fingerprint.ctime_ns);
        document.add_u64(self.fields.kind, kind.code());
        Ok(Some((document, kind)))
    }

    fn read_meta(&self, document: &TantivyDocument) -> Option<(String, FileMeta)> {
        let path = document.get_first(self.fields.path)?.as_str()?.to_string();
        let size = document.get_first(self.fields.size)?.as_u64()?;
        let mtime_ns = document.get_first(self.fields.mtime)?.as_u64()?;
        let ctime_ns = document.get_first(self.fields.ctime)?.as_u64()?;
        let kind = ContentKind::from_code(document.get_first(self.fields.kind)?.as_u64()?)?;
        Some((
            path,
            FileMeta {
                fingerprint: Fingerprint {
                    size,
                    mtime_ns,
                    ctime_ns,
                },
                kind,
            },
        ))
    }

    fn indexed_files(&self) -> Result<HashMap<String, FileMeta>> {
        let searcher = self
            .reader
            .lock()
            .expect("tantivy reader mutex poisoned")
            .searcher();
        let mut files = HashMap::new();
        for segment in searcher.segment_readers() {
            let store = segment
                .get_store_reader(STORE_CACHE_BLOCKS)
                .context("open document store")?;
            for document in store.iter::<TantivyDocument>(segment.alive_bitset()) {
                let document = document.context("read stored document")?;
                if let Some((path, meta)) = self.read_meta(&document) {
                    files.insert(path, meta);
                }
            }
        }
        Ok(files)
    }

    fn path_term(&self, relative: &str) -> Term {
        Term::from_field_text(self.fields.path, relative)
    }

    fn reload_reader(&self) -> Result<()> {
        self.reader
            .lock()
            .expect("tantivy reader mutex poisoned")
            .reload()
            .context("reload tantivy reader")
    }
}

impl Fields {
    fn from_schema(schema: &Schema) -> Result<Self> {
        let field = |name: &str| {
            schema
                .get_field(name)
                .map_err(|_| anyhow!(IncompatibleIndex(format!("schema lacks field {name}"))))
        };
        Ok(Self {
            path: field("path")?,
            content: field("content")?,
            size: field("size")?,
            mtime: field("mtime")?,
            ctime: field("ctime")?,
            kind: field("kind")?,
        })
    }
}

fn build_schema() -> Schema {
    let mut builder = Schema::builder();
    builder.add_text_field("path", STRING | STORED);
    let indexing = TextFieldIndexing::default()
        .set_tokenizer("trigram")
        .set_index_option(IndexRecordOption::Basic);
    builder.add_text_field(
        "content",
        TextOptions::default().set_indexing_options(indexing),
    );
    builder.add_u64_field("size", STORED);
    builder.add_u64_field("mtime", STORED);
    builder.add_u64_field("ctime", STORED);
    builder.add_u64_field("kind", STORED);
    builder.build()
}

/// Reads what rg's directory walk can search. Files above the size cap are
/// probed for an early NUL, which bounds what rg reports; otherwise they stay
/// unindexed.
fn read_prepared(path: &Path, size: u64) -> io::Result<Option<content::Prepared>> {
    if size <= MAX_INDEXED_FILE_BYTES {
        return Ok(Some(content::prepare(&fs::read(path)?)));
    }
    let mut head = Vec::with_capacity(BINARY_PROBE_BYTES);
    fs::File::open(path)?
        .take(BINARY_PROBE_BYTES as u64)
        .read_to_end(&mut head)?;
    let prepared = content::prepare(&head);
    Ok((prepared.kind == ContentKind::Binary).then_some(prepared))
}

fn unindexed_paths(files: &HashMap<String, FileMeta>) -> BTreeSet<String> {
    files
        .iter()
        .filter(|(_, meta)| meta.kind == ContentKind::Unindexed)
        .map(|(path, _)| path.clone())
        .collect()
}

fn is_indexed_dir(domain: &Domain, root: Option<&str>) -> bool {
    root.is_none_or(|root| domain.entries.get(root) == Some(&EntryKind::Dir))
}

/// Entries strictly below `root`. Descendants of `a` sort between `a/` and
/// `a0` because `0` follows `/` in byte order.
fn descendants<'a, V>(
    map: &'a BTreeMap<String, V>,
    root: Option<&str>,
) -> Box<dyn Iterator<Item = (&'a String, &'a V)> + 'a> {
    match root {
        None => Box::new(map.iter()),
        Some(root) => Box::new(map.range(format!("{root}/")..format!("{root}0"))),
    }
}

fn descendants_set<'a>(
    set: &'a BTreeSet<String>,
    root: Option<&str>,
) -> Box<dyn Iterator<Item = &'a String> + 'a> {
    match root {
        None => Box::new(set.iter()),
        Some(root) => Box::new(set.range(format!("{root}/")..format!("{root}0"))),
    }
}

/// rg matches `--glob` against paths relative to its working directory (the
/// workspace), for every entry it walks below the search root.
fn build_globs(workspace: &Path, glob: Option<&str>) -> Result<Option<Override>> {
    let Some(glob) = glob.map(str::trim).filter(|glob| !glob.is_empty()) else {
        return Ok(None);
    };
    let mut builder = OverrideBuilder::new(workspace);
    builder.add(glob).context("invalid glob")?;
    Ok(Some(builder.build().context("invalid glob")?))
}

/// A walk never descends into a directory the globs exclude, so excluded
/// ancestors below the search root hide the entry as well.
fn glob_allows(globs: &Override, root: Option<&str>, path: &str, is_dir: bool) -> bool {
    let mut offset = root.map_or(0, |root| root.len() + 1);
    while let Some(slash) = path[offset..].find('/') {
        if globs.matched(&path[..offset + slash], true).is_ignore() {
            return false;
        }
        offset += slash + 1;
    }
    !globs.matched(path, is_dir).is_ignore()
}

fn compact_prefixes(prefixes: BTreeSet<String>) -> Vec<String> {
    let mut compact: Vec<String> = Vec::with_capacity(prefixes.len());
    for prefix in prefixes {
        if !compact.iter().any(|kept| has_prefix(&prefix, kept)) {
            compact.push(prefix);
        }
    }
    compact
}

pub fn normalize_relative_path(path: &str) -> Result<String> {
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
        return Err(anyhow!("path must name a workspace entry"));
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

fn load_or_create_manifest(index_dir: &Path) -> Result<IndexManifest> {
    let path = index_dir.join("manifest.json");
    let expected = |generation: String| IndexManifest {
        family: INDEX_FAMILY.to_string(),
        generation,
        schema_version: INDEX_SCHEMA_VERSION,
        analyzer_version: INDEX_ANALYZER_VERSION.to_string(),
    };
    if path.exists() {
        let data = fs::read(&path).with_context(|| format!("read manifest {}", path.display()))?;
        let manifest: IndexManifest = serde_json::from_slice(&data)
            .with_context(|| format!("parse manifest {}", path.display()))?;
        if manifest != expected(manifest.generation.clone()) {
            return Err(anyhow!(IncompatibleIndex(format!(
                "{} schema {} analyzer {}",
                manifest.family, manifest.schema_version, manifest.analyzer_version
            ))));
        }
        return Ok(manifest);
    }
    if index_dir.join("meta.json").exists() {
        return Err(anyhow!(IncompatibleIndex(
            "index without manifest".to_string()
        )));
    }
    let manifest = expected(format!("{}-{}", now_ms(), std::process::id()));
    let data = serde_json::to_vec_pretty(&manifest).context("serialize index manifest")?;
    let temporary = index_dir.join(format!(".manifest-{}.tmp", std::process::id()));
    fs::write(&temporary, data)
        .with_context(|| format!("write manifest {}", temporary.display()))?;
    fs::rename(&temporary, &path)
        .with_context(|| format!("install manifest {}", path.display()))?;
    Ok(manifest)
}

/// Opens the index for the long-running service. An index written by another
/// schema or analyzer version is derived data and is rebuilt from scratch;
/// corrupt indexes are moved aside for inspection instead.
pub fn open_store_for_serve(
    workspace: &Path,
    index_dir: &Path,
    name_patterns: Vec<String>,
) -> Result<IndexStore> {
    if !workspace.is_dir() {
        return Err(anyhow!(
            "workspace is not a directory: {}",
            workspace.display()
        ));
    }
    match IndexStore::open(workspace, index_dir, name_patterns.clone()) {
        Ok(store) => Ok(store),
        Err(error) if error.downcast_ref::<IncompatibleIndex>().is_some() => {
            eprintln!(
                "cohub-search: rebuilding index at {}: {error}",
                index_dir.display()
            );
            discard_index_contents(index_dir)?;
            IndexStore::open(workspace, index_dir, name_patterns)
        }
        Err(error) if should_quarantine_index(&error) => {
            quarantine_index_contents(index_dir)?;
            IndexStore::open(workspace, index_dir, name_patterns)
                .with_context(|| format!("recreate recovered index {}", index_dir.display()))
        }
        Err(error) => Err(error),
    }
}

fn discard_index_contents(index_dir: &Path) -> Result<()> {
    for entry in fs::read_dir(index_dir)
        .with_context(|| format!("read index directory {}", index_dir.display()))?
    {
        let entry = entry.context("read index directory entry")?;
        let name = entry.file_name();
        // Quarantined corrupt indexes are kept for inspection.
        if name.to_string_lossy().starts_with(".corrupt-") {
            continue;
        }
        let path = entry.path();
        let removal = if entry.file_type().context("inspect index entry")?.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        removal.with_context(|| format!("remove index entry {}", path.display()))?;
    }
    Ok(())
}

pub fn should_quarantine_index(error: &anyhow::Error) -> bool {
    if error.to_string().contains("parse manifest") {
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
        let path = entry.path();
        if path == quarantine || entry.file_name().to_string_lossy().starts_with(".corrupt-") {
            continue;
        }
        fs::rename(&path, quarantine.join(entry.file_name()))
            .with_context(|| format!("quarantine index entry in {}", quarantine.display()))?;
    }
    eprintln!(
        "cohub-search: quarantined invalid index at {}",
        quarantine.display()
    );
    Ok(())
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use tempfile::TempDir;

    struct Fixture {
        workspace: TempDir,
        index: TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                workspace: TempDir::new().expect("workspace tempdir"),
                index: TempDir::new().expect("index tempdir"),
            }
        }

        fn path(&self, relative: &str) -> PathBuf {
            self.workspace.path().join(relative)
        }

        fn write(&self, relative: &str, content: impl AsRef<[u8]>) {
            let path = self.path(relative);
            fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
            fs::write(path, content).expect("write file");
        }

        fn open(&self) -> IndexStore {
            IndexStore::open(self.workspace.path(), self.index.path(), Vec::new())
                .expect("open store")
        }

        fn reconciled(&self) -> IndexStore {
            let store = self.open();
            store.reconcile().expect("reconcile");
            store
        }
    }

    fn request(pattern: &str) -> QueryRequest {
        QueryRequest {
            pattern: pattern.to_string(),
            fixed_strings: false,
            case_insensitive: false,
            path_prefix: String::new(),
            glob: None,
            limit: 512,
        }
    }

    fn plan(store: &IndexStore, request: &QueryRequest) -> QueryPlan {
        match store.query(request).expect("query") {
            QueryOutcome::Plan(mut plan) => {
                plan.files.sort();
                plan.walk_files.sort();
                plan.dirs.sort();
                plan
            }
            QueryOutcome::Fallback(fallback) => panic!("unexpected fallback {fallback:?}"),
        }
    }

    fn fallback(store: &IndexStore, request: &QueryRequest) -> Fallback {
        match store.query(request).expect("query") {
            QueryOutcome::Fallback(fallback) => fallback,
            QueryOutcome::Plan(plan) => panic!("unexpected plan {plan:?}"),
        }
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn change(path: &str, kind: &str) -> IndexChange {
        IndexChange {
            path: path.to_string(),
            old_path: None,
            kind: kind.to_string(),
        }
    }

    #[test]
    fn plans_cover_everything_an_rg_walk_searches() {
        let fixture = Fixture::new();
        fixture.write(".gitignore", "node_modules\n.env\n");
        fixture.write("src/a.ts", "const NEEDLE_SRC = 1;\n");
        fixture.write("src/other.ts", "nothing here\n");
        // Tracked build output is visible to rg but outside the watched domain.
        fixture.write("build/script.js", "NEEDLE_BUILD\n");
        fixture.write("vendor/lib/x.go", "// NEEDLE_VENDOR\n");
        fixture.write("tools/out", "NEEDLE_FILE_NAMED_OUT\n");
        fixture.write("node_modules/pkg/index.js", "NEEDLE_NM\n");
        fixture.write(".env", "SECRET=NEEDLE_ENV\n");
        fixture.write("docs/latin1.txt", b"caf\xe9 NEEDLE_LATIN1\n");
        let mut utf16 = vec![0xFF, 0xFE];
        utf16.extend("NEEDLE_UTF16\n".encode_utf16().flat_map(u16::to_le_bytes));
        fixture.write("docs/utf16.txt", utf16);
        fixture.write("docs/nul.bin", b"NEEDLE_BEFORE_NUL\n\0after\n");
        let mut large_text = "filler line\n".repeat(400_000).into_bytes();
        large_text.extend_from_slice(b"NEEDLE_LARGE\n");
        fixture.write("docs/large.log", large_text);
        let mut large_binary = b"\x89PNG\r\n\x1a\n\0".to_vec();
        large_binary.resize(5 * 1024 * 1024, b'x');
        fixture.write("docs/large.png", large_binary);

        let store = fixture.reconciled();
        let plan = plan(&store, &request("NEEDLE"));

        assert_eq!(
            plan.files,
            strings(&["docs/latin1.txt", "docs/utf16.txt", "src/a.ts"])
        );
        assert_eq!(
            plan.walk_files,
            strings(&["docs/large.log", "docs/nul.bin", "tools/out"])
        );
        assert_eq!(plan.dirs, strings(&["build", "vendor"]));
    }

    #[test]
    fn roots_outside_the_indexed_directories_fall_back() {
        let fixture = Fixture::new();
        fixture.write(".gitignore", "ignored/\n");
        fixture.write("src/a.ts", "NEEDLE\n");
        fixture.write("build/sub/b.js", "NEEDLE\n");
        fixture.write("ignored/c.txt", "NEEDLE\n");
        std::os::unix::fs::symlink(fixture.path("src"), fixture.path("link")).expect("symlink");
        let store = fixture.reconciled();

        for root in [
            "missing",
            "link",
            "src/a.ts",
            "build/sub",
            "ignored",
            "../outside",
        ] {
            let mut scoped = request("NEEDLE");
            scoped.path_prefix = root.to_string();
            assert_eq!(fallback(&store, &scoped), Fallback::Scope, "root {root}");
        }
        let mut scoped = request("NEEDLE");
        scoped.path_prefix = "src".to_string();
        assert_eq!(plan(&store, &scoped).files, strings(&["src/a.ts"]));
    }

    #[test]
    fn unmirrored_ignore_rules_fall_back() {
        let fixture = Fixture::new();
        fixture.write("a.txt", "NEEDLE\n");
        fs::create_dir_all(fixture.path(".git/info")).expect("git dir");
        fixture.write(
            ".git/info/exclude",
            "# git ls-files --others --exclude-from=.git/info/exclude\n",
        );
        assert!(matches!(
            fixture.reconciled().query(&request("NEEDLE")).unwrap(),
            QueryOutcome::Plan(_)
        ));

        fixture.write(".git/info/exclude", "a.txt\n");
        assert_eq!(
            fallback(&fixture.reconciled(), &request("NEEDLE")),
            Fallback::Rules
        );

        fixture.write(".git/info/exclude", "");
        fixture.write("sub/.rgignore", "a.txt\n");
        let store = fixture.reconciled();
        assert_eq!(fallback(&store, &request("NEEDLE")), Fallback::Rules);
        // fd does not read .rgignore, so path queries stay exact.
        assert!(matches!(
            store
                .path_query(&PathQueryRequest {
                    pattern: "*.txt".to_string(),
                    path_prefix: String::new(),
                    full_path: false,
                    limit: 10,
                })
                .unwrap(),
            PathOutcome::Matches { .. }
        ));
    }

    #[test]
    fn unnarrowable_patterns_and_large_plans_fall_back() {
        let fixture = Fixture::new();
        for index in 0..5 {
            fixture.write(&format!("f{index}.txt"), "common needle\n");
        }
        let store = fixture.reconciled();
        assert_eq!(fallback(&store, &request("a.b.c")), Fallback::Pattern);
        let mut limited = request("needle");
        limited.limit = 4;
        assert_eq!(fallback(&store, &limited), Fallback::Targets);
        limited.limit = 5;
        assert_eq!(plan(&store, &limited).files.len(), 5);
    }

    #[test]
    fn globs_follow_rg_walk_semantics() {
        let fixture = Fixture::new();
        fixture.write("src/a.ts", "NEEDLE\n");
        fixture.write("src/b.tsx", "NEEDLE\n");
        fixture.write("src/sub/c.ts", "NEEDLE\n");
        fixture.write("src/skip/d.ts", "NEEDLE\n");
        fixture.write("docs/e.md", "NEEDLE\n");
        fixture.write("docs/E.TS", "NEEDLE\n");
        let store = fixture.reconciled();
        let with_glob = |root: &str, glob: &str| {
            let mut request = request("NEEDLE");
            request.path_prefix = root.to_string();
            request.glob = Some(glob.to_string());
            plan(&store, &request).files
        };

        assert_eq!(
            with_glob("", "*.{ts,tsx}"),
            strings(&["src/a.ts", "src/b.tsx", "src/skip/d.ts", "src/sub/c.ts"])
        );
        // Globs are case-sensitive and anchored at rg's working directory.
        assert_eq!(
            with_glob("", "*.ts"),
            strings(&["src/a.ts", "src/skip/d.ts", "src/sub/c.ts"])
        );
        assert_eq!(with_glob("src", "src/*.ts"), strings(&["src/a.ts"]));
        assert_eq!(with_glob("src", "sub/*.ts"), Vec::<String>::new());
        assert_eq!(
            with_glob("", "!*.md"),
            strings(&[
                "docs/E.TS",
                "src/a.ts",
                "src/b.tsx",
                "src/skip/d.ts",
                "src/sub/c.ts"
            ])
        );
        // An excluded directory prunes its subtree.
        assert_eq!(
            with_glob("src", "!skip"),
            strings(&["src/a.ts", "src/b.tsx", "src/sub/c.ts"])
        );
    }

    #[test]
    fn alternations_and_case_insensitive_queries_narrow_exactly() {
        let fixture = Fixture::new();
        fixture.write("search.go", "func handleFSSearch() {}\n");
        fixture.write("grep.go", "func handleFSGrep() {}\n");
        fixture.write("other.go", "func handleFSFind() {}\n");
        fixture.write("greek.txt", "ΚΑΣΑ\n");
        let store = fixture.reconciled();
        assert_eq!(
            plan(&store, &request("handleFS(Search|Grep)")).files,
            strings(&["grep.go", "search.go"])
        );
        let mut insensitive = request("HANDLEFSFIND");
        insensitive.case_insensitive = true;
        assert_eq!(plan(&store, &insensitive).files, strings(&["other.go"]));
        assert_eq!(plan(&store, &request("ΚΑΣ")).files, strings(&["greek.txt"]));
    }

    #[test]
    fn incremental_changes_follow_the_walk() {
        let fixture = Fixture::new();
        fixture.write(".gitignore", "secrets/\n");
        fixture.write("src/a.ts", "NEEDLE_OLD\n");
        fixture.write("src/nested/b.ts", "NEEDLE_NESTED\n");
        let store = fixture.reconciled();

        fixture.write("src/a.ts", "NEEDLE_NEW\n");
        fs::remove_dir_all(fixture.path("src/nested")).expect("remove nested");
        fixture.write("src/created.ts", "NEEDLE_CREATED\n");
        // The root .gitignore hides secrets/ entirely; a nested negation
        // cannot re-include a file below an ignored directory.
        fixture.write("secrets/.gitignore", "!key.txt\n");
        fixture.write("secrets/key.txt", "NEEDLE_SECRET\n");
        store
            .apply_changes(&[
                change("src/a.ts", "modify"),
                change("src/nested", "delete"),
                change("src/created.ts", "create"),
                change("secrets/key.txt", "modify"),
            ])
            .expect("apply changes");

        assert_eq!(
            plan(&store, &request("NEEDLE_")).files,
            strings(&["src/a.ts", "src/created.ts"])
        );
        assert!(
            matches!(plan(&store, &request("NEEDLE_OLD")), QueryPlan { files, .. } if files.is_empty())
        );
        assert!(!store.indexed_paths().contains("src/nested/b.ts"));
    }

    #[test]
    fn excluded_roots_appear_and_disappear_incrementally() {
        let fixture = Fixture::new();
        fixture.write("app/main.ts", "NEEDLE\n");
        let store = fixture.reconciled();

        fixture.write("app/dist/bundle.js", "NEEDLE\n");
        store
            .apply_changes(&[change("app/dist", "create")])
            .expect("excluded root created");
        assert_eq!(store.excluded_paths(), vec![("app/dist".to_string(), true)]);
        assert_eq!(
            plan(&store, &request("NEEDLE")).dirs,
            strings(&["app/dist"])
        );

        fs::remove_dir_all(fixture.path("app/dist")).expect("remove dist");
        store
            .apply_changes(&[change("app/dist", "delete")])
            .expect("excluded root removed");
        assert!(store.excluded_paths().is_empty());
    }

    #[test]
    fn directory_replacement_keeps_only_new_entries() {
        let fixture = Fixture::new();
        fixture.write("src/old.txt", "NEEDLE_OLD\n");
        let store = fixture.reconciled();

        fs::remove_dir_all(fixture.path("src")).expect("remove src");
        std::os::unix::fs::symlink(
            fixture.workspace.path().join("elsewhere"),
            fixture.path("src"),
        )
        .expect("symlink");
        store
            .apply_changes(&[change("src", "create")])
            .expect("replace dir with symlink");

        assert!(store.indexed_paths().is_empty());
        let mut scoped = request("NEEDLE_OLD");
        scoped.path_prefix = "src".to_string();
        assert_eq!(fallback(&store, &scoped), Fallback::Scope);
    }

    #[test]
    fn reconcile_restores_documents_missing_from_the_index() {
        let fixture = Fixture::new();
        fixture.write("keep.txt", "NEEDLE_RESTORED\n");
        let original = fs::metadata(fixture.path("keep.txt"))
            .unwrap()
            .modified()
            .unwrap();
        {
            let store = fixture.reconciled();
            fs::remove_file(fixture.path("keep.txt")).expect("remove file");
            store
                .apply_changes(&[change("keep.txt", "delete")])
                .expect("delete");
        }
        // Restored with its original mtime while no process was watching.
        fixture.write("keep.txt", "NEEDLE_RESTORED\n");
        fs::File::options()
            .write(true)
            .open(fixture.path("keep.txt"))
            .unwrap()
            .set_modified(original)
            .unwrap();

        let store = fixture.open();
        assert_eq!(
            fallback(&store, &request("NEEDLE_RESTORED")),
            Fallback::Stale
        );
        store.reconcile().expect("reconcile");
        assert_eq!(
            plan(&store, &request("NEEDLE_RESTORED")).files,
            strings(&["keep.txt"])
        );
    }

    #[test]
    fn unreadable_entries_are_left_for_rg_to_report() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        fixture.write("ok.txt", "NEEDLE\n");
        fixture.write("locked.txt", "NEEDLE\n");
        fixture.write("closed/inner.txt", "NEEDLE\n");
        fs::set_permissions(
            fixture.path("locked.txt"),
            fs::Permissions::from_mode(0o000),
        )
        .unwrap();
        fs::set_permissions(fixture.path("closed"), fs::Permissions::from_mode(0o000)).unwrap();
        // Running as root bypasses permissions; nothing to test then.
        let privileged = fs::read(fixture.path("locked.txt")).is_ok();

        let store = fixture.open();
        let rebuilt = store.full_rebuild();
        fs::set_permissions(
            fixture.path("locked.txt"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        fs::set_permissions(fixture.path("closed"), fs::Permissions::from_mode(0o755)).unwrap();
        rebuilt.expect("unreadable entries do not fail the build");
        if privileged {
            return;
        }
        let plan = plan(&store, &request("NEEDLE"));
        assert_eq!(plan.files, strings(&["ok.txt"]));
        assert_eq!(plan.walk_files, strings(&["locked.txt"]));
        assert_eq!(plan.dirs, strings(&["closed"]));
    }

    #[test]
    fn path_queries_match_fd() {
        let fixture = Fixture::new();
        fixture.write("src/main.ts", "");
        fixture.write("src/nested/child.ts", "");
        fixture.write("README.md", "");
        fixture.write("build/out.ts", "");
        std::os::unix::fs::symlink(fixture.path("src"), fixture.path("src-link")).expect("symlink");
        let store = fixture.reconciled();
        let query = |pattern: &str, root: &str, full_path: bool, limit: usize| {
            store
                .path_query(&PathQueryRequest {
                    pattern: pattern.to_string(),
                    path_prefix: root.to_string(),
                    full_path,
                    limit,
                })
                .expect("path query")
        };

        assert_eq!(
            query("*.ts", "", false, 10),
            PathOutcome::Matches {
                matches: strings(&["src/main.ts", "src/nested/child.ts"]),
                truncated: false,
                dirs: strings(&["build"]),
            }
        );
        // Smart case: lowercase patterns match case-insensitively.
        assert!(
            matches!(query("readme.md", "", false, 10), PathOutcome::Matches { matches, .. } if matches == strings(&["README.md"]))
        );
        assert!(
            matches!(query("README.MD", "", false, 10), PathOutcome::Matches { matches, .. } if matches.is_empty())
        );
        // Full-path patterns see the absolute path, like fd.
        let workspace = fixture.workspace.path().to_string_lossy().to_string();
        let absolute = format!("{workspace}/src/*.ts");
        assert!(
            matches!(query(&absolute, "", true, 10), PathOutcome::Matches { matches, .. } if matches == strings(&["src/main.ts"]))
        );
        // Directory names, symlinks and excluded roots are listed too.
        assert!(
            matches!(query("{src-link,build,nested}", "", false, 10), PathOutcome::Matches { matches, .. } if matches == strings(&["build", "src-link", "src/nested"]))
        );
        assert!(
            matches!(query("*.ts", "", false, 1), PathOutcome::Matches { matches, truncated: true, .. } if matches.len() == 1)
        );
        assert_eq!(
            query("*", "src/main.ts", false, 10),
            PathOutcome::Fallback(Fallback::Scope)
        );
        assert!(
            matches!(query("*", "src", false, 10), PathOutcome::Matches { matches, dirs, .. } if matches == strings(&["src/main.ts", "src/nested", "src/nested/child.ts"]) && dirs.is_empty())
        );
    }

    #[test]
    fn incompatible_indexes_are_rebuilt() {
        let fixture = Fixture::new();
        fixture.write("a.txt", "NEEDLE\n");
        fs::write(
            fixture.index.path().join("manifest.json"),
            r#"{"family":"workspace.candidates","generation":"old","schemaVersion":1,"analyzerVersion":"trigram-v1"}"#,
        )
        .unwrap();
        fs::write(fixture.index.path().join("files.json"), "{}").unwrap();
        fs::create_dir(fixture.index.path().join(".corrupt-1")).unwrap();

        let store =
            open_store_for_serve(fixture.workspace.path(), fixture.index.path(), Vec::new())
                .expect("open");
        store.reconcile().expect("reconcile");
        assert_eq!(store.manifest.schema_version, INDEX_SCHEMA_VERSION);
        assert!(!fixture.index.path().join("files.json").exists());
        assert!(fixture.index.path().join(".corrupt-1").exists());
        assert_eq!(plan(&store, &request("NEEDLE")).files, strings(&["a.txt"]));
    }

    #[test]
    fn corrupt_indexes_are_quarantined_without_deleting_them() {
        let fixture = Fixture::new();
        fs::write(fixture.index.path().join("manifest.json"), "not json").unwrap();
        let store =
            open_store_for_serve(fixture.workspace.path(), fixture.index.path(), Vec::new())
                .expect("recover");
        assert_eq!(store.doc_count(), 0);
        let quarantined = fs::read_dir(fixture.index.path())
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| entry.file_name().to_string_lossy().starts_with(".corrupt-"))
            .expect("quarantine directory");
        assert_eq!(
            fs::read_to_string(quarantined.path().join("manifest.json")).unwrap(),
            "not json"
        );
        assert!(should_quarantine_index(&anyhow!("parse manifest failed")));
        assert!(!should_quarantine_index(&anyhow!(
            "Failed to acquire Lockfile: LockBusy"
        )));
    }

    #[test]
    fn whitelist_globs_reach_files_hidden_by_ignore_rules() {
        let fixture = Fixture::new();
        fixture.write(".gitignore", "*.log\nlogs/\n");
        fixture.write("app.log", "ERROR one\n");
        fixture.write("src/b.log", "ERROR two\n");
        fixture.write("src/a.ts", "ERROR src\n");
        fixture.write("logs/c.log", "ERROR three\n");
        let store = fixture.reconciled();
        let with_glob = |glob: Option<&str>| {
            let mut request = request("ERROR");
            request.glob = glob.map(str::to_string);
            store.query(&request).expect("query")
        };

        let QueryOutcome::Plan(plan) = with_glob(Some("*.log")) else {
            panic!("expected plan");
        };
        // rg searches gitignored files a whitelist glob names, but never
        // descends into a gitignored directory the glob does not name.
        assert_eq!(plan.files, Vec::<String>::new());
        assert_eq!(plan.walk_files, strings(&["app.log", "src/b.log"]));
        let QueryOutcome::Plan(plan) = with_glob(None) else {
            panic!("expected plan");
        };
        assert_eq!(plan.files, strings(&["src/a.ts"]));
        assert!(plan.walk_files.is_empty());
        // Negated globs cannot re-include anything.
        let QueryOutcome::Plan(plan) = with_glob(Some("!*.ts")) else {
            panic!("expected plan");
        };
        assert!(plan.files.is_empty() && plan.walk_files.is_empty());
        // A glob naming a hidden directory makes rg walk into it.
        assert_eq!(
            with_glob(Some("logs")),
            QueryOutcome::Fallback(Fallback::Glob)
        );
        assert_eq!(with_glob(Some("*")), QueryOutcome::Fallback(Fallback::Glob));

        fixture.write("src/new.log", "ERROR four\n");
        store
            .apply_changes(&[change("src/new.log", "create")])
            .expect("hidden file created");
        let QueryOutcome::Plan(plan) = with_glob(Some("*.log")) else {
            panic!("expected plan");
        };
        assert_eq!(
            plan.walk_files,
            strings(&["app.log", "src/b.log", "src/new.log"])
        );
        fs::remove_file(fixture.path("app.log")).unwrap();
        store
            .apply_changes(&[change("app.log", "delete")])
            .expect("hidden file removed");
        let QueryOutcome::Plan(plan) = with_glob(Some("*.log")) else {
            panic!("expected plan");
        };
        assert_eq!(plan.walk_files, strings(&["src/b.log", "src/new.log"]));
    }

    #[test]
    fn ignore_files_hidden_by_rules_are_still_detected() {
        let fixture = Fixture::new();
        fixture.write(".gitignore", ".rgignore\n");
        fixture.write(".rgignore", "secret.txt\n");
        fixture.write("secret.txt", "NEEDLE\n");
        assert_eq!(
            fallback(&fixture.reconciled(), &request("NEEDLE")),
            Fallback::Rules
        );
    }

    #[test]
    fn watcher_changes_are_read_even_when_size_and_mtime_repeat() {
        let fixture = Fixture::new();
        fixture.write("a.txt", "NEEDLE_ONE\n");
        let store = fixture.reconciled();
        let mtime = fs::metadata(fixture.path("a.txt"))
            .unwrap()
            .modified()
            .unwrap();
        fixture.write("a.txt", "NEEDLE_TWO\n");
        fs::File::options()
            .write(true)
            .open(fixture.path("a.txt"))
            .unwrap()
            .set_modified(mtime)
            .unwrap();
        store
            .apply_changes(&[change("a.txt", "modify")])
            .expect("apply modify");
        assert_eq!(
            plan(&store, &request("NEEDLE_TWO")).files,
            strings(&["a.txt"])
        );
        assert!(plan(&store, &request("NEEDLE_ONE")).files.is_empty());
    }

    #[test]
    fn reconcile_detects_edits_that_restore_size_and_mtime() {
        let fixture = Fixture::new();
        fixture.write("a.txt", "NEEDLE_ONE\n");
        let mtime = fs::metadata(fixture.path("a.txt"))
            .unwrap()
            .modified()
            .unwrap();
        fixture.reconciled();
        // Like `cp -p` of a same-sized file while no watcher ran.
        fixture.write("a.txt", "NEEDLE_TWO\n");
        fs::File::options()
            .write(true)
            .open(fixture.path("a.txt"))
            .unwrap()
            .set_modified(mtime)
            .unwrap();
        let store = fixture.reconciled();
        assert_eq!(
            plan(&store, &request("NEEDLE_TWO")).files,
            strings(&["a.txt"])
        );
    }

    #[test]
    fn prefix_helpers_do_not_treat_partial_names_as_children() {
        assert!(has_prefix("src/main.ts", "src"));
        assert!(!has_prefix("srcfoo/main.ts", "src"));
        assert_eq!(
            compact_prefixes(BTreeSet::from([
                "src".to_string(),
                "src/nested".to_string(),
                "lib".to_string()
            ])),
            strings(&["lib", "src"])
        );
        let map: BTreeMap<String, ()> = ["src", "src-x", "src.txt", "src/a", "src/z", "src0"]
            .into_iter()
            .map(|key| (key.to_string(), ()))
            .collect();
        let below: HashSet<&str> = descendants(&map, Some("src"))
            .map(|(key, _)| key.as_str())
            .collect();
        assert_eq!(below, HashSet::from(["src/a", "src/z"]));
    }

    impl IndexStore {
        fn excluded_paths(&self) -> Vec<(String, bool)> {
            let guard = self.domain.lock().expect("domain mutex poisoned");
            guard
                .as_ref()
                .map(|domain| {
                    domain
                        .excluded
                        .iter()
                        .map(|(path, dir)| (path.clone(), *dir))
                        .collect()
                })
                .unwrap_or_default()
        }

        fn indexed_paths(&self) -> HashSet<String> {
            self.indexed_files()
                .expect("read indexed files")
                .into_keys()
                .collect()
        }
    }
}
