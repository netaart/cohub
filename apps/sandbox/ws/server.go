package ws

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/process"
	"github.com/cohub/apps/sandbox/protocol"
	"github.com/cohub/apps/sandbox/report"
	"github.com/cohub/apps/sandbox/rpc"
)

type prepareState interface {
	Get() (status string, errMsg string)
	GetSetup() *protocol.SandboxSetupInfo
}

type Server struct {
	cfg            env.Config
	dispatcher     *rpc.Dispatcher
	processManager *process.Manager
	reporter       *report.Client
	prepareState   prepareState
	hostname       string
	logger         *slog.Logger
	startedAt      time.Time

	mu                      sync.RWMutex
	sessionsByID            map[string]*connectionSession
	sessionIDsByIdentity    map[string]map[string]struct{}
	cleanupTimersByIdentity map[string]*time.Timer
	fsResyncOnAttach        bool
	searchEnabled           bool

	healthMu                 sync.Mutex
	cachedZombieProcessCount int
	cachedZombieObservedAt   time.Time
	lastSelfHealObservedAt   time.Time
	zombieSelfHealTicks      int
	mountSelfHealTriggered   bool
	recovering               bool
}

const identityProcessCleanupGrace = 30 * time.Second

func NewServer(
	cfg env.Config,
	dispatcher *rpc.Dispatcher,
	processManager *process.Manager,
	reporter *report.Client,
	prepareState prepareState,
	hostname string,
	logger *slog.Logger,
) *Server {
	s := &Server{
		cfg:                     cfg,
		dispatcher:              dispatcher,
		processManager:          processManager,
		reporter:                reporter,
		prepareState:            prepareState,
		hostname:                hostname,
		logger:                  logger,
		startedAt:               time.Now(),
		sessionsByID:            make(map[string]*connectionSession),
		sessionIDsByIdentity:    make(map[string]map[string]struct{}),
		cleanupTimersByIdentity: make(map[string]*time.Timer),
	}
	dispatcher.SetRouter(s)
	return s
}

func (s *Server) SetFSResyncOnAttach(enabled bool) {
	s.mu.Lock()
	s.fsResyncOnAttach = enabled
	s.mu.Unlock()
}

func (s *Server) SetSearchEnabled(enabled bool) {
	s.mu.Lock()
	s.searchEnabled = enabled
	s.mu.Unlock()
}

func (s *Server) isSearchEnabled() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.searchEnabled
}

func (s *Server) shouldResyncFSOnAttach() bool {
	s.mu.RLock()
	enabled := s.fsResyncOnAttach
	s.mu.RUnlock()
	return enabled
}

func (s *Server) Run() error {
	if len(s.cfg.ControlPublicKey) != ed25519.PublicKeySize {
		return fmt.Errorf("sandbox control public key is required")
	}
	addr := fmt.Sprintf("%s:%d", env.DefaultSandboxWSHost, env.DefaultSandboxWSPort)
	s.logger.Info("sandbox ws server listening", slog.String("addr", addr))
	return http.ListenAndServe(addr, s.Handler())
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/sandbox", s.handleSandbox)
	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.HandleFunc("/readyz", s.handleReadyz)
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("Not found"))
	})

	return mux
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func (s *Server) handleReadyz(w http.ResponseWriter, _ *http.Request) {
	s.healthMu.Lock()
	recovering := s.recovering
	s.healthMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if recovering {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"ok":false,"status":"recovering"}`))
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"ok":true}`))
}

const wsReadLimit = 50 * 1024 * 1024 // 50MB per websocket message

func (s *Server) handleSandbox(w http.ResponseWriter, r *http.Request) {
	identity, err := authenticateControl(r, s.cfg.ControlPublicKey, s.cfg.SpaceID)
	if err != nil {
		w.Header().Set("WWW-Authenticate", "Bearer")
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		s.logger.Error("failed to accept websocket", slog.String("error", err.Error()))
		return
	}
	conn.SetReadLimit(wsReadLimit)
	s.serveSession(r.Context(), conn, r.RemoteAddr, identity)
}

// ServeDialedConn drives one protocol session over a connection the sandbox
// itself dialed out (local mode via the gateway relay). It mirrors
// handleSandbox for the dial-out direction and blocks until the session ends.
func (s *Server) ServeDialedConn(ctx context.Context, conn *websocket.Conn, remote string) {
	conn.SetReadLimit(wsReadLimit)
	s.serveSession(ctx, conn, remote, "")
}

func (s *Server) broadcastAttached(message interface{}, warnMessage string) {
	s.mu.RLock()
	targets := make([]*connectionSession, 0, len(s.sessionsByID))
	for _, session := range s.sessionsByID {
		if session.attached {
			targets = append(targets, session)
		}
	}
	s.mu.RUnlock()

	for _, session := range targets {
		if err := s.sendToConnection(session, message); err != nil {
			s.logger.Warn(warnMessage, slog.String("connectionId", session.id), slog.String("identity", session.identity), slog.String("error", err.Error()))
		}
	}
}

