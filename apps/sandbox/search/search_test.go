package search

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/cohub/apps/sandbox/env"
)

func TestProcessArgsIncludeNormalizedFilewatchIgnores(t *testing.T) {
	t.Setenv("FS_WATCH_IGNORE", "custom/cache, .idea,../invalid")
	args := processArgs(env.Config{
		WorkspaceDir:     "/workspace",
		SearchIndexDir:   "/index",
		SearchSocketPath: "/tmp/search.sock",
	})

	contains := func(value string) bool {
		for _, arg := range args {
			if arg == value {
				return true
			}
		}
		return false
	}
	if !contains("--ignore=custom/cache") || !contains("--ignore=.idea") {
		t.Fatalf("custom ignore patterns missing from process args: %v", args)
	}
	if contains("--ignore=../invalid") {
		t.Fatalf("unsafe ignore pattern passed to process: %v", args)
	}
}

func TestManagerHonorsDisabledFeature(t *testing.T) {
	manager := NewManager(env.Config{
		Mode:          env.ModeListen,
		SearchEnabled: false,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if manager.Enabled() {
		t.Fatal("search should stay disabled")
	}
}

func TestManagerEnablesOptionalDownloadWithoutPreinstalledBinary(t *testing.T) {
	manager := NewManager(env.Config{
		Mode:          env.ModeListen,
		SearchEnabled: true,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if !manager.Enabled() {
		t.Fatal("search should be enabled while the binary download is pending")
	}
}

func TestManagerStartsWithCachedBinary(t *testing.T) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skip("search release binary is linux/amd64")
	}

	root := t.TempDir()
	versionDir := filepath.Join(root, "bin", "v1.2.3")
	if err := os.MkdirAll(versionDir, 0o700); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(versionDir, searchBinaryName)
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}

	manager := NewManager(env.Config{
		Mode:              env.ModeListen,
		SearchEnabled:     true,
		SearchVersion:     "v1.2.3",
		SearchDownloadDir: filepath.Join(root, "bin"),
		SearchSocketPath:  filepath.Join(root, "search.sock"),
		SearchIndexDir:    filepath.Join(root, "index"),
		WorkspaceDir:      root,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	manager.Start()
	manager.Close()
	if manager.binary != binary {
		t.Fatalf("selected binary = %q, want %q", manager.binary, binary)
	}
}

func TestCrashingBinaryDoesNotBlockManagerShutdown(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test requires an executable shell script")
	}

	root := t.TempDir()
	binary := filepath.Join(root, "cohub-search")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexit 7\n"), 0o755); err != nil {
		t.Fatalf("write crashing binary: %v", err)
	}

	manager := NewManager(env.Config{
		Mode:             env.ModeListen,
		SearchEnabled:    true,
		WorkspaceDir:     root,
		SearchBinaryPath: binary,
		SearchIndexDir:   filepath.Join(root, "index"),
		SearchSocketPath: filepath.Join(root, "run", "search.sock"),
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if !manager.Enabled() {
		t.Fatal("manager should be enabled for an executable binary")
	}
	manager.Start()
	time.Sleep(50 * time.Millisecond)
	if manager.ProcessReady() {
		t.Fatal("crashed process must not be reported as ready")
	}

	closed := make(chan struct{})
	go func() {
		manager.Close()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("manager shutdown blocked after search process crash")
	}
}
