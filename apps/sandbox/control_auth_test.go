package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/process"
	"github.com/cohub/apps/sandbox/rpc"
	"github.com/cohub/apps/sandbox/ws"
	"github.com/golang-jwt/jwt/v5"
)

func TestSandboxControlAuthentication(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, otherKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cfg := env.Config{SpaceID: "space-a", ControlPublicKey: publicKey, WorkspaceDir: t.TempDir()}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	manager := process.NewManager(logger)
	server := ws.NewServer(cfg, rpc.NewDispatcher(cfg, manager, logger), manager, nil, &prepareState{status: "ready"}, "sandbox-a", logger)
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()
	endpoint := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/sandbox"
	claims := func() jwt.MapClaims {
		now := time.Now().Unix()
		return jwt.MapClaims{"iss": "cohub-platform", "aud": "cohub-sandbox-control", "sub": "agent-a", "spaceId": "space-a", "iat": now, "exp": now + 60}
	}
	sign := func(value jwt.MapClaims, key any, method jwt.SigningMethod) string {
		t.Helper()
		token, err := jwt.NewWithClaims(method, value).SignedString(key)
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	for _, tc := range []struct {
		name  string
		field string
		value any
	}{
		{"wrong space", "spaceId", "space-b"},
		{"wrong issuer", "iss", "someone-else"},
		{"wrong audience", "aud", "other-service"},
		{"missing identity", "sub", ""},
		{"expired", "exp", time.Now().Unix() - 1},
		{"future issue", "iat", time.Now().Unix() + 30},
		{"excessive lifetime", "exp", time.Now().Unix() + 3600},
		{"missing issue time", "iat", nil},
		{"missing expiry", "exp", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			value := claims()
			value[tc.field] = tc.value
			assertControlRejected(t, endpoint, sign(value, privateKey, jwt.SigningMethodEdDSA))
		})
	}
	for name, token := range map[string]string{
		"missing": "", "malformed": "invalid",
		"wrong key":       sign(claims(), otherKey, jwt.SigningMethodEdDSA),
		"wrong algorithm": sign(claims(), []byte("different-secret"), jwt.SigningMethodHS256),
	} {
		t.Run(name, func(t *testing.T) { assertControlRejected(t, endpoint, token) })
	}
	for _, identity := range []string{"agent-a", "agent-b"} {
		t.Run("attach "+identity, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			conn, _, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + sign(claims(), privateKey, jwt.SigningMethodEdDSA)}}})
			if err != nil {
				t.Fatal(err)
			}
			defer conn.CloseNow()
			if _, _, err := conn.Read(ctx); err != nil {
				t.Fatal(err)
			}
			data, err := json.Marshal(map[string]string{"type": "session.attach", "identity": identity, "requestId": "attach-a"})
			if err != nil {
				t.Fatal(err)
			}
			if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
				t.Fatal(err)
			}
			_, response, err := conn.Read(ctx)
			if identity == "agent-b" {
				if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
					t.Fatalf("expected identity rejection, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var message map[string]any
			if err := json.Unmarshal(response, &message); err != nil {
				t.Fatal(err)
			}
			if message["type"] != "session.attach.ok" || message["identity"] != identity {
				t.Fatalf("unexpected attach response: %s", response)
			}
		})
	}
	for _, path := range []string{"/healthz", "/readyz"} {
		response, err := http.Get(httpServer.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("probe %s: %d", path, response.StatusCode)
		}
	}
}

func assertControlRejected(t *testing.T, endpoint, token string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, response, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + token}}})
	if conn != nil {
		conn.CloseNow()
	}
	if response != nil {
		response.Body.Close()
	}
	if err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected HTTP 401 before upgrade, got response=%v error=%v", response, err)
	}
}
