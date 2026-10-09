package rtc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"sync"
	"time"

	"github.com/cohub/apps/sandbox/display"
)

const (
	MaxSessions            = 4
	maxOfferBytes          = 64 << 10
	gatherTimeout          = 3 * time.Second
	connectTimeout         = 30 * time.Second
	idleTimeout            = 30 * time.Second
	maxLifetime            = 12 * time.Hour
	iceDisconnectedTimeout = 5 * time.Second
	iceFailedTimeout       = 25 * time.Second
	iceKeepAlive           = 2 * time.Second
)

var sessionIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type OpenParams struct {
	SessionID  string      `json:"sessionId"`
	Display    string      `json:"display"`
	Offer      string      `json:"offer"`
	ICEServers []ICEServer `json:"iceServers"`
	Control    bool        `json:"control"`
	UserID     string      `json:"userId,omitempty"`
}

type OpenResult struct {
	Answer string `json:"answer"`
}

type CloseParams struct {
	SessionID string `json:"sessionId"`
	UserID    string `json:"userId,omitempty"`
}

type CloseResult struct {
	Closed bool `json:"closed"`
}

const (
	ReasonClosed         = "closed"
	ReasonDisplayEnded   = "display_ended"
	ReasonConnectTimeout = "connect_timeout"
	ReasonIdle           = "idle"
	ReasonFailed         = "failed"
	ReasonExpired        = "expired"
	ReasonShutdown       = "shutdown"
)

type Manager struct {
	hub    *display.Hub
	logger *slog.Logger

	mu       sync.Mutex
	sessions map[string]*session
	reserved int
}

func NewManager(hub *display.Hub, logger *slog.Logger) *Manager {
	return &Manager{hub: hub, logger: logger.With(slog.String("component", "rtc")), sessions: map[string]*session{}}
}

func invalid(format string, args ...any) error {
	return &display.Error{Code: display.CodeInvalid, Message: fmt.Sprintf(format, args...)}
}

func (m *Manager) Open(ctx context.Context, params OpenParams) (OpenResult, error) {
	if !sessionIDPattern.MatchString(params.SessionID) {
		return OpenResult{}, invalid("sessionId must be a lowercase uuid")
	}
	if params.Offer == "" || len(params.Offer) > maxOfferBytes {
		return OpenResult{}, invalid("offer must be 1..%d bytes", maxOfferBytes)
	}
	servers, err := toWebRTCServers(params.ICEServers)
	if err != nil {
		return OpenResult{}, invalid("%v", err)
	}
	m.mu.Lock()
	if _, exists := m.sessions[params.SessionID]; exists {
		m.mu.Unlock()
		return OpenResult{}, invalid("session %s already exists", params.SessionID)
	}
	if len(m.sessions)+m.reserved >= MaxSessions {
		m.mu.Unlock()
		return OpenResult{}, &display.Error{Code: display.CodeBusy, Message: fmt.Sprintf("at most %d viewers at once", MaxSessions)}
	}
	m.reserved++
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.reserved--
		m.mu.Unlock()
	}()

	current, answer, err := openSession(ctx, m, params, servers)
	if err != nil {
		return OpenResult{}, err
	}
	m.mu.Lock()
	if current.ctx.Err() != nil {
		m.mu.Unlock()
		return OpenResult{}, &display.Error{Code: display.CodeFailed, Message: "session closed while opening"}
	}
	m.sessions[params.SessionID] = current
	m.mu.Unlock()
	go current.run()
	return OpenResult{Answer: answer}, nil
}

func (m *Manager) Close(id, userID string) bool {
	m.mu.Lock()
	current := m.sessions[id]
	m.mu.Unlock()
	if current == nil || userID != "" && current.userID != userID {
		return false
	}
	current.close(ReasonClosed)
	return true
}

func (m *Manager) CloseAll(reason string) {
	m.mu.Lock()
	sessions := make([]*session, 0, len(m.sessions))
	for _, current := range m.sessions {
		sessions = append(sessions, current)
	}
	m.mu.Unlock()
	for _, current := range sessions {
		current.close(reason)
	}
}

func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sessions)
}

func (m *Manager) forget(current *session) {
	m.mu.Lock()
	if m.sessions[current.id] == current {
		delete(m.sessions, current.id)
	}
	m.mu.Unlock()
}

func (m *Manager) Handle(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	switch method {
	case "rtc.open":
		var params OpenParams
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, invalid("invalid params: %v", err)
		}
		return m.Open(ctx, params)
	case "rtc.close":
		var params CloseParams
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, invalid("invalid params: %v", err)
		}
		return CloseResult{Closed: m.Close(params.SessionID, params.UserID)}, nil
	default:
		return nil, errors.New("unsupported method")
	}
}
