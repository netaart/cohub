package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/protocol"
)

// connectionSession is one attached peer (agent or relay) talking the
// agent-sandbox protocol over a websocket, regardless of how the underlying
// connection was established (accepted listener conn or dialed-out conn).
type connectionSession struct {
	id          string
	spaceID     string
	identity    string
	attached    bool
	ctx         context.Context
	cancel      context.CancelFunc
	conn        *websocket.Conn
	sendCh      chan []byte
	connectedAt time.Time
}

// serveSession owns the full lifecycle of a single protocol connection:
// registration, write/heartbeat loops, and the read/dispatch loop. It blocks
// until the connection is closed and always cleans up after itself.
func (s *Server) serveSession(parentCtx context.Context, conn *websocket.Conn, remote string) {
	ctx, cancel := context.WithCancel(parentCtx)
	session := &connectionSession{
		id:          uuid.NewString(),
		spaceID:     s.cfg.SpaceID,
		ctx:         ctx,
		cancel:      cancel,
		conn:        conn,
		sendCh:      make(chan []byte, 256),
		connectedAt: time.Now(),
	}
	defer cancel()
	defer conn.Close(websocket.StatusNormalClosure, "closing")
	defer s.removeSession(session)

	s.addSession(session)
	s.logger.Info("agent connected", slog.String("remote", remote), slog.String("connectionId", session.id))
	go s.writeLoop(session)
	go s.heartbeatLoop(session)

	if err := s.sendHeartbeat(session, true); err != nil {
		s.logger.Error("failed to send initial sandbox.heartbeat", slog.String("error", err.Error()))
		return
	}

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			s.logger.Info("agent connection closed", slog.String("connectionId", session.id), slog.String("identity", session.identity), slog.String("error", err.Error()))
			return
		}

		var envelope protocol.IncomingEnvelope
		if err := json.Unmarshal(data, &envelope); err != nil {
			s.logger.Warn("failed to parse incoming envelope", slog.String("connectionId", session.id), slog.String("error", err.Error()))
			continue
		}

		switch envelope.Type {
		case "session.attach":
			var attach protocol.SessionAttach
			if err := json.Unmarshal(data, &attach); err != nil {
				s.logger.Warn("failed to parse session.attach", slog.String("connectionId", session.id), slog.String("error", err.Error()))
				continue
			}
			s.handleSessionAttach(session, attach)
		case "rpc.request":
			if !session.attached || session.identity == "" {
				s.logger.Warn("rpc.request before attach", slog.String("connectionId", session.id))
				continue
			}
			var request protocol.RPCRequest
			if err := json.Unmarshal(data, &request); err != nil {
				s.logger.Warn("failed to parse rpc.request", slog.String("connectionId", session.id), slog.String("error", err.Error()))
				continue
			}
			s.logger.Debug("rpc:request received", slog.String("connectionId", session.id), slog.String("identity", session.identity), slog.String("method", request.Method), slog.String("requestId", request.RequestID))
			go s.handleRPCRequest(session, request)
		default:
			s.logger.Warn("unknown incoming message type", slog.String("connectionId", session.id), slog.String("type", envelope.Type))
		}
	}
}

func (s *Server) handleSessionAttach(session *connectionSession, attach protocol.SessionAttach) {
	identity := attach.Identity
	if identity == "" {
		s.logger.Warn("session.attach missing identity", slog.String("connectionId", session.id))
		return
	}
	s.attachIdentity(session, identity)
	s.logger.Info("session attached", slog.String("connectionId", session.id), slog.String("identity", identity))
	payload := protocol.SessionAttachOK{
		BaseMessage: protocol.BaseMessage{
			Version:   protocol.Version,
			Type:      "session.attach.ok",
			SpaceID:   s.cfg.SpaceID,
			SandboxID: s.hostname,
			Timestamp: time.Now().UnixMilli(),
		},
		RequestID:    attach.RequestID,
		ConnectionID: session.id,
		Identity:     identity,
	}
	if err := s.sendToConnection(session, payload); err != nil {
		s.logger.Warn("failed to send session.attach.ok", slog.String("connectionId", session.id), slog.String("identity", identity), slog.String("error", err.Error()))
		return
	}
	if s.shouldResyncFSOnAttach() {
		if err := s.sendFSResync(session); err != nil {
			s.logger.Warn("failed to send fs resync after attach", slog.String("connectionId", session.id), slog.String("identity", identity), slog.String("error", err.Error()))
		}
	}
}

func (s *Server) writeLoop(session *connectionSession) {
	for {
		select {
		case <-session.ctx.Done():
			return
		case payload := <-session.sendCh:
			if err := session.conn.Write(session.ctx, websocket.MessageText, payload); err != nil {
				s.logger.Warn("failed to write websocket message", slog.String("connectionId", session.id), slog.String("identity", session.identity), slog.String("error", err.Error()))
				session.cancel()
				return
			}
		}
	}
}

