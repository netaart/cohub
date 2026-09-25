//! Workspace traversal that mirrors what the agent's rg and fd invocations see.
//!
//! Both tools walk with hidden files included, `.ignore` and `.gitignore`
//! applied outside git repositories, and symlinks left unfollowed. The index
//! walks the same way, so a file list from the index can stand in for a walk.
//! Rules only one tool applies (`.rgignore`, `.fdignore`) and rules the file
//! watcher cannot observe (`.git/info/exclude`, the global excludes file) are
//! reported instead of mirrored, and callers fall back to a real walk.

use anyhow::Result;
use ignore::{
    gitignore::{Gitignore, GitignoreBuilder},
    DirEntry, WalkBuilder,
};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    os::unix::fs::MetadataExt,
    path::Path,
    sync::{Arc, Mutex},
};

pub const RG_IGNORE_FILE: &str = ".rgignore";
pub const FD_IGNORE_FILE: &str = ".fdignore";

/// Entry names whose changes can alter which paths the walk yields.
pub fn changes_walk_rules(relative: &str) -> bool {
    matches!(
        relative.rsplit('/').next(),
        Some(".gitignore" | ".ignore" | RG_IGNORE_FILE | FD_IGNORE_FILE)
    )
}

/// Paths excluded from the watched domain: the file watcher's default names
/// plus configured patterns. A pattern with a slash is a workspace-relative
/// prefix; otherwise it matches any path segment.
#[derive(Clone)]
pub struct NameRules {
    patterns: Vec<String>,
}

impl NameRules {
    pub fn new(patterns: Vec<String>) -> Self {
        let mut patterns = patterns
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
        patterns.sort();
        patterns.dedup();
        Self { patterns }
    }

    pub fn excludes(&self, relative: &str) -> bool {
        relative.split('/').any(is_default_excluded_name)
            || self.patterns.iter().any(|pattern| {
                if pattern.contains('/') {
                    has_prefix(relative, pattern)
                } else {
                    relative.split('/').any(|segment| segment == pattern)
                }
            })
    }
}

fn is_default_excluded_name(name: &str) -> bool {
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
}

/// The agent passes `--glob '!.git'` to rg and `--exclude .git` to fd, so
/// `.git` entries are never visible to either tool.
fn is_tool_excluded(relative: &str) -> bool {
    relative.rsplit('/').next() == Some(".git")
}

pub fn has_prefix(path: &str, prefix: &str) -> bool {
    prefix.is_empty()
        || path == prefix
        || (path.len() > prefix.len()
            && path.as_bytes()[prefix.len()] == b'/'
            && path.starts_with(prefix))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fingerprint {
    pub size: u64,
    pub mtime_ns: u64,
    /// Change time catches content edits that restore size and mtime, such as
    /// `cp -p` or `tar -x` over an existing file.
    pub ctime_ns: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
}

/// What a walk found for one path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Found {
    Entry(EntryKind, Option<Fingerprint>),
    /// Visible to rg and fd but outside the watched domain, or unreadable.
    /// Its contents are unknown to the index and must be walked by the tool.
    Excluded {
        dir: bool,
    },
}

/// Rules present in the workspace that the index walk does not apply.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RuleNotes {
    pub rg_ignore_files: bool,
    pub fd_ignore_files: bool,
    pub vcs_excludes: bool,
    pub global_excludes: bool,
}

impl RuleNotes {
    pub fn content_mismatch(&self) -> bool {
        self.rg_ignore_files || self.vcs_excludes || self.global_excludes
    }

    pub fn paths_mismatch(&self) -> bool {
        self.fd_ignore_files || self.vcs_excludes || self.global_excludes
    }
}

pub struct Observation {
    pub found: BTreeMap<String, Found>,
    /// Regular files and directories in traversed directories that ignore
    /// rules hide. An rg `--glob` whitelist still searches such files.
    pub hidden: BTreeMap<String, bool>,
    pub rules: RuleNotes,
}

