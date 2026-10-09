package filewatch

import (
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

type Change struct {
	Path     string `json:"path,omitempty"`
	OldPath  string `json:"oldPath,omitempty"`
	Kind     string `json:"kind"`
	NodeType string `json:"nodeType,omitempty"`
	MtimeMs  int64  `json:"mtimeMs,omitempty"`
	Size     int64  `json:"size,omitempty"`
}

type Batch struct {
	Seq     int64    `json:"seq"`
	Resync  bool     `json:"resync,omitempty"`
	Changes []Change `json:"changes"`
}

type Handler func(Batch)

const (
	debounceWindow = 250 * time.Millisecond
	maxBatchSize   = 500
	repairInterval = 5 * time.Minute
)

var defaultIgnore = []string{
	// VCS metadata
	".git", ".hg", ".svn",

	// Dependencies / package manager stores
	"node_modules", ".pnpm-store", ".yarn", ".bun", "vendor",

	// Build outputs
	"dist", "build", "out", "target", ".next", ".nuxt", ".svelte-kit", ".vite", ".vercel", ".output",

	// Cache / coverage / logs / temporary files
	"coverage", ".cache", ".turbo", ".parcel-cache", ".rollup.cache", ".pytest_cache", "__pycache__", ".mypy_cache", ".ruff_cache", "tmp", "temp", ".tmp",
}

type Watcher struct {
	root        string
	logger      *slog.Logger
	handler     Handler
	watcher     *fsnotify.Watcher
	backend     eventBackend
	failure     string
	unavailable bool

	closeOnce sync.Once
	closeErr  error
	flushMu   sync.Mutex
	mu        sync.Mutex
	pending   map[string]Change
	resync    bool
	seq       int64
	timer     *time.Timer
	ignored   []string
	closed    chan struct{}
}

func Start(root string, logger *slog.Logger, handler Handler) (*Watcher, error) {
	cleanRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	// Local roots exist at startup; cloud roots may arrive after bootstrap.
	if resolved, resolveErr := filepath.EvalSymlinks(cleanRoot); resolveErr == nil {
		cleanRoot = resolved
	}
	ignored := IgnorePatterns()
	backend, err := startPlatformBackend(cleanRoot, logger, ignored)
	if err != nil {
		return nil, err
	}
	w := &Watcher{
		root: cleanRoot, logger: logger, handler: handler, backend: backend,
		pending: make(map[string]Change), ignored: ignored, closed: make(chan struct{}),
	}
	if backend == nil {
		w.watcher, err = fsnotify.NewWatcher()
		if err != nil {
			return nil, err
		}
	}
	go w.loop()
	go w.repairLoop()
	if backend == nil {
		go func() {
			w.addRecursiveBestEffort(w.root)
			// Ask consumers to refresh changes missed during registration.
			w.enqueueResync()
		}()
	} else if backend.name() != "scan" {
		w.enqueueResync()
	}
	logger.Info("file monitoring started", slog.String("backend", w.Status().Backend))
	return w, nil
}

// IgnorePatterns returns the normalized rules shared by the watcher and
// optional consumers such as the workspace search index.
func IgnorePatterns() []string {
	items := make([]string, 0, len(defaultIgnore)+8)
	seen := make(map[string]struct{}, len(defaultIgnore)+8)
	appendItem := func(raw string) {
		if v := sanitizeIgnorePattern(raw); v != "" {
			if _, ok := seen[v]; ok {
				return
			}
			seen[v] = struct{}{}
			items = append(items, v)
		}
	}
	for _, raw := range defaultIgnore {
		appendItem(raw)
	}
	for _, raw := range strings.Split(os.Getenv("FS_WATCH_IGNORE"), ",") {
		appendItem(raw)
	}
	return items
}

func sanitizeIgnorePattern(raw string) string {
	v := strings.TrimSpace(raw)
	if v == "" || strings.Contains(v, "\x00") || filepath.IsAbs(v) {
		return ""
	}
	v = strings.Trim(strings.ReplaceAll(v, "\\", "/"), "/")
	if v == "" || strings.Contains(v, "..") {
		return ""
	}
	return v
}

func (w *Watcher) Close() error {
	w.closeOnce.Do(func() {
		close(w.closed)
		w.mu.Lock()
		if w.timer != nil {
			w.timer.Stop()
			w.timer = nil
		}
		w.mu.Unlock()
		if w.backend != nil {
			w.closeErr = w.backend.close()
		} else if w.watcher != nil {
			w.closeErr = w.watcher.Close()
		}
	})
	return w.closeErr
}

// RequestResync asks consumers to reload authoritative filesystem state.
// It is safe to call when a transport reconnects or watcher coverage is repaired.
func (w *Watcher) RequestResync() {
	w.enqueueResync()
}

func (w *Watcher) isClosed() bool {
	select {
	case <-w.closed:
		return true
	default:
		return false
	}
}

func (w *Watcher) loop() {
	if w.backend != nil {
		w.backendLoop()
		return
	}
	for {
		select {
		case event, ok := <-w.watcher.Events:
			if !ok {
				if !w.isClosed() {
					w.markUnavailable("watch_error")
					w.enqueueResync()
				}
				return
			}
			w.handleEvent(event)
		case err, ok := <-w.watcher.Errors:
			if !ok {
				if !w.isClosed() {
					w.markUnavailable("watch_error")
					w.enqueueResync()
				}
				return
			}
			w.markFailure("watch_error")
			w.logger.Warn("file watcher error", slog.String("error", err.Error()))
			if errors.Is(err, fsnotify.ErrEventOverflow) {
				w.addRecursiveBestEffort(w.root)
				w.enqueueResync()
			}
		case <-w.closed:
			return
		}
	}
}

func (w *Watcher) backendLoop() {
	events := w.backend.events()
	errorsCh := w.backend.errors()
	for events != nil || errorsCh != nil {
		select {
		case event, ok := <-events:
			if !ok {
				if !w.isClosed() {
					w.markUnavailable("watch_error")
					w.enqueueResync()
				}
				return
			}
			w.handleBackendEvent(event)
		case err, ok := <-errorsCh:
			if !ok {
				if !w.isClosed() {
					w.markUnavailable("watch_error")
					w.enqueueResync()
				}
				return
			}
			w.markFailure("watch_error")
			w.logger.Warn("file watcher backend error", slog.String("backend", w.backend.name()), slog.String("error", err.Error()))
			w.enqueueResync()
		case <-w.closed:
			return
		}
	}
}

func (w *Watcher) handleBackendEvent(event backendEvent) {
	if event.healthy {
		w.markHealthy()
	}
	if event.failed {
		reason := event.reason
		if reason == "" {
			reason = "watch_error"
		}
		w.markFailure(reason)
		w.logger.Warn("workspace watch root changed; restart Runtime")
	}
	rel, ok := w.relative(event.path)
	if event.path != "" && (!ok || w.isIgnored(rel)) {
		return
	}
	if event.resync {
		w.enqueueResync()
		return
	}
	if event.path == "" {
		return
	}
	if rel == "" {
		w.enqueueResync()
		return
	}
	w.markHealthy()

	kind := event.kind
	if kind == "" {
		kind = "modify"
	}
	nodeType := event.nodeType
	var size int64
	var mtimeMs int64
	if info, err := os.Lstat(event.path); err == nil {
		if !isWatchableNode(info.Mode()) {
			return
		}
		nodeType = nodeTypeFor(info)
		size = info.Size()
		mtimeMs = info.ModTime().UnixMilli()
		if kind == "delete" {
			kind = "modify"
		}
	} else if os.IsNotExist(err) {
		kind = "delete"
	} else {
		w.enqueueResync()
		return
	}
	w.enqueue(Change{Path: rel, Kind: kind, NodeType: nodeType, Size: size, MtimeMs: mtimeMs})
}

func (w *Watcher) repairLoop() {
	ticker := time.NewTicker(repairInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if w.backend != nil {
				// Native recursive streams can coalesce or lose events. A periodic
				// authoritative refresh keeps downstream caches self-healing.
				w.enqueueResync()
				continue
			}
			if added := w.addRecursiveBestEffort(w.root); added {
				w.enqueueResync()
			}

		case <-w.closed:
			return
		}
	}
}

