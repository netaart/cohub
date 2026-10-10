package filewatch

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// collectUntilSettled gathers every batch the watcher hands out until a sync
// barrier proves the earlier writes were handled.
func collectUntilSettled(t *testing.T, watcher *Watcher, received <-chan Batch) []Batch {
	t.Helper()
	syncWatcher(t, watcher)
	waitSettled(t, watcher)
	var batches []Batch
	for {
		select {
		case batch := <-received:
			batches = append(batches, batch)
		default:
			return batches
		}
	}
}

func boundaryPaths(batches []Batch) map[string]string {
	paths := map[string]string{}
	for _, batch := range batches {
		for _, change := range batch.Boundaries {
			paths[change.Path] = change.Kind
		}
	}
	return paths
}

func TestIgnoredEntriesReachConsumersOnlyAsBoundaries(t *testing.T) {
	received := make(chan Batch, 64)
	watcher, root := startSyncTestWatcher(t, func(batch Batch) { received <- batch })
	waitForResync(t, received)
	waitSettled(t, watcher)
	collectUntilSettled(t, watcher, received)

	if err := os.MkdirAll(filepath.Join(root, "build"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "build", "out.js"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	created := collectUntilSettled(t, watcher, received)
	if got := boundaryPaths(created); !reflect.DeepEqual(got, map[string]string{"build": "create"}) {
		t.Fatalf("boundaries after creating build/ = %v", got)
	}
	for _, batch := range created {
		if len(batch.Changes) != 0 || batch.Seq != 0 {
			t.Fatalf("an ignored entry reached the change stream: %+v", batch)
		}
	}

	if err := os.RemoveAll(filepath.Join(root, "build")); err != nil {
		t.Fatal(err)
	}
	if got := boundaryPaths(collectUntilSettled(t, watcher, received)); got["build"] != "delete" {
		t.Fatalf("boundaries after removing build/ = %v", got)
	}
}

func TestNewDirectoriesReportTheIgnoredEntriesTheyContain(t *testing.T) {
	received := make(chan Batch, 64)
	watcher, root := startSyncTestWatcher(t, func(batch Batch) { received <- batch })
	waitForResync(t, received)
	waitSettled(t, watcher)
	collectUntilSettled(t, watcher, received)

	// Built elsewhere and moved in, so discovery finds node_modules already present.
	staging := t.TempDir()
	if err := os.MkdirAll(filepath.Join(staging, "app", "node_modules", "pkg"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "app", "index.js"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(staging, "app"), filepath.Join(root, "app")); err != nil {
		t.Fatal(err)
	}
	batches := collectUntilSettled(t, watcher, received)
	if got := boundaryPaths(batches); !reflect.DeepEqual(got, map[string]string{"app/node_modules": "create"}) {
		t.Fatalf("boundaries after moving app/ in = %v", got)
	}
	for _, batch := range batches {
		for _, change := range batch.Changes {
			if change.Path == "app/node_modules" || filepath.Dir(change.Path) == "app/node_modules" {
				t.Fatalf("ignored entry in the change stream: %+v", change)
			}
		}
	}
}