/// Walks the whole workspace.
pub fn observe(workspace: &Path, names: &NameRules) -> Result<Observation> {
    let excluded = Arc::new(Mutex::new(BTreeMap::new()));
    let mut builder = walk_builder(workspace);
    {
        let workspace = workspace.to_path_buf();
        let names = names.clone();
        let excluded = excluded.clone();
        builder.filter_entry(move |entry| {
            let Some(relative) = relative_path(&workspace, entry.path()) else {
                return true;
            };
            if is_tool_excluded(&relative) {
                return false;
            }
            if names.excludes(&relative) {
                // Ignore rules ran before this filter, so the entry is visible.
                excluded
                    .lock()
                    .expect("excluded entries mutex poisoned")
                    .insert(relative, Found::Excluded { dir: is_dir(entry) });
                return false;
            }
            true
        });
    }

    let mut found = BTreeMap::new();
    for entry in builder.build() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                match classify_walk_error(workspace, &error) {
                    WalkError::Unreadable(relative) => {
                        found.insert(relative, Found::Excluded { dir: true });
                    }
                    WalkError::Vanished | WalkError::Skipped => {}
                    WalkError::Fatal => return Err(anyhow::anyhow!("walk workspace: {error}")),
                }
                continue;
            }
        };
        let Some(relative) = relative_path(workspace, entry.path()) else {
            continue;
        };
        if let Some(observed) = observe_entry(&entry) {
            found.insert(relative, observed);
        }
    }
    found.extend(std::mem::take(
        &mut *excluded.lock().expect("excluded entries mutex poisoned"),
    ));
    let (hidden, mut rules) = list_hidden(workspace, &found);
    rules.global_excludes = global_excludes_present();
    Ok(Observation {
        found,
        hidden,
        rules,
    })
}

/// Lists every traversed directory without ignore rules. rg reads `.rgignore`
/// files and `.git` directories by name even when ignore rules hide them, so
/// rule detection happens here rather than in the rule-applying walk.
fn list_hidden(
    workspace: &Path,
    found: &BTreeMap<String, Found>,
) -> (BTreeMap<String, bool>, RuleNotes) {
    let traversed = std::iter::once(String::new()).chain(
        found
            .iter()
            .filter(|(_, observed)| matches!(observed, Found::Entry(EntryKind::Dir, _)))
            .map(|(path, _)| path.clone()),
    );
    let mut hidden = BTreeMap::new();
    let mut rules = RuleNotes::default();
    for dir in traversed {
        let Ok(children) = fs::read_dir(workspace.join(&dir)) else {
            continue;
        };
        for child in children.flatten() {
            let name = child.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let Ok(file_type) = child.file_type() else {
                continue;
            };
            match name {
                RG_IGNORE_FILE => rules.rg_ignore_files = true,
                FD_IGNORE_FILE => rules.fd_ignore_files = true,
                ".git" => {
                    if file_type.is_dir() && git_dir_has_excludes(&child.path()) {
                        rules.vcs_excludes = true;
                    }
                    continue;
                }
                _ => {}
            }
            let relative = if dir.is_empty() {
                name.to_string()
            } else {
                format!("{dir}/{name}")
            };
            if !found.contains_key(&relative) && (file_type.is_file() || file_type.is_dir()) {
                hidden.insert(relative, file_type.is_dir());
            }
        }
    }
    (hidden, rules)
}

/// Walks only the ancestors of `targets` and reports what the full walk would
/// yield for each target. Missing targets are absent from the result.
pub fn observe_targets(
    workspace: &Path,
    names: &NameRules,
    targets: &BTreeSet<String>,
) -> Result<BTreeMap<String, Found>> {
    let mut ancestors = BTreeSet::new();
    for target in targets {
        let mut current = target.as_str();
        while let Some((parent, _)) = current.rsplit_once('/') {
            ancestors.insert(parent.to_string());
            current = parent;
        }
    }
    let targets = Arc::new(targets.clone());
    let ancestors = Arc::new(ancestors);
    let excluded = Arc::new(Mutex::new(BTreeMap::new()));
    let mut builder = walk_builder(workspace);
    {
        let workspace = workspace.to_path_buf();
        let names = names.clone();
        let targets = targets.clone();
        let excluded = excluded.clone();
        builder.filter_entry(move |entry| {
            let Some(relative) = relative_path(&workspace, entry.path()) else {
                return true;
            };
            let target = targets.contains(&relative);
            if !target && !ancestors.contains(&relative) {
                return false;
            }
            if is_tool_excluded(&relative) {
                return false;
            }
            if names.excludes(&relative) {
                if target {
                    excluded
                        .lock()
                        .expect("excluded entries mutex poisoned")
                        .insert(relative, Found::Excluded { dir: is_dir(entry) });
                }
                return false;
            }
            true
        });
    }

    let mut found = BTreeMap::new();
    for entry in builder.build() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => match classify_walk_error(workspace, &error) {
                WalkError::Vanished | WalkError::Skipped => continue,
                // Only a full walk can place an unreadable directory.
                WalkError::Unreadable(_) | WalkError::Fatal => {
                    return Err(anyhow::anyhow!("walk changed paths: {error}"));
                }
            },
        };
        let Some(relative) = relative_path(workspace, entry.path()) else {
            continue;
        };
        if !targets.contains(&relative) {
            continue;
        }
        if let Some(observed) = observe_entry(&entry) {
            found.insert(relative, observed);
        }
    }
    found.extend(std::mem::take(
        &mut *excluded.lock().expect("excluded entries mutex poisoned"),
    ));
    Ok(found)
}

