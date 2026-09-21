package search

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/filewatch"
)

const (
	readyTimeout             = 15 * time.Second
	requestTimeout           = 10 * time.Second
	restartDelay             = 2 * time.Second
	downloadRetryDelay       = time.Minute
	maxResponseBytes         = 2 * 1024 * 1024
	commandBufferSize        = 128
	activationRetryBaseDelay = 500 * time.Millisecond
	activationRetryMaxDelay  = 10 * time.Second
	reconcileRetryBaseDelay  = 500 * time.Millisecond
	reconcileRetryMaxDelay   = 10 * time.Second
)

type QueryInput struct {
	Literals   []string
	PathPrefix string
	Glob       string
	Limit      int
}

type QueryResult struct {
	Matches       []string `json:"matches"`
	Truncated     bool     `json:"truncated"`
	State         string   `json:"state"`
	IndexFamily   string   `json:"indexFamily"`
	SchemaVersion int      `json:"schemaVersion"`
	Coverage      string   `json:"coverage"`
}

type indexChange struct {
	Path     string `json:"path"`
	OldPath  string `json:"oldPath,omitempty"`
	Kind     string `json:"kind"`
	NodeType string `json:"nodeType,omitempty"`
}

type command struct {
	activate  bool
	reconcile bool
	batch     *filewatch.Batch
}

type Manager struct {
	cfg        env.Config
	logger     *slog.Logger
	client     *client
	downloader *downloader
	binary     string

	enabled               atomic.Bool
	processReady          atomic.Bool
	started               atomic.Bool
	closed                atomic.Bool
	reconcileRetryPending atomic.Bool
	reconcileRetryAttempt atomic.Int32

	commands    chan command
	control     chan command
	cancel      context.CancelFunc
	commandDone chan struct{}
	processDone chan struct{}
	closeMu     sync.Once
}

// NewManager enables optional workspace search for cloud sandboxes. A local or
// explicitly configured binary wins; otherwise the supervisor downloads the
// latest checksum-verified release without blocking the main sandbox runtime.
func NewManager(cfg env.Config, logger *slog.Logger) *Manager {
	binary := resolveBinary(cfg.SearchBinaryPath)
	manager := &Manager{
		cfg:         cfg,
		logger:      logger,
		binary:      binary,
		client:      newClient(cfg.SearchSocketPath),
		downloader:  newDownloader(),
		commands:    make(chan command, commandBufferSize),
		control:     make(chan command, 8),
		commandDone: make(chan struct{}),
		processDone: make(chan struct{}),
	}
	if cfg.SearchEnabled && !cfg.IsLocal() {
		manager.enabled.Store(true)
	}
	return manager
}

