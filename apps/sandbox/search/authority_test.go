package search

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/filewatch"
)

type fakeWatch struct {
	mu      sync.Mutex
	settled bool
	syncErr error
	syncs   int
}

func (w *fakeWatch) Sync(context.Context) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.syncs++
	return w.syncErr
}

func (w *fakeWatch) Settled() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.settled
}

func (w *fakeWatch) set(settled bool, syncErr error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.settled = settled
	w.syncErr = syncErr
}

type fakeSearch struct {
	apiVersion   int
	failUpdates  atomic.Bool
	blockUpdates chan struct{}
	queries      atomic.Int32
	reconciles   atomic.Int32
}

func startFakeSearch(t *testing.T, search *fakeSearch) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "cs")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	socket := filepath.Join(dir, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "apiVersion": search.apiVersion})
	})
	mux.HandleFunc("/index/reconcile", func(w http.ResponseWriter, _ *http.Request) {
		search.reconciles.Add(1)
		w.WriteHeader(http.StatusAccepted)
	})
	mux.HandleFunc("/index/update", func(w http.ResponseWriter, _ *http.Request) {
		if search.blockUpdates != nil {
			<-search.blockUpdates
		}
		if search.failUpdates.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	})
	mux.HandleFunc("/query", func(w http.ResponseWriter, _ *http.Request) {
		search.queries.Add(1)
		_ = json.NewEncoder(w).Encode(Plan{Files: []string{"src/a.ts"}, WalkFiles: []string{}, Dirs: []string{"build"}})
	})
	server := &http.Server{Handler: mux}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	return socket
}

func startActivatedManager(t *testing.T, socket string, watch *fakeWatch) *Manager {
	t.Helper()
	manager := NewManager(env.Config{
		Mode:             env.ModeListen,
		SearchEnabled:    true,
		SearchSocketPath: socket,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)), func() Watch { return watch })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		manager.commandLoop(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	manager.Activate()
	waitFor(t, func() bool { return manager.processReady.Load() && manager.inflight.Load() == 0 })
	return manager
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func planFallback(t *testing.T, manager *Manager) string {
	t.Helper()
	plan, err := manager.Plan(context.Background(), PlanInput{Pattern: "needle", Limit: 10})
	if err != nil {
		t.Fatalf("Plan() error: %v", err)
	}
	return plan.Fallback
}

func TestPlanAnswersFromTheIndexOnlyWhenEveryChangeReachedIt(t *testing.T) {
	search := &fakeSearch{apiVersion: APIVersion}
	watch := &fakeWatch{settled: true}
	manager := startActivatedManager(t, startFakeSearch(t, search), watch)

	plan, err := manager.Plan(context.Background(), PlanInput{Pattern: "needle", Limit: 10})
	if err != nil || plan.Fallback != "" || len(plan.Files) != 1 || plan.Dirs[0] != "build" {
		t.Fatalf("Plan() = %+v, %v", plan, err)
	}
	if watch.syncs == 0 {
		t.Fatal("Plan did not synchronize with the watcher")
	}

	watch.set(false, nil)
	if got := planFallback(t, manager); got != FallbackWatcher {
		t.Fatalf("unsettled watcher fallback = %q", got)
	}
	watch.set(true, errors.New("sync timed out"))
	if got := planFallback(t, manager); got != FallbackWatcher {
		t.Fatalf("failed sync fallback = %q", got)
	}
	if search.queries.Load() != 1 {
		t.Fatalf("queries reached the index while it was not authoritative: %d", search.queries.Load())
	}
}

func TestBatchesKeepPlansOffTheIndexUntilAccepted(t *testing.T) {
	search := &fakeSearch{apiVersion: APIVersion, blockUpdates: make(chan struct{})}
	watch := &fakeWatch{settled: true}
	manager := startActivatedManager(t, startFakeSearch(t, search), watch)

	manager.Apply(filewatch.Batch{Seq: 1, Changes: []filewatch.Change{{Path: "a.txt", Kind: "modify"}}})
	if got := planFallback(t, manager); got != FallbackPartial {
		t.Fatalf("in-flight batch fallback = %q", got)
	}
	close(search.blockUpdates)
	waitFor(t, func() bool { return manager.inflight.Load() == 0 })
	if got := planFallback(t, manager); got != "" {
		t.Fatalf("accepted batch fallback = %q", got)
	}
}

func TestLostBatchesKeepPlansOffTheIndexUntilAReconcile(t *testing.T) {
	search := &fakeSearch{apiVersion: APIVersion}
	watch := &fakeWatch{settled: true}
	manager := startActivatedManager(t, startFakeSearch(t, search), watch)
	reconciles := search.reconciles.Load()

	search.failUpdates.Store(true)
	manager.Apply(filewatch.Batch{Seq: 1, Changes: []filewatch.Change{{Path: "a.txt", Kind: "modify"}}})
	waitFor(t, func() bool { return manager.lostGen.Load() > 0 })
	search.failUpdates.Store(false)
	// The retry reconcile runs after a backoff; until then the loss shows.
	if got := planFallback(t, manager); got == "" {
		t.Fatal("lost batch did not keep plans off the index")
	}
	waitFor(t, func() bool {
		return search.reconciles.Load() > reconciles && manager.processReady.Load() && manager.inflight.Load() == 0
	})
	if got := planFallback(t, manager); got != "" {
		t.Fatalf("fallback after the covering reconcile = %q", got)
	}
}

func TestIncompatibleSearchBinariesNeverAnswerQueries(t *testing.T) {
	search := &fakeSearch{apiVersion: 1}
	manager := startActivatedManager(t, startFakeSearch(t, search), &fakeWatch{settled: true})
	if got := planFallback(t, manager); got != FallbackUnavailable {
		t.Fatalf("incompatible binary fallback = %q", got)
	}
	if search.queries.Load() != 0 {
		t.Fatal("query reached an incompatible binary")
	}
}

func TestMissingWatcherKeepsPlansOffTheIndex(t *testing.T) {
	search := &fakeSearch{apiVersion: APIVersion}
	manager := NewManager(env.Config{
		Mode:             env.ModeListen,
		SearchEnabled:    true,
		SearchSocketPath: startFakeSearch(t, search),
	}, slog.New(slog.NewTextHandler(io.Discard, nil)), func() Watch { return nil })
	manager.processReady.Store(true)
	manager.compatible.Store(true)
	if got := planFallback(t, manager); got != FallbackWatcher {
		t.Fatalf("missing watcher fallback = %q", got)
	}
}