func (w *Watcher) handleEvent(event fsnotify.Event) {
	rel, ok := w.relative(event.Name)
	if !ok || w.isIgnored(rel) {
		return
	}
	if rel == "" {
		if event.Has(fsnotify.Remove) || event.Has(fsnotify.Rename) {
			w.markFailure("root_changed")
		}
		w.enqueueResync()
		return
	}
	w.markHealthy()

	kind := "modify"
	if event.Has(fsnotify.Create) {
		kind = "create"
	} else if event.Has(fsnotify.Remove) {
		kind = "delete"
	} else if event.Has(fsnotify.Rename) {
		kind = "delete"
	}

	nodeType := "unknown"
	var size int64
	var mtimeMs int64
	discoverSubtree := false
	if info, err := os.Lstat(event.Name); err == nil {
		if !isWatchableNode(info.Mode()) {
			return
		}
		nodeType = nodeTypeFor(info)
		if info.IsDir() && event.Has(fsnotify.Create) {
			discoverSubtree = true
		}
		size = info.Size()
		mtimeMs = info.ModTime().UnixMilli()
	}

	w.enqueue(Change{Path: rel, Kind: kind, NodeType: nodeType, Size: size, MtimeMs: mtimeMs})
	if discoverSubtree {
		// Keep the fsnotify loop responsive while a copied or extracted subtree
		// is scanned. enqueue is synchronized and switches to resync at the cap.
		go w.discoverAndWatchSubtree(event.Name, w.enqueue)
	}
}

