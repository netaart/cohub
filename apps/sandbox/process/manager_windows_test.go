//go:build windows

package process

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func startWindowsTestCommand(t *testing.T, m *Manager, command string) (string, <-chan ExitInfo) {
	t.Helper()
	id, stdout, stderr, exitCh, err := m.StartWithOptions("test", StartOptions{Command: command, CWD: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	go func() { _, _ = io.Copy(io.Discard, stdout) }()
	go func() { _, _ = io.Copy(io.Discard, stderr) }()
	return id, exitCh
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return -1
	}
	return info.Size()
}

func TestWindowsAbortTerminatesDescendants(t *testing.T) {
	tick := filepath.ToSlash(filepath.Join(t.TempDir(), "tick"))
	m := NewManager(slog.Default())
	id, exitCh := startWindowsTestCommand(t, m, fmt.Sprintf("(while true; do echo x >> %q; sleep 0.1; done) >/dev/null 2>&1 & wait", tick))
	deadline := time.Now().Add(10 * time.Second)
	for fileSize(tick) <= 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if err := m.Abort(id); err != nil {
		t.Fatal(err)
	}
	select {
	case info := <-exitCh:
		if info.Reason != "abort" {
			t.Fatalf("reason = %q, want abort", info.Reason)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("aborted command did not exit")
	}
	time.Sleep(500 * time.Millisecond)
	size := fileSize(tick)
	time.Sleep(time.Second)
	if fileSize(tick) != size {
		t.Fatal("background descendant kept running after abort")
	}
}

func TestWindowsNormalExitKeepsDescendants(t *testing.T) {
	marker := filepath.ToSlash(filepath.Join(t.TempDir(), "marker"))
	m := NewManager(slog.Default())
	_, exitCh := startWindowsTestCommand(t, m, fmt.Sprintf("(sleep 1; echo done > %q) >/dev/null 2>&1 &", marker))
	select {
	case info := <-exitCh:
		if info.ExitCode == nil || *info.ExitCode != 0 {
			t.Fatalf("exit = %+v, want 0", info)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("command did not exit")
	}
	deadline := time.Now().Add(10 * time.Second)
	for fileSize(marker) <= 0 {
		if time.Now().After(deadline) {
			t.Fatal("background descendant was terminated after a normal exit")
		}
		time.Sleep(100 * time.Millisecond)
	}
}
