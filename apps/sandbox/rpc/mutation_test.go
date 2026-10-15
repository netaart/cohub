package rpc

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/cohub/apps/sandbox/protocol"
)

func mutationRequest(t *testing.T, method string, params any) protocol.RPCRequest {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	return protocol.RPCRequest{RequestScopedMessage: protocol.RequestScopedMessage{RequestID: "req-1"}, Method: method, Params: raw}
}

func failureCode(t *testing.T, result interface{}) string {
	t.Helper()
	failed, ok := result.(protocol.RPCFailed)
	if !ok {
		return ""
	}
	return failed.Error.Code
}

func mutationRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{"full/nested", "empty", "dest"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, file := range []string{"a.txt", "full/nested/b.txt"} {
		if err := os.WriteFile(filepath.Join(root, file), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func mutationDirectoryAlias(t *testing.T, path, target string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		if output, err := exec.Command("cmd", "/c", "mklink", "/J", path, target).CombinedOutput(); err != nil {
			t.Fatalf("create junction: %v: %s", err, output)
		}
	} else if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
}

func TestFSMutationWorkspaceAliases(t *testing.T) {
	root := mutationRoot(t)
	d := newTreeDispatcher(t, root)
	mutationDirectoryAlias(t, filepath.Join(root, "parent-alias"), filepath.Dir(root))
	alias := filepath.Join("parent-alias", filepath.Base(root))
	if content, err := os.ReadFile(filepath.Join(root, alias, "a.txt")); err != nil || string(content) != "x" {
		t.Fatalf("workspace alias is not usable: content = %q, error = %v", content, err)
	}
	for _, request := range []protocol.RPCRequest{
		mutationRequest(t, "fs.delete", fsDeleteParams{Path: alias, Recursive: true}),
		mutationRequest(t, "fs.move", fsMoveParams{FromPath: alias, ToPath: "moved"}),
		mutationRequest(t, "fs.move", fsMoveParams{FromPath: "a.txt", ToPath: alias}),
	} {
		_, result := d.Handle(request, "owner")
		failed, ok := result.(protocol.RPCFailed)
		if !ok || failed.Error.Code != "INVALID_PATH" || !exists(filepath.Join(root, "a.txt")) {
			t.Fatalf("%s through workspace alias: result = %#v, want INVALID_PATH with workspace content kept", request.Method, result)
		}
	}
}

func TestFSMutationThroughDirectoryAlias(t *testing.T) {
	for _, method := range []string{"fs.delete", "fs.move"} {
		t.Run(method, func(t *testing.T) {
			root := mutationRoot(t)
			d := newTreeDispatcher(t, root)
			mutationDirectoryAlias(t, filepath.Join(root, "parent-alias"), filepath.Dir(root))
			path := filepath.Join("parent-alias", filepath.Base(root), "full")
			request := mutationRequest(t, method, fsDeleteParams{Path: path, Recursive: true})
			if method == "fs.move" {
				request = mutationRequest(t, method, fsMoveParams{FromPath: path, ToPath: "dest/moved"})
			}
			_, result := d.Handle(request, "owner")
			if _, ok := result.(protocol.RPCFailed); ok || exists(filepath.Join(root, "full")) || !exists(filepath.Join(root, "a.txt")) {
				t.Fatalf("%s through directory alias: result = %#v, want operation applied with workspace kept", method, result)
			}
			if method == "fs.move" && !exists(filepath.Join(root, "dest", "moved", "nested", "b.txt")) {
				t.Fatal("moved directory lost its contents")
			}
		})
	}
}

func TestFSMutationDeleteLeafAliasKeepsWorkspace(t *testing.T) {
	root := mutationRoot(t)
	d := newTreeDispatcher(t, root)
	alias := filepath.Join(root, "workspace-alias")
	mutationDirectoryAlias(t, alias, root)
	result := d.handleFSDelete(mutationRequest(t, "fs.delete", fsDeleteParams{Path: "workspace-alias", Recursive: true}))
	if code := failureCode(t, result); code != "" || exists(alias) || !exists(filepath.Join(root, "a.txt")) {
		t.Fatalf("delete leaf alias: code = %q, want alias removed with workspace content kept", code)
	}
}

func TestFSMutationDelete(t *testing.T) {
	root := mutationRoot(t)
	d := newTreeDispatcher(t, root)
	del := func(path string, recursive bool) interface{} {
		return d.handleFSDelete(mutationRequest(t, "fs.delete", fsDeleteParams{Path: path, Recursive: recursive}))
	}

	if code := failureCode(t, del("missing.txt", false)); code != "NOT_FOUND" {
		t.Fatalf("missing: code = %q, want NOT_FOUND", code)
	}
	if code := failureCode(t, del("full", false)); code != "DIRECTORY_NOT_EMPTY" || !exists(filepath.Join(root, "full", "nested", "b.txt")) {
		t.Fatalf("non-recursive non-empty: code = %q, want DIRECTORY_NOT_EMPTY with contents kept", code)
	}
	for _, path := range []string{".", "/workspace", root, "../outside"} {
		if code := failureCode(t, del(path, true)); code == "" {
			t.Fatalf("delete %q succeeded, want rejection", path)
		}
	}
	if !exists(filepath.Join(root, "a.txt")) {
		t.Fatal("a rejected delete removed workspace content")
	}

	for _, path := range []string{"a.txt", "empty"} {
		if code := failureCode(t, del(path, false)); code != "" || exists(filepath.Join(root, path)) {
			t.Fatalf("delete %q: code = %q, exists = %v", path, code, exists(filepath.Join(root, path)))
		}
	}
	if code := failureCode(t, del("full", true)); code != "" || exists(filepath.Join(root, "full")) {
		t.Fatalf("recursive delete: code = %q", code)
	}
}

func TestFSMutationDeleteReadOnly(t *testing.T) {
	root := mutationRoot(t)
	d := newTreeDispatcher(t, root)
	d.cfg.UserAgentsDir = filepath.Join(root, "full")
	result := d.handleFSDelete(mutationRequest(t, "fs.delete", fsDeleteParams{Path: "full/nested/b.txt"}))
	if code := failureCode(t, result); code != "READ_ONLY_FILESYSTEM" || !exists(filepath.Join(root, "full", "nested", "b.txt")) {
		t.Fatalf("read-only delete: code = %q", code)
	}
}

// A recursive delete that stops partway must report why, not "directory is not empty".
func TestFSMutationRecursiveDeleteReportsPartialFailure(t *testing.T) {
	root := mutationRoot(t)
	locked := filepath.Join(root, "full", "nested")
	if runtime.GOOS == "windows" {
		// Go opens files without FILE_SHARE_DELETE, so an open handle blocks deletion.
		file, err := os.Open(filepath.Join(locked, "b.txt"))
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
	} else {
		if os.Geteuid() == 0 {
			t.Skip("root ignores directory permissions")
		}
		if err := os.Chmod(locked, 0o555); err != nil {
			t.Fatal(err)
		}
		defer os.Chmod(locked, 0o755)
	}
	d := newTreeDispatcher(t, root)
	result := d.handleFSDelete(mutationRequest(t, "fs.delete", fsDeleteParams{Path: "full", Recursive: true}))
	if code := failureCode(t, result); code == "" || code == "DIRECTORY_NOT_EMPTY" {
		t.Fatalf("partial recursive delete: code = %q, want the underlying failure", code)
	}
}

func TestFSMutationMove(t *testing.T) {
	root := mutationRoot(t)
	d := newTreeDispatcher(t, root)
	move := func(from, to string) interface{} {
		return d.handleFSMove(mutationRequest(t, "fs.move", fsMoveParams{FromPath: from, ToPath: to}))
	}

	if code := failureCode(t, move("missing.txt", "b.txt")); code != "NOT_FOUND" {
		t.Fatalf("missing: code = %q, want NOT_FOUND", code)
	}
	// Exact-target semantics: a file is never moved into an existing directory.
	if code := failureCode(t, move("a.txt", "dest")); code == "" || !exists(filepath.Join(root, "a.txt")) || exists(filepath.Join(root, "dest", "a.txt")) {
		t.Fatalf("move onto a directory: code = %q", code)
	}
	for _, pair := range [][2]string{{"a.txt", "../outside.txt"}, {"a.txt", "/workspace"}, {".", "moved"}} {
		if code := failureCode(t, move(pair[0], pair[1])); code == "" {
			t.Fatalf("move %q -> %q succeeded, want rejection", pair[0], pair[1])
		}
	}
	if code := failureCode(t, move("full", "dest/full")); code != "" || !exists(filepath.Join(root, "dest", "full", "nested", "b.txt")) {
		t.Fatalf("move directory: code = %q", code)
	}
	if code := failureCode(t, move("/workspace/a.txt", "renamed.txt")); code != "" || !exists(filepath.Join(root, "renamed.txt")) {
		t.Fatalf("move file: code = %q", code)
	}
}