func (s *Server) fsChangedMessage(payload protocol.FSChangedPayload) protocol.FSChanged {
	return protocol.FSChanged{
		BaseMessage: protocol.BaseMessage{
			Version:   protocol.Version,
			Type:      "fs.changed",
			SpaceID:   s.cfg.SpaceID,
			SandboxID: s.hostname,
			Timestamp: time.Now().UnixMilli(),
		},
		Payload: payload,
	}
}

func (s *Server) sendFSResync(session *connectionSession) error {
	return s.sendToConnection(session, s.fsChangedMessage(protocol.FSChangedPayload{
		Seq:     0,
		Resync:  true,
		Changes: []protocol.FSChange{},
	}))
}

func (s *Server) BroadcastFSChanged(payload protocol.FSChangedPayload) {
	s.broadcastAttached(s.fsChangedMessage(payload), "failed to enqueue fs.changed")
}

func (s *Server) BroadcastPortsChanged(payload protocol.PortsChangedPayload) {
	message := protocol.PortsChanged{
		BaseMessage: protocol.BaseMessage{
			Version:   protocol.Version,
			Type:      "ports.changed",
			SpaceID:   s.cfg.SpaceID,
			SandboxID: s.hostname,
			Timestamp: time.Now().UnixMilli(),
		},
		Payload: payload,
	}

	s.broadcastAttached(message, "failed to enqueue ports.changed")
}

func (s *Server) addSession(session *connectionSession) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessionsByID[session.id] = session
}

func (s *Server) removeSession(session *connectionSession) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessionsByID, session.id)
	if session.identity == "" {
		return
	}
	ids := s.sessionIDsByIdentity[session.identity]
	if ids == nil {
		return
	}
	delete(ids, session.id)
	if len(ids) > 0 {
		return
	}
	delete(s.sessionIDsByIdentity, session.identity)
	if timer := s.cleanupTimersByIdentity[session.identity]; timer != nil {
		timer.Stop()
	}
	identity := session.identity
	s.cleanupTimersByIdentity[identity] = time.AfterFunc(identityProcessCleanupGrace, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		ids := s.sessionIDsByIdentity[identity]
		if len(ids) > 0 {
			delete(s.cleanupTimersByIdentity, identity)
			return
		}
		s.logger.Info("cleaning up processes for disconnected identity", slog.String("identity", identity), slog.Duration("grace", identityProcessCleanupGrace))
		s.processManager.AbortByIdentity(identity)
		delete(s.cleanupTimersByIdentity, identity)
	})
}

func (s *Server) attachIdentity(session *connectionSession, identity string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if session.identity != "" {
		if ids := s.sessionIDsByIdentity[session.identity]; ids != nil {
			delete(ids, session.id)
			if len(ids) == 0 {
				delete(s.sessionIDsByIdentity, session.identity)
			}
		}
	}
	if timer := s.cleanupTimersByIdentity[identity]; timer != nil {
		timer.Stop()
		delete(s.cleanupTimersByIdentity, identity)
	}
	session.identity = identity
	session.attached = true
	ids := s.sessionIDsByIdentity[identity]
	if ids == nil {
		ids = make(map[string]struct{})
		s.sessionIDsByIdentity[identity] = ids
	}
	ids[session.id] = struct{}{}
}

func (s *Server) SendToIdentity(identity string, v interface{}) error {
	s.mu.RLock()
	ids := s.sessionIDsByIdentity[identity]
	targets := make([]*connectionSession, 0, len(ids))
	for sessionID := range ids {
		if session, ok := s.sessionsByID[sessionID]; ok {
			targets = append(targets, session)
		}
	}
	s.mu.RUnlock()
	if len(targets) == 0 {
		return fmt.Errorf("no active session for identity %q", identity)
	}

	payload, err := json.Marshal(v)
	if err != nil {
		return err
	}

	var sendErrs []error
	sent := 0
	for _, session := range targets {
		if err := enqueuePayload(session, payload); err != nil {
			s.logger.Warn("failed to enqueue identity payload", slog.String("identity", identity), slog.String("connectionId", session.id), slog.String("error", err.Error()))
			session.cancel()
			sendErrs = append(sendErrs, fmt.Errorf("connection %s: %w", session.id, err))
			continue
		}
		sent++
	}
	if sent > 0 {
		return nil
	}
	return errors.Join(sendErrs...)
}

func (s *Server) attachedSessionCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	count := 0
	for _, ids := range s.sessionIDsByIdentity {
		count += len(ids)
	}
	return count
}

