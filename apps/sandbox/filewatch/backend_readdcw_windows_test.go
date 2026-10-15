//go:build windows

package filewatch

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWindowsWatcherKeepsFoldersRenamable(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "a", "b", "c"), 0o755); err != nil {
		t.Fatal(err)
	}
	batches := make(chan Batch, 64)
	watcher, err := Start(root, slog.New(slog.NewTextHandler(io.Discard, nil)), func(b Batch) { batches <- b })
	if err != nil {
		t.Fatal(err)
	}
	defer watcher.Close()
	if backend := watcher.Status().Backend; backend != "readdcw" {
		t.Fatalf("backend = %q, want readdcw", backend)
	}
	waitForResync(t, batches)

	if err := os.Rename(filepath.Join(root, "a"), filepath.Join(root, "renamed")); err != nil {
		t.Fatalf("rename a folder with watched descendants: %v", err)
	}
	// A folder renamed in asks for a resync, which absorbs changes made before it is delivered.
	waitForResync(t, batches)
	if err := os.WriteFile(filepath.Join(root, "renamed", "b", "c", "hello.txt"), []byte("hi"), 0o600); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(10 * time.Second)
	for {
		select {
		case batch := <-batches:
			for _, change := range batch.Changes {
				if change.Path == "renamed/b/c/hello.txt" && change.Kind == "create" {
					return
				}
			}
		case <-deadline:
			t.Fatal("no create event for a file in a nested folder")
		}
	}
}

func TestWindowsWatcherDetectsQuietRootChanges(t *testing.T) {
	for _, replace := range []bool{false, true} {
		name := "rename"
		if replace {
			name = "replacement"
		}
		t.Run(name, func(t *testing.T) {
			t.Setenv(filewatchBackendEnv, "readdcw")
			parent := t.TempDir()
			t.Chdir(parent)
			root := filepath.Join(parent, "workspace")
			moved := filepath.Join(parent, "moved")
			if err := os.Mkdir(root, 0o700); err != nil {
				t.Fatal(err)
			}
			batches := make(chan Batch, 16)
			watcher, err := Start(root, slog.New(slog.NewTextHandler(io.Discard, nil)), func(batch Batch) { batches <- batch })
			if err != nil {
				t.Fatal(err)
			}
			defer watcher.Close()
			waitForResync(t, batches)

			if err := os.Rename(root, moved); err != nil {
				t.Fatal(err)
			}
			if replace {
				if err := os.Mkdir(root, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			// No child changes wake ReadDirectoryChangesW after the root itself moves.
			select {
			case batch := <-batches:
				status := watcher.Status()
				if !batch.Resync || status.State != "degraded" || status.Reason != "root_changed" {
					t.Fatalf("root change: batch=%+v status=%+v", batch, status)
				}
			case <-time.After(5 * time.Second):
				t.Fatalf("quiet root change went undetected: %+v", watcher.Status())
			}

			for _, path := range []string{moved, root} {
				if path == root && !replace {
					continue
				}
				if err := os.WriteFile(filepath.Join(path, "after.txt"), []byte("changed"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case batch := <-batches:
				t.Fatalf("watch continued after the root changed: %+v", batch)
			case <-time.After(2 * debounceWindow):
			}
			if status := watcher.Status(); status.State != "degraded" || status.Reason != "root_changed" {
				t.Fatalf("root change recovered without restart: %+v", status)
			}
		})
	}
}
