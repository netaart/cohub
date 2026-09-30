package filewatch

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func startSyncTestWatcher(t *testing.T, handler Handler) (*Watcher, string) {
	t.Helper()
	t.Setenv(filewatchBackendEnv, "fsnotify")
	root := t.TempDir()
	watcher, err := Start(root, slog.New(slog.NewTextHandler(io.Discard, nil)), handler)
	if err != nil {
		t.Fatalf("Start() error: %v", err)
	}
	t.Cleanup(func() { _ = watcher.Close() })
	return watcher, root
}

func syncWatcher(t *testing.T, watcher *Watcher) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := watcher.Sync(ctx); err != nil {
		t.Fatalf("Sync() error: %v", err)
	}
}

func waitSettled(t *testing.T, watcher *Watcher) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !watcher.Settled() {
		if time.Now().After(deadline) {
			t.Fatalf("watcher did not settle: pending=%v status=%+v", watcher.HasPending(), watcher.Status())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestSyncMakesEveryEarlierWritePendingUntilTheHandlerReturns(t *testing.T) {
	release := make(chan struct{})
	received := make(chan Batch, 16)
	watcher, root := startSyncTestWatcher(t, func(batch Batch) {
		received <- batch
		if !batch.Resync {
			<-release
		}
	})
	waitForResync(t, received)
	waitSettled(t, watcher)

	for round := 0; round < 20; round++ {
		path := filepath.Join(root, "file.txt")
		if err := os.WriteFile(path, []byte{byte(round)}, 0o644); err != nil {
			t.Fatalf("WriteFile() error: %v", err)
		}
		// Without the barrier the event may still sit in the kernel queue.
		syncWatcher(t, watcher)
		if !watcher.HasPending() || watcher.Settled() {
			t.Fatalf("round %d: write is not pending after Sync", round)
		}
		select {
		case batch := <-received:
			if batch.Resync || len(batch.Changes) != 1 || batch.Changes[0].Path != "file.txt" {
				t.Fatalf("unexpected batch: %+v", batch)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("timed out waiting for the batch")
		}
		// The handler has the batch but has not returned.
		if !watcher.HasPending() {
			t.Fatalf("round %d: batch in the handler is not pending", round)
		}
		release <- struct{}{}
		waitSettled(t, watcher)
	}
}

func TestSyncCoversWritesInsideNewDirectories(t *testing.T) {
	var batches []Batch
	received := make(chan Batch, 64)
	watcher, root := startSyncTestWatcher(t, func(batch Batch) { received <- batch })
	waitForResync(t, received)
	waitSettled(t, watcher)

	target := filepath.Join(root, "a", "b", "c", "file.txt")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatalf("MkdirAll() error: %v", err)
	}
	if err := os.WriteFile(target, []byte("content"), 0o644); err != nil {
		t.Fatalf("WriteFile() error: %v", err)
	}
	syncWatcher(t, watcher)
	if watcher.Settled() {
		t.Fatal("new subtree is not pending after Sync")
	}
	waitSettled(t, watcher)
	close(received)
	for batch := range received {
		batches = append(batches, batch)
	}
	for _, batch := range batches {
		for _, change := range batch.Changes {
			if change.Path == "a/b/c/file.txt" {
				return
			}
		}
	}
	t.Fatalf("file in the new subtree was never reported: %+v", batches)
}

func TestSyncIsUnsupportedWithoutAnOrderedBackend(t *testing.T) {
	t.Setenv(filewatchBackendEnv, "scan")
	watcher, err := Start(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)), func(Batch) {})
	if err != nil {
		t.Fatalf("Start() error: %v", err)
	}
	defer watcher.Close()
	if err := watcher.Sync(context.Background()); err != ErrSyncUnsupported {
		t.Fatalf("Sync() error = %v, want ErrSyncUnsupported", err)
	}
	if watcher.Settled() {
		t.Fatal("a polling watcher must never be settled")
	}
}

func TestCloseRemovesTheSyncBarrier(t *testing.T) {
	watcher, _ := startSyncTestWatcher(t, func(Batch) {})
	dir := watcher.barrier.dir
	if err := watcher.Close(); err != nil {
		t.Fatalf("Close() error: %v", err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("barrier directory still exists: %v", err)
	}
}
