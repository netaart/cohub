// Package relay implements the local sandbox dial-out client. In local mode the
// sandbox cannot be reached directly (it lives behind the user's NAT), so it
// dials out to the gateway relay and keeps a long-lived control connection. The
// gateway asks it, over that control channel, to open additional data channels;
// each data channel is then served with the exact same agent-sandbox protocol
// used by the cloud listener, so no agent/protocol changes are required.
package relay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/cohub/apps/sandbox/filewatch"
)

// SessionServer is satisfied by ws.Server; it serves one protocol session over a
// dialed-out connection and blocks until that connection ends.
type SessionServer interface {
	ServeDialedConn(ctx context.Context, conn *websocket.Conn, remote string)
}

// Options configures the relay client.
type Options struct {
	// RelayURL is the gateway control endpoint, e.g.
	// wss://gateway.cohub.live/sandbox/relay.
	RelayURL string
	// Token is the user's access token, used by the gateway to authorize the
	// caller against the target space.
	Token string
	// CurrentToken supplies refreshed credentials from the local supervisor.
	CurrentToken   func() string
	OnDisconnected func()
	// SpaceID identifies the space this sandbox serves.
	SpaceID string
	// RuntimeID identifies one local `runtime up` process across reconnects.
	RuntimeID string
	// Server serves each opened data channel.
	Server       SessionServer
	OnRegistered func()
	Logger       *slog.Logger
}