func (m *Manager) Start() {
	if !m.Enabled() || !m.started.CompareAndSwap(false, true) {
		m.logger.Debug("search index disabled", slog.String("reason", "feature disabled or local mode"))
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.logger.Info("search index enabled",
		slog.String("binary", m.binary),
		slog.String("version", m.cfg.SearchVersion),
		slog.String("indexDir", m.cfg.SearchIndexDir),
		slog.String("socket", m.cfg.SearchSocketPath),
	)
	go m.supervise(ctx)
	go m.commandLoop(ctx)
}

func (m *Manager) Enabled() bool {
	return m.enabled.Load()
}

// ProcessReady reports whether the search process is reachable. Index
// completeness is reported separately by QueryResult.State and Coverage.
func (m *Manager) ProcessReady() bool {
	return m.processReady.Load()
}

// Activate opens or reconciles the persistent index after workspace.Prepare
// has succeeded. A full build is only selected by the search process when no
// usable snapshot exists.
func (m *Manager) Activate() {
	if !m.Enabled() || m.closed.Load() {
		return
	}
	m.enqueueControl(command{activate: true})
}

// Apply forwards an already debounced filewatch batch. The Rust process owns
// the second-level debounce and commit policy.
func (m *Manager) Apply(batch filewatch.Batch) {
	if !m.Enabled() || m.closed.Load() {
		return
	}
	m.enqueue(command{batch: &batch})
}

func (m *Manager) Query(ctx context.Context, input QueryInput) (QueryResult, error) {
	if !m.Enabled() {
		return QueryResult{}, fmt.Errorf("search index is unavailable")
	}
	payload := queryRequest{
		Literals:   input.Literals,
		PathPrefix: input.PathPrefix,
		Glob:       input.Glob,
		Limit:      input.Limit,
	}
	var result QueryResult
	if err := m.client.doJSON(ctx, http.MethodPost, "/query", payload, &result); err != nil {
		return QueryResult{}, err
	}
	return result, nil
}

func (m *Manager) Close() {
	m.closeMu.Do(func() {
		m.closed.Store(true)
		if m.cancel != nil {
			m.cancel()
		}
		if m.started.Load() {
			<-m.commandDone
			<-m.processDone
		}
	})
}

func (m *Manager) enqueue(value command) {
	select {
	case m.commands <- value:
	default:
		// A dropped incremental batch is repaired by a metadata reconcile. The
		// reconcile compares the persistent snapshot with the current workspace.
		m.logger.Warn("search command queue full; requesting reconcile")
		m.enqueueControl(command{reconcile: true})
	}
}

func (m *Manager) enqueueControl(value command) {
	select {
	case m.control <- value:
	default:
		m.logger.Warn("search control queue full; dropping duplicate control command")
	}
}

func (m *Manager) commandLoop(ctx context.Context) {
	defer close(m.commandDone)
	activated := false
	activationAttempt := 0
	for {
		var value command
		select {
		case <-ctx.Done():
			return
		case value = <-m.control:
		default:
			select {
			case <-ctx.Done():
				return
			case value = <-m.control:
			case value = <-m.commands:
			}
		}
		if value.activate {
			if activated {
				continue
			}
			if err := m.activate(ctx); err != nil {
				m.logger.Warn("search reconcile was not accepted",
					slog.String("error", err.Error()),
					slog.Int("attempt", activationAttempt+1),
				)
				m.scheduleActivationRetry(ctx, activationAttempt)
				activationAttempt++
				continue
			}
			activated = true
			activationAttempt = 0
			continue
		}
		if value.reconcile {
			if !activated {
				continue
			}
			if err := m.requestReconcile(ctx); err != nil {
				m.processReady.Store(false)
				m.logger.Warn("search reconcile failed", slog.String("error", err.Error()))
				m.scheduleReconcileRetry(ctx)
			}
			continue
		}
		if value.batch == nil || !activated {
			continue
		}
		if err := m.sendBatch(ctx, *value.batch); err != nil {
			m.processReady.Store(false)
			m.logger.Warn("search incremental update failed", slog.String("error", err.Error()))
			m.scheduleReconcileRetry(ctx)
		}
	}
}

func (m *Manager) activate(ctx context.Context) error {
	return m.requestReconcile(ctx)
}

func (m *Manager) scheduleActivationRetry(ctx context.Context, attempt int) {
	delay := activationRetryBaseDelay
	for i := 0; i < attempt && delay < activationRetryMaxDelay; i++ {
		delay *= 2
	}
	if delay > activationRetryMaxDelay {
		delay = activationRetryMaxDelay
	}
	go func() {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
		case <-timer.C:
			m.enqueueControl(command{activate: true})
		}
	}()
}

func (m *Manager) scheduleReconcileRetry(ctx context.Context) {
	if !m.reconcileRetryPending.CompareAndSwap(false, true) {
		return
	}
	attempt := int(m.reconcileRetryAttempt.Load())
	delay := reconcileRetryBaseDelay
	for i := 0; i < attempt && delay < reconcileRetryMaxDelay; i++ {
		delay *= 2
	}
	if delay > reconcileRetryMaxDelay {
		delay = reconcileRetryMaxDelay
	}
	m.reconcileRetryAttempt.Add(1)
	go func() {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			m.reconcileRetryPending.Store(false)
		case <-timer.C:
			m.reconcileRetryPending.Store(false)
			m.enqueueControl(command{reconcile: true})
		}
	}()
}

