//go:build windows

package rpc

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/protocol"
	"golang.org/x/sys/windows"
)

func TestWindowsFenceAndLocksResolveJunctions(t *testing.T) {
	root := mutationRoot(t)
	outside := t.TempDir()
	outsideFile := filepath.Join(outside, "valuable.txt")
	if err := os.WriteFile(outsideFile, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	mutationDirectoryAlias(t, filepath.Join(root, "outside"), outside)
	mutationDirectoryAlias(t, filepath.Join(root, "inside"), filepath.Join(root, "full"))
	rootName, err := windows.UTF16PtrFromString(root)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(rootName, windows.FILE_LIST_DIRECTORY,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OVERLAPPED, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	d := newTreeDispatcher(t, root)
	for _, request := range []protocol.RPCRequest{
		mutationRequest(t, "fs.read", fsReadParams{Path: "outside/valuable.txt"}),
		mutationRequest(t, "fs.delete", fsDeleteParams{Path: "outside/valuable.txt"}),
		mutationRequest(t, "fs.write", fsWriteParams{Path: "outside/new.txt", Content: "overwrite"}),
	} {
		_, result := d.Handle(request, "owner")
		failed, ok := result.(protocol.RPCFailed)
		if !ok || failed.Error.Code != "ACCESS_DENIED" {
			t.Fatalf("%s through outside junction: result = %#v, want ACCESS_DENIED", request.Method, result)
		}
	}
	if content, err := os.ReadFile(outsideFile); err != nil || string(content) != "keep" || exists(filepath.Join(outside, "new.txt")) {
		t.Fatalf("outside junction changed protected files: content = %q, error = %v", content, err)
	}
	alias := filepath.Join(root, "inside", "nested", "b.txt")
	target := filepath.Join(root, "full", "nested", "b.txt")
	if resolved, err := resolveSandboxPath(d.cfg, alias, ""); err != nil || resolved.path != alias {
		t.Fatalf("inside junction rejected: path = %q, error = %v", resolved.path, err)
	}
	if got, want := resolvePathLockKey(alias), resolvePathLockKey(target); got != want {
		t.Fatalf("junction lock key = %q, want %q", got, want)
	}
	alias = filepath.Join(root, "inside", "nested", "new.txt")
	target = filepath.Join(root, "full", "nested", "new.txt")
	if got, want := resolvePathLockKey(alias), resolvePathLockKey(target); got != want {
		t.Fatalf("new file junction lock key = %q, want %q", got, want)
	}
}

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
