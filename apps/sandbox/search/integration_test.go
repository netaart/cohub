package search

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/filewatch"
)

// TestIndexedPlansNeverMissCompletedWrites runs the real watcher and a real
// cohub-search binary: a plan requested right after a write must either list
// the file or fall back. Set COHUB_SEARCH_BIN to a built binary to run it.
func TestIndexedPlansNeverMissCompletedWrites(t *testing.T) {
	binary := os.Getenv("COHUB_SEARCH_BIN")
	if binary == "" {
		t.Skip("COHUB_SEARCH_BIN is not set")
	}
	t.Setenv("COHUB_FILEWATCH_BACKEND", "fsnotify")
	workspace := t.TempDir()
	run, err := os.MkdirTemp("", "cs")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(run) })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	var watcher *filewatch.Watcher
	manager := NewManager(env.Config{
		Mode:             env.ModeListen,
		SearchEnabled:    true,
		WorkspaceDir:     workspace,
		SearchBinaryPath: binary,
		SearchIndexDir:   filepath.Join(run, "index"),
		SearchSocketPath: filepath.Join(run, "s.sock"),
	}, logger, func() Watch {
		if watcher == nil {
			return nil
		}
		return watcher
	})
	watcher, err = filewatch.Start(workspace, logger, manager.Apply)
	if err != nil {
		t.Fatalf("start watcher: %v", err)
	}
	t.Cleanup(func() { _ = watcher.Close() })
	manager.Start()
	t.Cleanup(manager.Close)
	manager.Activate()

	plan := func(token string) Plan {
		result, err := manager.Plan(context.Background(), PlanInput{Pattern: token, Limit: 100})
		if err != nil {
			t.Fatalf("Plan() error: %v", err)
		}
		return result
	}
	deadline := time.Now().Add(20 * time.Second)
	for plan("warmup_token").Fallback != "" {
		if time.Now().After(deadline) {
			t.Fatal("index never became authoritative")
		}
		time.Sleep(50 * time.Millisecond)
	}

	// Query while each write moves through the watcher, the manager and the
	// search process; every answer the index gives must include it.
	for round := 0; round < 8; round++ {
		token := fmt.Sprintf("needle_token_%04d", round)
		name := filepath.Join("dir", fmt.Sprintf("f%d", round%3), "file.txt")
		if err := os.MkdirAll(filepath.Join(workspace, filepath.Dir(name)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(workspace, name), []byte(token+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		fallbacks := map[string]int{}
		deadline := time.Now().Add(20 * time.Second)
		for {
			result := plan(token)
			if result.Fallback == "" {
				if !slices.Contains(result.Files, filepath.ToSlash(name)) {
					t.Fatalf("round %d: plan %+v misses %s written before the query", round, result, name)
				}
				t.Logf("round %d: answered after fallbacks %v", round, fallbacks)
				break
			}
			fallbacks[result.Fallback]++
			if time.Now().After(deadline) {
				t.Fatalf("round %d: index did not settle: %v", round, fallbacks)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
}
