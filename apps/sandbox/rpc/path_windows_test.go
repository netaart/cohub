//go:build windows

package rpc

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cohub/apps/sandbox/env"
)

func TestWindowsFenceResolvesVirtualWorkspaceAndRejectsEscapes(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := env.Config{WorkspaceDir: root, Fence: true}

	for _, input := range []struct{ path, cwd string }{
		{"/workspace/a.txt", ""},
		{"a.txt", "/workspace"},
		{filepath.Join(root, "a.txt"), ""},
		{filepath.Join(strings.ToUpper(root), "A.TXT"), ""},
	} {
		resolved, err := resolveSandboxPath(cfg, input.path, input.cwd)
		if err != nil || !strings.EqualFold(resolved.path, filepath.Join(root, "a.txt")) {
			t.Fatalf("resolve(%q, %q) = %q, %v", input.path, input.cwd, resolved.path, err)
		}
	}

	for _, path := range []string{
		`\\?\` + filepath.Join(root, "a.txt"),
		`\\localhost\c$\Windows`,
		`\\.\pipe\x`,
		"a.txt:stream",
		filepath.VolumeName(root) + "a.txt",
		filepath.Join(filepath.Dir(root), "outside.txt"),
		root + "-sibling",
		`C:\Windows\win.ini`,
	} {
		if _, err := resolveSandboxPath(cfg, path, ""); err == nil {
			t.Fatalf("resolve(%q) succeeded, want rejection", path)
		}
	}
}
