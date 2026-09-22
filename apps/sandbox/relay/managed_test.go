package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestManagedCredentialsStayOnPrivatePipes(t *testing.T) {
	input, writer := io.Pipe()
	var output bytes.Buffer
	closed := make(chan struct{})
	control := NewManagedControl("old", input, &output, func() { close(closed) })
	if control.Token() != "old" {
		t.Fatal("missing initial token")
	}
	_, _ = writer.Write([]byte("{\"type\":\"auth\",\"token\":\"new-secret\"}\n"))
	_ = writer.Close()
	<-closed
	if control.Token() != "new-secret" {
		t.Fatal("token did not refresh")
	}
	control.Notify("connected")
	if strings.Contains(output.String(), "secret") {
		t.Fatal("credentials leaked into control status")
	}
	if !strings.Contains(output.String(), "hello") || !strings.Contains(output.String(), "connected") {
		t.Fatal("missing lifecycle events")
	}
}

func TestManagedRelayRefreshesOnlineWithoutRestart(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var token atomic.Value
	token.Store("old")
	var connections atomic.Int32
	refreshed := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connections.Add(1)
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		var frame controlFrame
		if wsjson.Read(ctx, conn, &frame) != nil {
			return
		}
		_ = wsjson.Write(ctx, conn, controlFrame{Type: "registered"})
		token.Store("rotated")
		_ = wsjson.Write(ctx, conn, controlFrame{Type: "pong"})
		if wsjson.Read(ctx, conn, &frame) == nil && frame.Type == "auth" {
			refreshed <- frame.Token
			_ = wsjson.Write(ctx, conn, controlFrame{Type: "authenticated"})
		}
		<-ctx.Done()
	}))
	defer server.Close()
	client := NewClient(Options{RelayURL: "ws" + strings.TrimPrefix(server.URL, "http"), SpaceID: "space", CurrentToken: func() string { return token.Load().(string) }, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()
	select {
	case value := <-refreshed:
		if value != "rotated" {
			t.Errorf("unexpected token %q", value)
		}
	case <-ctx.Done():
		t.Error("online credential refresh timed out")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if connections.Load() != 1 {
		t.Fatal("refresh restarted the connection")
	}
}

func TestManagedRelayRetriesRejectedToken(t *testing.T) {
	var attempts atomic.Int32
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		var frame controlFrame
		if wsjson.Read(ctx, conn, &frame) != nil {
			return
		}
		if attempts.Add(1) == 1 {
			_ = wsjson.Write(ctx, conn, controlFrame{Type: "error", Status: 401, Message: "expired"})
			return
		}
		_ = wsjson.Write(ctx, conn, controlFrame{Type: "registered"})
		var ignored json.RawMessage
		_ = wsjson.Read(ctx, conn, &ignored)
	}))
	defer server.Close()
	registered := false
	client := NewClient(Options{
		RelayURL: "ws" + strings.TrimPrefix(server.URL, "http"), SpaceID: "space", CurrentToken: func() string { return "fresh" },
		Logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		OnRegistered: func() { registered = true; cancel() },
	})
	if err := client.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if !registered || attempts.Load() < 2 {
		t.Fatal("managed relay exited rather than recovering")
	}
}