const zombieScanInterval = 15 * time.Second

func (s *Server) getZombieProcessCount() (count int, observedAt time.Time) {
	s.healthMu.Lock()
	defer s.healthMu.Unlock()
	now := time.Now()
	if !s.cachedZombieObservedAt.IsZero() && now.Sub(s.cachedZombieObservedAt) < zombieScanInterval {
		return s.cachedZombieProcessCount, s.cachedZombieObservedAt
	}
	count = scanZombieProcessCount()
	observedAt = now
	s.cachedZombieProcessCount = count
	s.cachedZombieObservedAt = observedAt
	return count, observedAt
}

func scanZombieProcessCount() int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	count := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, err := strconv.Atoi(entry.Name()); err != nil {
			continue
		}
		statusPath := "/proc/" + entry.Name() + "/status"
		data, err := os.ReadFile(statusPath)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "State:") && strings.Contains(line, "Z") {
				count++
				break
			}
		}
	}
	return count
}

func (s *Server) maybeSelfHealOnZombies(zombieCount int, observedAt time.Time, attachedSessions int, activeProcesses int) {
	s.healthMu.Lock()
	defer s.healthMu.Unlock()
	threshold := s.cfg.ZombieSelfHealThreshold
	if threshold <= 0 {
		s.zombieSelfHealTicks = 0
		s.lastSelfHealObservedAt = time.Time{}
		return
	}
	if zombieCount < threshold || attachedSessions > 0 || activeProcesses > 0 {
		s.zombieSelfHealTicks = 0
		s.lastSelfHealObservedAt = time.Time{}
		return
	}
	if !observedAt.After(s.lastSelfHealObservedAt) {
		return
	}
	s.lastSelfHealObservedAt = observedAt
	s.zombieSelfHealTicks++
	if s.zombieSelfHealTicks < s.cfg.ZombieSelfHealConsecutiveTicks {
		return
	}
	s.logger.Warn("sandbox self-heal triggered due to zombie accumulation",
		slog.Int("zombieCount", zombieCount),
		slog.Int("threshold", threshold),
		slog.Int("attachedSessions", attachedSessions),
		slog.Int("activeProcesses", activeProcesses),
		slog.Int("consecutiveTicks", s.zombieSelfHealTicks),
	)
	s.selfTerminate("zombie accumulation")
}

func (s *Server) maybeSelfHealOnStaleMount(request protocol.RPCRequest, failed protocol.RPCFailed) {
	// Stale-mount self-heal is a cloud (NFS-backed) concern; local sandboxes
	// have no reporter and run on the user's real filesystem.
	if s.reporter == nil {
		return
	}
	message := strings.ToLower(failed.Error.Message)
	if !strings.Contains(message, "stale file handle") && !strings.Contains(message, "stale nfs file handle") {
		return
	}

	criticalRoots := []string{
		s.cfg.WorkspaceDir,
		s.cfg.PlatformAgentsDir,
		s.cfg.UserAgentsDir,
		"/sessions",
		"/public",
	}
	matchedRoot := ""
	for _, root := range criticalRoots {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		if strings.Contains(message, strings.ToLower(root)) {
			matchedRoot = root
			break
		}
	}
	if matchedRoot == "" {
		return
	}

	s.healthMu.Lock()
	if s.mountSelfHealTriggered {
		s.healthMu.Unlock()
		return
	}
	s.mountSelfHealTriggered = true
	s.recovering = true
	s.healthMu.Unlock()

	s.logger.Warn("sandbox recovery requested due to stale mount",
		slog.String("method", request.Method),
		slog.String("requestId", request.RequestID),
		slog.String("path", matchedRoot),
		slog.String("error", failed.Error.Message),
	)
	go func() {
		for attempt := 1; attempt <= 3; attempt++ {
			if err := s.reporter.Report(report.Payload{
				Status: "error",
				Meta: map[string]interface{}{
					"errorClass":          "stale_mount",
					"requiresPodRecreate": true,
					"mountPath":           matchedRoot,
					"lastError":           failed.Error.Message,
					"recoverySource":      "sandbox",
				},
			}); err != nil {
				s.logger.Warn("failed to report stale mount recovery request", slog.Int("attempt", attempt), slog.String("error", err.Error()))
				time.Sleep(time.Duration(attempt) * time.Second)
				continue
			}
			return
		}
		s.logger.Warn("stale mount recovery report failed; falling back to self terminate")
		s.selfTerminate("stale mount report failed")
	}()
}

func (s *Server) selfTerminate(reason string) {
	if err := syscall.Kill(syscall.Getpid(), syscall.SIGTERM); err != nil {
		s.logger.Error("failed to signal sandbox for self-heal shutdown", slog.String("reason", reason), slog.String("error", err.Error()))
		os.Exit(1)
	}
}