// control frames exchanged on the control channel. Kept intentionally small and
// separate from the agent-sandbox protocol carried on data channels. The
// Payload field carries watcher events (fs.changed / ports.changed) that the
// gateway republishes to space subscribers, so the web file tree stays live
// even when no agent is attached.
type controlFrame struct {
	Type      string          `json:"type"`
	SpaceID   string          `json:"spaceId,omitempty"`
	RuntimeID string          `json:"runtimeId,omitempty"`
	Token     string          `json:"token,omitempty"`
	Channel   string          `json:"channel,omitempty"`
	Message   string          `json:"message,omitempty"`
	Status    int             `json:"status,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

const (
	controlPingInterval = 20 * time.Second
	dialTimeout         = 15 * time.Second
	configRetryDelay    = 5 * time.Minute
)

var reconnectDelays = []time.Duration{
	250 * time.Millisecond,
	time.Second,
	2 * time.Second,
	5 * time.Second,
	10 * time.Second,
	30 * time.Second,
}

// Client maintains the control connection and lets the runtime publish watcher
// events over it. The zero value is not usable; construct with NewClient.
type Client struct {
	opts          Options
	mu            sync.Mutex
	conn          *websocket.Conn // active control connection, nil when disconnected
	watcherStatus func() filewatch.Status
}

type relayConfigError struct {
	status int
	err    error
}

func (e *relayConfigError) Error() string {
	return fmt.Sprintf("relay configuration rejected with HTTP %d: %v", e.status, e.err)
}

func (e *relayConfigError) Unwrap() error {
	return e.err
}

// relayAuthError is a rejected user token. Retrying with the same token cannot
// succeed, so Run returns instead of backing off.
type relayAuthError struct {
	status int
	err    error
}

func (e *relayAuthError) Error() string {
	return fmt.Sprintf("relay authentication rejected with HTTP %d: %v", e.status, e.err)
}

func (e *relayAuthError) Unwrap() error {
	return e.err
}

func isFatalRelayError(err error) bool {
	var authErr *relayAuthError
	return errors.As(err, &authErr)
}

func relayErrorStatus(err error) int {
	var authErr *relayAuthError
	if errors.As(err, &authErr) {
		return authErr.status
	}
	var configErr *relayConfigError
	if errors.As(err, &configErr) {
		return configErr.status
	}
	return 0
}

func controlRejection(status int, message string) error {
	err := fmt.Errorf("relay rejected connection: %s", message)
	if status == http.StatusUnauthorized {
		return &relayAuthError{status: status, err: err}
	}
	if status == 0 || (status >= 400 && status < 500) {
		return &relayConfigError{status: status, err: err}
	}
	return err
}

func NewClient(opts Options) *Client {
	return &Client{opts: opts}
}

// SetServer sets the session server used to serve opened data channels. It must
// be called before Run when the client is constructed without Options.Server.
func (c *Client) SetServer(server SessionServer) {
	c.opts.Server = server
}

// SetWatcherStatus must be called before Run.
func (c *Client) SetWatcherStatus(status func() filewatch.Status) {
	c.watcherStatus = status
}

func (c *Client) publishWatcherStatus() {
	if c.watcherStatus != nil {
		c.PublishEvent("watcher.status", c.watcherStatus())
	}
}

// PublishEvent sends a watcher event (fs.changed / ports.changed / watcher.status) over the
// active control connection. It is a no-op (drops the event) when the control
// connection is down; the gateway/web recover via the watcher's resync frame
// on reconnect. Safe for concurrent use.
func (c *Client) PublishEvent(eventType string, payload interface{}) {
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn == nil {
		return
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		c.opts.Logger.Warn("relay marshal event failed", slog.String("type", eventType), slog.String("error", err.Error()))
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, conn, controlFrame{Type: eventType, SpaceID: c.opts.SpaceID, Payload: raw}); err != nil {
		c.opts.Logger.Debug("relay publish event failed", slog.String("type", eventType), slog.String("error", err.Error()))
	}
}

func (c *Client) setConn(conn *websocket.Conn) {
	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()
}

// Run maintains the control connection, reconnecting with backoff until ctx is
// cancelled or the relay rejects the access token. A rejected token is fatal:
// the process holds a static JWT and retrying cannot succeed.
func (c *Client) Run(ctx context.Context) error {
	opts := c.opts
	attempt := 0
	for {
		if ctx.Err() != nil {
			return nil
		}
		start := time.Now()
		err := c.connectControl(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if opts.OnDisconnected != nil {
			opts.OnDisconnected()
		}
		if isFatalRelayError(err) && opts.CurrentToken == nil {
			opts.Logger.Error("relay access token was rejected; re-run `cohub runtime up` after logging in again", slog.String("error", err.Error()))
			return err
		}
		if err != nil {
			attrs := []any{
				slog.String("error", err.Error()),
				slog.Int("attempt", attempt+1),
				slog.Duration("connectionAge", time.Since(start)),
			}
			if status := relayErrorStatus(err); status != 0 {
				attrs = append(attrs, slog.Int("status", status))
			}
			opts.Logger.Warn("relay control connection ended", attrs...)
		}
		// A connection that stayed up for a while resets the backoff.
		if time.Since(start) > time.Minute {
			attempt = 0
		}
		delay := reconnectDelays[min(attempt, len(reconnectDelays)-1)]
		var configErr *relayConfigError
		if errors.As(err, &configErr) {
			delay = configRetryDelay
		} else {
			delay = delay/2 + time.Duration(rand.Int63n(int64(delay/2)+1))
		}
		attempt++
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(delay):
		}
	}
}

// Run maintains the control connection using a throwaway client. Retained for
// call sites that do not need to publish events.
func Run(ctx context.Context, opts Options) error {
	return NewClient(opts).Run(ctx)
}

func (c *Client) connectControl(ctx context.Context) error {
	opts := c.opts
	if opts.CurrentToken != nil {
		opts.Token = opts.CurrentToken()
	}
	dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()

	dialStarted := time.Now()
	conn, response, err := websocket.Dial(dialCtx, controlURL(opts.RelayURL), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + opts.Token}},
	})
	if err != nil {
		attrs := []any{slog.String("error", err.Error()), slog.Duration("duration", time.Since(dialStarted))}
		if response != nil {
			attrs = append(attrs, slog.Int("status", response.StatusCode))
		}
		if response != nil {
			opts.Logger.Warn("relay control dial failed", attrs...)
		} else {
			opts.Logger.Debug("relay control dial failed", attrs...)
		}
		if response != nil && response.StatusCode == http.StatusUnauthorized {
			return &relayAuthError{status: response.StatusCode, err: err}
		}
		if response != nil && response.StatusCode == http.StatusForbidden {
			return &relayConfigError{status: response.StatusCode, err: err}
		}
		return fmt.Errorf("dial control: %w", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "closing")
	// Allow larger control frames so batched watcher events fit (the gateway
	// caps this side too). Data channels keep their own larger limit.
	conn.SetReadLimit(1024 * 1024)

	if err := wsjson.Write(ctx, conn, controlFrame{Type: "register", SpaceID: opts.SpaceID, RuntimeID: opts.RuntimeID, Token: opts.Token}); err != nil {
		return fmt.Errorf("send register: %w", err)
	}

	ctx, cancelLoop := context.WithCancel(ctx)
	defer cancelLoop()
	c.setConn(conn)
	defer c.setConn(nil)
	pingErr := make(chan error, 1)
	go controlPingLoop(ctx, conn, cancelLoop, pingErr)
	pendingToken := ""

	for {
		var frame controlFrame
		readCtx, readCancel := context.WithTimeout(ctx, 2*controlPingInterval)
		err := wsjson.Read(readCtx, conn, &frame)
		readCancel()
		if err != nil {
			select {
			case err := <-pingErr:
				return fmt.Errorf("ping control: %w", err)
			default:
				return fmt.Errorf("read control: %w", err)
			}
		}
		switch frame.Type {
		case "registered":
			c.publishWatcherStatus()
			opts.Logger.Info("relay registered", slog.String("spaceId", opts.SpaceID))
			if opts.OnRegistered != nil {
				opts.OnRegistered()
			}
		case "open":
			if frame.Channel == "" {
				opts.Logger.Warn("relay open without channel id")
				continue
			}
			go openDataChannel(ctx, opts, frame.Channel)
		case "error":
			return controlRejection(frame.Status, frame.Message)
		case "ping":
			_ = wsjson.Write(ctx, conn, controlFrame{Type: "pong"})
		case "authenticated":
			if pendingToken != "" {
				opts.Token = pendingToken
				pendingToken = ""
			}
		case "pong":
			c.publishWatcherStatus()
			if opts.CurrentToken != nil && pendingToken == "" {
				next := opts.CurrentToken()
				if next != "" && next != opts.Token {
					writeCtx, writeCancel := context.WithTimeout(ctx, 5*time.Second)
					err := wsjson.Write(writeCtx, conn, controlFrame{Type: "auth", Token: next})
					writeCancel()
					if err != nil {
						return fmt.Errorf("refresh relay credentials: %w", err)
					}
					pendingToken = next
				}
			}
		default:
			opts.Logger.Warn("unknown control frame", slog.String("type", frame.Type))
		}
	}
}

func controlPingLoop(ctx context.Context, conn *websocket.Conn, cancel context.CancelFunc, result chan<- error) {
	ticker := time.NewTicker(controlPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			writeCtx, writeCancel := context.WithTimeout(ctx, 5*time.Second)
			err := wsjson.Write(writeCtx, conn, controlFrame{Type: "ping"})
			writeCancel()
			if err != nil {
				select {
				case result <- err:
				default:
				}
				cancel()
				return
			}
		}
	}
}

// openDataChannel dials a fresh data connection for the given channel id and
// serves it with the standard protocol. Each channel is independent; the
// gateway pipes it transparently to one waiting cloud peer (agent, worker…).
func openDataChannel(ctx context.Context, opts Options, channel string) {
	dialStarted := time.Now()
	dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	conn, response, err := websocket.Dial(dialCtx, dataURL(opts.RelayURL, channel), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + opts.Token}},
	})
	cancel()
	if err != nil {
		attrs := []any{slog.String("channel", channel), slog.String("error", err.Error()), slog.Duration("duration", time.Since(dialStarted))}
		if response != nil {
			attrs = append(attrs, slog.Int("status", response.StatusCode))
		}
		opts.Logger.Warn("relay data channel dial failed", attrs...)
		return
	}
	opts.Logger.Info("relay data channel opened", slog.String("channel", channel), slog.Duration("duration", time.Since(dialStarted)))
	opts.Server.ServeDialedConn(ctx, conn, "relay:"+channel)
}

func controlURL(base string) string {
	return base
}

func dataURL(base, channel string) string {
	u, err := url.Parse(base)
	if err != nil {
		return fmt.Sprintf("%s/data?channel=%s", base, url.QueryEscape(channel))
	}
	u.Path += "/data"
	q := u.Query()
	q.Set("channel", channel)
	u.RawQuery = q.Encode()
	return u.String()
}
