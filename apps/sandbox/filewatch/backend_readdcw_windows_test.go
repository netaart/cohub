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
