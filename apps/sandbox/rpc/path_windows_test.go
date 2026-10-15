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
		// Win32 strips trailing dots and spaces, so these must never reach the fence.
		`.. \outside.txt`,
		`/workspace/.. /outside.txt`,
		`.. .\outside.txt`,
		"a.txt.",
		`dir \a.txt`,
	} {
		if _, err := resolveSandboxPath(cfg, path, ""); err == nil {
			t.Fatalf("resolve(%q) succeeded, want rejection", path)
		}
	}
}

func TestWindowsPathWithinDriveRoot(t *testing.T) {
	for _, c := range []struct {
		root, path string
		want       bool
	}{
		{`C:\`, `C:\ws\a.txt`, true},
		{`C:\ws`, `c:\WS\a.txt`, true},
		{`C:\ws`, `C:\ws`, true},
		{`C:\ws`, `C:\wsx\a.txt`, false},
		{`C:\`, `D:\a.txt`, false},
	} {
		if got := pathWithin(c.root, c.path); got != c.want {
			t.Fatalf("pathWithin(%q, %q) = %v, want %v", c.root, c.path, got, c.want)
		}
	}
}
