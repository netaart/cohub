package ws

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/process"
	"github.com/cohub/apps/sandbox/protocol"
	"github.com/cohub/apps/sandbox/rpc"
)

type authPrepareState struct{}

func (authPrepareState) Get() (string, string)                { return "ready", "" }
func (authPrepareState) GetSetup() *protocol.SandboxSetupInfo { return nil }

func authTestServer(t *testing.T, token string) (*Server, *httptest.Server) {
	t.Helper()
	cfg := env.Config{SpaceID: "space-a", WorkspaceDir: t.TempDir(), SandboxRPCToken: token}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	manager := process.NewManager(logger)
	s := NewServer(cfg, rpc.NewDispatcher(cfg, manager, logger), manager, nil, authPrepareState{}, "sandbox-a", logger)
	mux := http.NewServeMux()
	mux.HandleFunc("/sandbox", s.handleSandbox)
	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.HandleFunc("/readyz", s.handleReadyz)
	httpServer := httptest.NewServer(mux)
	t.Cleanup(httpServer.Close)
	return s, httpServer
}

func TestSandboxHandshakeAuthentication(t *testing.T) {
	s, server := authTestServer(t, "instance-a-token")
	for _, authorization := range []string{"", "Bearer instance-b-token", "Bearer report-token", "instance-a-token"} {
		req, err := http.NewRequest(http.MethodGet, server.URL+"/sandbox", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", authorization)
		resp, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", resp.StatusCode)
		}
	}
	if len(s.sessionsByID) != 0 {
		t.Fatal("unauthorized connection created a session")
	}
	for _, path := range []string{"/healthz", "/readyz"} {
		resp, err := server.Client().Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s status = %d", path, resp.StatusCode)
		}
	}
	_, unconfigured := authTestServer(t, "")
	resp, err := unconfigured.Client().Get(unconfigured.URL + "/sandbox")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured status = %d, want 503", resp.StatusCode)
	}
}

func TestAuthenticatedSandboxRPCAndResourceBinding(t *testing.T) {
	_, server := authTestServer(t, "instance-a-token")
	for _, mismatch := range []string{"", "attach", "rpc"} {
		t.Run(mismatch, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/sandbox", &websocket.DialOptions{
				HTTPHeader: http.Header{"Authorization": {"Bearer instance-a-token"}},
			})
			if err != nil {
				t.Fatal(err)
			}
			defer conn.CloseNow()
			var heartbeat protocol.SandboxHeartbeat
			if err := wsjson.Read(ctx, conn, &heartbeat); err != nil {
				t.Fatal(err)
			}
			base := protocol.BaseMessage{Version: "1", SpaceID: heartbeat.SpaceID, SandboxID: heartbeat.SandboxID}
			attachBase := base
			attachBase.Type = "session.attach"
			if mismatch == "attach" {
				attachBase.SpaceID = "space-b"
			}
			if err := wsjson.Write(ctx, conn, protocol.SessionAttach{BaseMessage: attachBase, RequestID: "attach", Identity: "trusted-agent"}); err != nil {
				t.Fatal(err)
			}
			if mismatch == "attach" {
				_, _, err = conn.Read(ctx)
				if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
					t.Fatalf("attach error = %v", err)
				}
				return
			}
			var attached protocol.SessionAttachOK
			if err := wsjson.Read(ctx, conn, &attached); err != nil {
				t.Fatal(err)
			}
			if attached.Type != "session.attach.ok" {
				t.Fatalf("attach type = %s", attached.Type)
			}
			base.Type = "rpc.request"
			if mismatch == "rpc" {
				base.SandboxID = "sandbox-b"
			}
			if err := wsjson.Write(ctx, conn, protocol.RPCRequest{
				RequestScopedMessage: protocol.RequestScopedMessage{BaseMessage: base, RequestID: "read"},
				Method:               "fs.ls", Params: []byte(`{"path":".","limit":1}`),
			}); err != nil {
				t.Fatal(err)
			}
			for {
				var message struct {
					Type      string `json:"type"`
					RequestID string `json:"requestId"`
				}
				err = wsjson.Read(ctx, conn, &message)
				if mismatch == "rpc" {
					if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
						t.Fatalf("RPC error = %v", err)
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				if message.Type == "rpc.failed" {
					t.Fatal("authenticated file RPC failed")
				}
				if message.Type == "rpc.completed" && message.RequestID == "read" {
					break
				}
			}
		})
	}
}