fn walk_builder(workspace: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(workspace);
    builder
        .hidden(false)
        .ignore(true)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .require_git(false)
        .parents(false)
        .follow_links(false);
    builder
}

fn observe_entry(entry: &DirEntry) -> Option<Found> {
    let file_type = entry.file_type()?;
    if file_type.is_symlink() {
        return Some(Found::Entry(EntryKind::Symlink, None));
    }
    if file_type.is_dir() {
        return Some(Found::Entry(EntryKind::Dir, None));
    }
    if !file_type.is_file() {
        // Sockets, FIFOs and devices are never searched by rg; the agent's fd
        // invocation lists only files, directories and symlinks.
        return None;
    }
    // A file removed between readdir and stat simply is not observed.
    let metadata = entry.metadata().ok()?;
    Some(Found::Entry(EntryKind::File, Some(fingerprint(&metadata))))
}

pub fn fingerprint(metadata: &fs::Metadata) -> Fingerprint {
    let nanos = |seconds: i64, nanos: i64| {
        u64::try_from(seconds)
            .unwrap_or(0)
            .saturating_mul(1_000_000_000)
            .saturating_add(u64::try_from(nanos).unwrap_or(0))
    };
    Fingerprint {
        size: metadata.len(),
        mtime_ns: nanos(metadata.mtime(), metadata.mtime_nsec()),
        ctime_ns: nanos(metadata.ctime(), metadata.ctime_nsec()),
    }
}

enum WalkError {
    /// A directory rg cannot read. rg fails on it, so it is handed to rg as an
    /// excluded entry and rg reports the same error.
    Unreadable(String),
    Vanished,
    /// Warnings such as a malformed ignore line, which rg also skips.
    Skipped,
    Fatal,
}

fn classify_walk_error(workspace: &Path, error: &ignore::Error) -> WalkError {
    let Some((path, io_error)) = directory_error(error) else {
        return WalkError::Skipped;
    };
    if io_error.kind() == std::io::ErrorKind::NotFound {
        return WalkError::Vanished;
    }
    match relative_path(workspace, path) {
        Some(relative) => WalkError::Unreadable(relative),
        None => WalkError::Fatal,
    }
}

/// Directory read failures surface as a path-carrying I/O error; ignore-file
/// problems arrive wrapped in `Partial` and are not directory failures.
fn directory_error(error: &ignore::Error) -> Option<(&Path, &std::io::Error)> {
    match error {
        ignore::Error::WithPath { path, err } => {
            io_error(err).map(|io_error| (path.as_path(), io_error))
        }
        ignore::Error::WithDepth { err, .. } => directory_error(err),
        _ => None,
    }
}

fn io_error(error: &ignore::Error) -> Option<&std::io::Error> {
    match error {
        ignore::Error::Io(io_error) => Some(io_error),
        ignore::Error::WithDepth { err, .. } | ignore::Error::WithPath { err, .. } => io_error(err),
        _ => None,
    }
}

fn is_dir(entry: &DirEntry) -> bool {
    entry
        .file_type()
        .is_some_and(|file_type| file_type.is_dir())
}

fn git_dir_has_excludes(git_dir: &Path) -> bool {
    let exclude = git_dir.join("info").join("exclude");
    if !exclude.is_file() {
        return false;
    }
    let mut builder = GitignoreBuilder::new(git_dir.parent().unwrap_or(git_dir));
    if builder.add(&exclude).is_some() {
        // Unreadable rules cannot be mirrored either.
        return true;
    }
    builder.build().map_or(true, |rules| !rules.is_empty())
}

/// The global excludes file lives outside the workspace, so the watcher cannot
/// report changes to it; queries check it again because the check is cheap.
pub fn global_excludes_present() -> bool {
    let (rules, error) = Gitignore::global();
    error.is_some() || !rules.is_empty()
}

pub fn relative_path(workspace: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(workspace).ok()?;
    if relative.as_os_str().is_empty() {
        return None;
    }
    Some(relative.to_string_lossy().replace('\\', "/"))
}

/// Groups found entries into the domain's lookup structures.
pub struct Partition {
    pub entries: BTreeMap<String, EntryKind>,
    pub files: HashMap<String, Fingerprint>,
    pub excluded: BTreeMap<String, bool>,
}

pub fn partition(found: BTreeMap<String, Found>) -> Partition {
    let mut entries = BTreeMap::new();
    let mut files = HashMap::new();
    let mut excluded = BTreeMap::new();
    for (path, observed) in found {
        match observed {
            Found::Entry(kind, fingerprint) => {
                if let (EntryKind::File, Some(fingerprint)) = (kind, fingerprint) {
                    files.insert(path.clone(), fingerprint);
                }
                entries.insert(path, kind);
            }
            Found::Excluded { dir } => {
                excluded.insert(path, dir);
            }
        }
    }
    Partition {
        entries,
        files,
        excluded,
    }
}