// addRecursiveBestEffort registers every visible directory below root and
// reports whether watcher coverage expanded. It deliberately emits no changes.
func (w *Watcher) addRecursiveBestEffort(root string) bool {
	known := make(map[string]struct{})
	for _, path := range w.watcher.WatchList() {
		known[filepath.Clean(path)] = struct{}{}
	}
	added := false
	complete := true
	walkErr := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if w.isClosed() {
			return filepath.SkipAll
		}
		if err != nil {
			complete = false
			return nil
		}
		if d == nil || !d.IsDir() {
			return nil
		}
		rel, ok := w.relative(path)
		if ok && rel != "" && w.isIgnored(rel) {
			return filepath.SkipDir
		}
		cleaned := filepath.Clean(path)
		_, wasKnown := known[cleaned]
		if err := w.watcher.Add(path); err != nil && !os.IsNotExist(err) {
			complete = false
			w.logger.Debug("failed to add file watcher", slog.String("path", path), slog.String("error", err.Error()))
		} else if err == nil && !wasKnown {
			known[cleaned] = struct{}{}
			added = true
		}
		return nil
	})
	if !w.isClosed() {
		if walkErr != nil || !complete {
			if w.failureReason() != "root_changed" {
				w.markFailure("coverage_incomplete")
			}
		} else if w.failureReason() != "root_changed" {
			if w.failureReason() != "" {
				w.enqueueResync()
			}
			w.markCoverageHealthy()
		}
	}
	return added
}

// discoverAndWatchSubtree closes the recursive inotify race. It streams
// existing descendants to emit while registering each directory before reading
// its children. Once emit reaches its cap, the walk keeps only watcher coverage;
// the queued resync supplies authoritative state without unbounded allocations.
func (w *Watcher) discoverAndWatchSubtree(root string, emit func(Change) bool) {
	cleanedRoot := filepath.Clean(root)
	emitting := true
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d == nil {
			return nil
		}
		rel, ok := w.relative(path)
		if !ok {
			return nil
		}
		if rel != "" && w.isIgnored(rel) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if err := w.watcher.Add(path); err != nil && !os.IsNotExist(err) {
				w.markFailure("coverage_incomplete")
				w.logger.Debug("failed to add file watcher", slog.String("path", path), slog.String("error", err.Error()))
			}
		}
		if filepath.Clean(path) == cleanedRoot {
			return nil
		}
		if !emitting {
			return nil
		}
		info, infoErr := d.Info()
		if infoErr != nil {
			return nil
		}
		if !isWatchableNode(info.Mode()) {
			return nil
		}
		emitting = emit(Change{
			Path:     rel,
			Kind:     "create",
			NodeType: nodeTypeFor(info),
			Size:     info.Size(),
			MtimeMs:  info.ModTime().UnixMilli(),
		})
		return nil
	})
}

func (w *Watcher) relative(path string) (string, bool) {
	return relativeToRoot(w.root, path)
}

func (w *Watcher) isIgnored(rel string) bool {
	return isIgnoredPath(rel, w.ignored)
}

// enqueue returns false once callers should stop materializing individual
// changes and rely on the queued resync instead.
func (w *Watcher) enqueue(change Change) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	select {
	case <-w.closed:
		return false
	default:
	}
	if w.resync {
		w.ensureTimerLocked()
		return false
	}
	previous, exists := w.pending[change.Path]
	if !exists && len(w.pending) >= maxBatchSize {
		w.pending = make(map[string]Change)
		w.resync = true
		w.ensureTimerLocked()
		return false
	}
	if exists {
		change = mergeChange(previous, change)
	}
	w.pending[change.Path] = change
	w.ensureTimerLocked()
	return true
}

func (w *Watcher) enqueueResync() {
	w.mu.Lock()
	defer w.mu.Unlock()
	select {
	case <-w.closed:
		return
	default:
	}
	w.pending = make(map[string]Change)
	w.resync = true
	w.ensureTimerLocked()
}

func (w *Watcher) ensureTimerLocked() {
	if w.timer != nil {
		return
	}
	w.timer = time.AfterFunc(debounceWindow, w.flush)
}

func (w *Watcher) flush() {
	w.flushMu.Lock()
	defer w.flushMu.Unlock()
	select {
	case <-w.closed:
		return
	default:
	}
	w.mu.Lock()
	changes := make([]Change, 0, len(w.pending))
	for _, change := range w.pending {
		changes = append(changes, change)
	}
	resync := w.resync
	w.pending = make(map[string]Change)
	w.resync = false
	w.timer = nil
	if !resync && len(changes) == 0 {
		w.mu.Unlock()
		return
	}
	w.seq++
	seq := w.seq
	w.mu.Unlock()

	sort.Slice(changes, func(i, j int) bool {
		return changes[i].Path < changes[j].Path
	})
	w.handler(Batch{Seq: seq, Resync: resync, Changes: changes})
}

func mergeChange(a, b Change) Change {
	if b.Kind == "delete" {
		return b
	}
	if a.Kind == "delete" {
		b.Kind = "create"
		return b
	}
	if a.Kind == "create" {
		b.Kind = "create"
		return b
	}
	return b
}
