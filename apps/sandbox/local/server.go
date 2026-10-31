// Package local serves the private loopback API of a local Runtime: the same
// filesystem and display RPCs the gateway relay carries, for clients on this
// machine that hold the token its supervisor generated. Requests never leave
// the machine; watcher events still reach other clients through the relay.
package local

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/cohub/apps/sandbox/protocol"
	"github.com/cohub/apps/sandbox/rpc"
)

const maxRPCBytes = 64 << 20

type Server struct {
	digest   [32]byte
	dispatch *rpc.Dispatcher
	logger   *slog.Logger
	http     *http.Server
	port     int
}

func Listen(token string, dispatch *rpc.Dispatcher, logger *slog.Logger) (*Server, error) {
	if len(token) < 32 {
		return nil, errors.New("local API token is too short")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &Server{digest: sha256.Sum256([]byte(token)), dispatch: dispatch, logger: logger, port: listener.Addr().(*net.TCPAddr).Port}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /rpc", s.rpc)
	mux.HandleFunc("GET /files", s.read)
	mux.HandleFunc("HEAD /files", s.read)
	mux.HandleFunc("PUT /files", s.write)
	s.http = &http.Server{Handler: s.authorize(mux), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := s.http.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Warn("local API stopped", slog.String("error", err.Error()))
		}
	}()
	return s, nil
}

func (s *Server) Port() int { return s.port }

func (s *Server) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = s.http.Shutdown(ctx)
}

// authorize admits only bearer requests addressed to the loopback host, so a
// rebound DNS name cannot reach it from a browser even with a guessed port.
func (s *Server) authorize(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.Host)
		if err != nil || (host != "127.0.0.1" && host != "localhost") {
			fail(w, http.StatusForbidden, "ACCESS_DENIED", "loopback requests only")
			return
		}
		provided := sha256.Sum256([]byte(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")))
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || subtle.ConstantTimeCompare(provided[:], s.digest[:]) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			fail(w, http.StatusUnauthorized, "ACCESS_DENIED", "unauthorized")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) rpc(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRPCBytes)).Decode(&request); err != nil {
		fail(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	result, failure := s.dispatch.Invoke(request.Method, request.Params)
	if failure != nil {
		reply(w, http.StatusUnprocessableEntity, map[string]interface{}{"error": failure})
		return
	}
	reply(w, http.StatusOK, map[string]interface{}{"result": result})
}

func (s *Server) read(w http.ResponseWriter, r *http.Request) {
	file, info, failure := s.dispatch.OpenFile(r.URL.Query().Get("path"))
	if failure != nil {
		reply(w, http.StatusUnprocessableEntity, map[string]interface{}{"error": failure})
		return
	}
	defer file.Close()
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("ETag", strconv.Quote(strconv.FormatInt(info.Size(), 36)+"-"+strconv.FormatInt(info.ModTime().UnixNano(), 36)))
	// Workspace files are untrusted: some hosts serve them on the app's own origin.
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

func (s *Server) write(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	var expected *rpc.FileVersion
	if query.Has("expectedSize") || query.Has("expectedMtimeMs") {
		size, sizeErr := strconv.ParseInt(query.Get("expectedSize"), 10, 64)
		mtime, mtimeErr := strconv.ParseInt(query.Get("expectedMtimeMs"), 10, 64)
		if sizeErr != nil || mtimeErr != nil {
			fail(w, http.StatusBadRequest, "BAD_REQUEST", "expectedSize and expectedMtimeMs must be integers")
			return
		}
		expected = &rpc.FileVersion{Size: size, MtimeMs: mtime}
	}
	result, failure := s.dispatch.PutFile(query.Get("path"), r.Body, query.Get("exclusive") == "true", expected)
	if failure != nil {
		reply(w, http.StatusUnprocessableEntity, map[string]interface{}{"error": failure})
		return
	}
	reply(w, http.StatusOK, map[string]interface{}{"result": result})
}

func fail(w http.ResponseWriter, status int, code, message string) {
	reply(w, status, map[string]interface{}{"error": protocol.RPCErrorPayload{Code: code, Message: message}})
}

func reply(w http.ResponseWriter, status int, body interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