func (m *Manager) requestReconcile(ctx context.Context) error {
	deadline := time.Now().Add(readyTimeout)
	for time.Now().Before(deadline) {
		if err := m.client.health(ctx); err == nil {
			m.processReady.Store(true)
			if err := m.client.reconcile(ctx); err != nil {
				return err
			}
			m.reconcileRetryAttempt.Store(0)
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
	}
	return fmt.Errorf("search process did not become ready within %s", readyTimeout)
}

func (m *Manager) sendBatch(ctx context.Context, batch filewatch.Batch) error {
	if batch.Resync {
		return m.client.reconcile(ctx)
	}
	changes := make([]indexChange, 0, len(batch.Changes))
	for _, change := range batch.Changes {
		changes = append(changes, indexChange{
			Path:     change.Path,
			OldPath:  change.OldPath,
			Kind:     change.Kind,
			NodeType: change.NodeType,
		})
	}
	return m.client.update(ctx, changes)
}

func (m *Manager) supervise(ctx context.Context) {
	defer close(m.processDone)
	for {
		m.processReady.Store(false)
		if m.binary == "" {
			binary, err := m.downloader.ensure(ctx, m.cfg, m.logger)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				m.logger.Warn("search binary unavailable; feature remains disabled until retry",
					slog.String("error", err.Error()),
					slog.Duration("retryAfter", downloadRetryDelay),
				)
				select {
				case <-ctx.Done():
					return
				case <-time.After(downloadRetryDelay):
					continue
				}
			}
			m.binary = binary
		}
		if err := m.runProcess(ctx); err != nil && ctx.Err() == nil {
			m.logger.Warn("search process exited", slog.String("error", err.Error()))
		}
		if ctx.Err() != nil {
			return
		}
		// A restarted process may have opened a recovered or incomplete index.
		// Reconcile restores the startup guarantee and only falls back to a full
		// build when the persistent snapshot is unavailable.
		m.enqueueControl(command{reconcile: true})
		select {
		case <-ctx.Done():
			return
		case <-time.After(restartDelay):
		}
	}
}

func processArgs(cfg env.Config) []string {
	args := []string{
		"serve",
		"--workspace", cfg.WorkspaceDir,
		"--index", cfg.SearchIndexDir,
		"--socket", cfg.SearchSocketPath,
	}
	for _, pattern := range filewatch.IgnorePatterns() {
		args = append(args, "--ignore="+pattern)
	}
	return args
}

func (m *Manager) runProcess(ctx context.Context) error {
	if m.binary == "" {
		return fmt.Errorf("search binary is unavailable")
	}
	cmd := exec.CommandContext(ctx, m.binary, processArgs(m.cfg)...)
	cmd.Stdout = &logWriter{logger: m.logger, level: slog.LevelInfo, prefix: "search"}
	cmd.Stderr = &logWriter{logger: m.logger, level: slog.LevelWarn, prefix: "search"}
	if err := cmd.Run(); err != nil {
		m.processReady.Store(false)
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
	m.processReady.Store(false)
	return nil
}

type queryRequest struct {
	Literals   []string `json:"literals"`
	PathPrefix string   `json:"pathPrefix,omitempty"`
	Glob       string   `json:"glob,omitempty"`
	Limit      int      `json:"limit,omitempty"`
}

type client struct {
	http   *http.Client
	socket string
}

func newClient(socket string) *client {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
	}
	return &client{
		http:   &http.Client{Transport: transport, Timeout: requestTimeout},
		socket: socket,
	}
}

func (c *client) health(ctx context.Context) error {
	return c.doJSON(ctx, http.MethodGet, "/healthz", nil, nil)
}

func (c *client) reconcile(ctx context.Context) error {
	return c.doJSON(ctx, http.MethodPost, "/index/reconcile", map[string]any{}, nil)
}

func (c *client) update(ctx context.Context, changes []indexChange) error {
	return c.doJSON(ctx, http.MethodPost, "/index/update", map[string]any{"changes": changes}, nil)
}

func (c *client) doJSON(ctx context.Context, method, path string, payload any, result any) error {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, "http://cohub-search"+path, body)
	if err != nil {
		return err
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("search HTTP %s: %s", response.Status, string(responseBody))
	}
	if result != nil && len(responseBody) > 0 {
		if err := json.Unmarshal(responseBody, result); err != nil {
			return fmt.Errorf("decode search response: %w", err)
		}
	}
	return nil
}

type logWriter struct {
	logger *slog.Logger
	level  slog.Level
	prefix string
}

func (w *logWriter) Write(data []byte) (int, error) {
	message := string(bytes.TrimSpace(data))
	if message != "" {
		w.logger.Log(context.Background(), w.level, message, slog.String("component", w.prefix))
	}
	return len(data), nil
}

func resolveBinary(configured string) string {
	candidates := []string{configured, "/opt/cohub/bin/cohub-search", "/usr/local/bin/cohub-search", "/tmp/cohub-search"}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		candidate = filepath.Clean(candidate)
		info, err := os.Stat(candidate)
		if err == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0 {
			return candidate
		}
	}
	return ""
}