func (s *Server) handleRPCRequest(session *connectionSession, request protocol.RPCRequest) {
	accepted, response := s.dispatcher.Handle(request, session.identity)
	if err := s.sendToConnection(session, accepted); err != nil {
		s.logger.Warn("failed to send rpc.accepted", slog.String("connectionId", session.id), slog.String("identity", session.identity), slog.String("requestId", request.RequestID), slog.String("method", request.Method), slog.String("error", err.Error()))
		return
	}
	if response == nil {
		return
	}
	if failed, ok := response.(protocol.RPCFailed); ok {
		s.maybeSelfHealOnStaleMount(request, failed)
	}
	if err := s.SendToIdentity(session.identity, response); err != nil {
		s.logger.Warn("failed to send rpc result to identity", slog.String("identity", session.identity), slog.String("requestId", request.RequestID), slog.String("method", request.Method), slog.String("error", err.Error()))
	}
}

func (s *Server) sendToConnection(session *connectionSession, v interface{}) error {
	payload, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return enqueuePayload(session, payload)
}

func (s *Server) sendHeartbeat(session *connectionSession, includeSnapshot bool) error {
	prepareStatus, _ := s.prepareState.Get()
	attachedSessions := s.attachedSessionCount()
	processStats := s.processManager.Stats()
	observedZombieCount, observedAt := s.getZombieProcessCount()
	setupInfo := s.prepareState.GetSetup()
	message := protocol.SandboxHeartbeat{
		BaseMessage: protocol.BaseMessage{
			Version:   protocol.Version,
			Type:      "sandbox.heartbeat",
			SpaceID:   s.cfg.SpaceID,
			SandboxID: s.hostname,
			Timestamp: time.Now().UnixMilli(),
		},
		Status: prepareStatus,
		Metadata: &protocol.SandboxMetadata{
			Hostname:     s.hostname,
			ImageVersion: s.cfg.ImageVersion,
			StartedAt:    s.startedAt.UTC().Format(time.RFC3339),
			Process: &protocol.SandboxProcessStats{
				ActiveProcesses:        processStats.ActiveProcesses,
				StartedTotal:           processStats.StartedTotal,
				CompletedTotal:         processStats.CompletedTotal,
				AbortedTotal:           processStats.AbortedTotal,
				TimedOutTotal:          processStats.TimedOutTotal,
				IdentityCleanupTotal:   processStats.IdentityCleanupTotal,
				ForceKilledTotal:       processStats.ForceKilledTotal,
				TerminateFailuresTotal: processStats.TerminateFailuresTotal,
			},
			Health: &protocol.SandboxHealthStats{
				ZombieProcessCount: observedZombieCount,
				AttachedSessions:   attachedSessions,
			},
			Setup: setupInfo,
		},
	}
	if includeSnapshot {
		message.Capabilities = protocol.SandboxCapabilities{
			FSRead:             true,
			FSWrite:            true,
			FSWriteDisposition: true,
			FSWriteExpected:    true,
			FSWriteSource:      true,
			FSEdit:             true,
			FSMkdir:            true,
			FSStat:             true,
			FSLs:               true,
			FSTree:             true,
			FSFind:             true,
			FSGrep:             true,
			FSSearch:           s.isSearchEnabled(),
			FSPathSearch:       s.isSearchEnabled(),
			ProcessStart:       true,
			ProcessStartArgv:   true,
			ProcessAbort:       true,
		}
		message.Filesystem = &protocol.SandboxFilesystem{
			DefaultCwd: s.cfg.WorkspaceDir,
			Mode:       "host-like",
			Notes: []string{
				"sandbox paths follow host-like semantics; cwd defaults to /workspace",
				"/configs/platform/.agents is mounted read-only for platform skills",
				"/configs/user/.agents is mounted read-only for user skills and setup.sh",
				"if /configs/user/.agents/setup.sh exists, sandbox runs it on startup",
			},
			Roots: []protocol.SandboxFilesystemRoot{
				{Path: s.cfg.WorkspaceDir, Writable: true, Label: "cwd"},
				{Path: s.cfg.PlatformAgentsDir, Writable: false, Label: "platform-skills"},
				{Path: s.cfg.UserAgentsDir, Writable: false, Label: "user-agents"},
				{Path: "/tmp", Writable: true, Label: "tmp"},
			},
		}
	}
	s.maybeSelfHealOnZombies(observedZombieCount, observedAt, attachedSessions, processStats.ActiveProcesses)
	return s.sendToConnection(session, message)
}

func (s *Server) heartbeatLoop(session *connectionSession) {
	ticker := time.NewTicker(time.Duration(env.DefaultHeartbeatSecs) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-session.ctx.Done():
			return
		case <-ticker.C:
			if err := s.sendHeartbeat(session, false); err != nil {
				s.logger.Warn("failed to enqueue heartbeat", slog.String("connectionId", session.id), slog.String("identity", session.identity), slog.String("error", err.Error()))
				return
			}
		}
	}
}

func enqueuePayload(session *connectionSession, payload []byte) error {
	select {
	case <-session.ctx.Done():
		return session.ctx.Err()
	case session.sendCh <- payload:
		return nil
	case <-time.After(2 * time.Second):
		return fmt.Errorf("outbound websocket queue is full")
	}
}
