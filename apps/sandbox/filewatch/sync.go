package filewatch

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/fsnotify/fsnotify"
)

// ErrSyncUnsupported reports a backend without an ordered event queue.
var ErrSyncUnsupported = errors.New("file watcher backend cannot synchronize")

var errWatcherClosed = errors.New("file watcher is closed")

// syncBarrier is a private directory watched by the same inotify instance as
// the workspace. Linux delivers the events of one instance in order, so
// seeing a marker created after a call proves every earlier event was read.
type syncBarrier struct {
	dir     string
	mu      sync.Mutex
	next    uint64
	waiters map[string]chan struct{}
}

func newSyncBarrier(watcher *fsnotify.Watcher) (*syncBarrier, error) {
	dir, err := os.MkdirTemp("", "cohub-filewatch-sync-")
	if err != nil {
		return nil, err
	}
	if err := watcher.Add(dir); err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	return &syncBarrier{dir: dir, waiters: make(map[string]chan struct{})}, nil
}

// observe consumes events for barrier markers and reports whether the event
// belonged to the barrier directory.
func (b *syncBarrier) observe(path string) bool {
	if filepath.Dir(path) != b.dir {
		return false
	}
	name := filepath.Base(path)
	b.mu.Lock()
	if waiter, ok := b.waiters[name]; ok {
		delete(b.waiters, name)
		close(waiter)
	}
	b.mu.Unlock()
	return true
}

func (b *syncBarrier) close() {
	_ = os.RemoveAll(b.dir)
}

// Sync returns once every event the kernel queued before the call has been
// handled, so HasPending then reflects every write that completed earlier.
// Changes found by a subtree discovery still in progress are covered by
// HasPending itself.
func (w *Watcher) Sync(ctx context.Context) error {
	barrier := w.barrier
	if barrier == nil {
		return ErrSyncUnsupported
	}
	barrier.mu.Lock()
	barrier.next++
	name := fmt.Sprintf("marker-%d", barrier.next)
	waiter := make(chan struct{})
	barrier.waiters[name] = waiter
	barrier.mu.Unlock()

	marker := filepath.Join(barrier.dir, name)
	defer func() {
		barrier.mu.Lock()
		delete(barrier.waiters, name)
		barrier.mu.Unlock()
		_ = os.Remove(marker)
	}()
	if err := os.WriteFile(marker, nil, 0o600); err != nil {
		return err
	}
	select {
	case <-waiter:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-w.closed:
		return errWatcherClosed
	}
}

// Settled reports a healthy watcher with no events waiting for consumers.
func (w *Watcher) Settled() bool {
	return w.Status().State == "running" && !w.HasPending()
}
