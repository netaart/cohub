package rpc

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/process"
	"github.com/cohub/apps/sandbox/protocol"
)

func newTreeDispatcher(t *testing.T, root string) *Dispatcher {
	t.Helper()
	cfg := env.Config{WorkspaceDir: root, Fence: true}
	return NewDispatcher(cfg, process.NewManager(slog.Default()), slog.Default())
}

func treeRequest(t *testing.T, params fsTreeParams) protocol.RPCRequest {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	return protocol.RPCRequest{
		RequestScopedMessage: protocol.RequestScopedMessage{RequestID: "req-1"},
		Method:               "fs.tree",
		Params:               raw,
	}
}

func runTree(t *testing.T, d *Dispatcher, params fsTreeParams) map[string]interface{} {
	t.Helper()
	result := d.handleFSTree(treeRequest(t, params))
	m, ok := result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map result, got %T (%v)", result, result)
	}
	return m
}

func treeEntries(t *testing.T, m map[string]interface{}) []fsTreeEntry {
	t.Helper()
	raw, _ := json.Marshal(m["entries"])
	var entries []fsTreeEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		t.Fatalf("decode entries: %v", err)
	}
	return entries
}

func setupTree(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("evalsymlinks: %v", err)
	}
	mustWrite := func(rel, content string) {
		abs := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
	mustWrite("README.md", "hi")
	mustWrite("src/index.ts", "code")
	mustWrite("src/deep/util.ts", "deep")
	mustWrite("node_modules/pkg/index.js", "dep")
	mustWrite(".gitignore", "node_modules\n")
	if err := os.MkdirAll(filepath.Join(root, ".git", "objects"), 0o755); err != nil {
		t.Fatalf("mkdir .git: %v", err)
	}
	return root
}

func TestFSTreeDepthOne(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	entries := treeEntries(t, runTree(t, d, fsTreeParams{Path: ".", Depth: 1}))

	names := map[string]bool{}
	for _, e := range entries {
		names[e.Path] = true
	}
	// Depth 1 lists direct children only.
	if !names["README.md"] || !names["src"] || !names[".gitignore"] {
		t.Fatalf("missing expected top-level entries: %v", names)
	}
	if names["src/index.ts"] {
		t.Fatalf("depth 1 should not recurse into src")
	}
	// .git and gitignored node_modules must be hidden.
	if names[".git"] || names["node_modules"] {
		t.Fatalf("expected .git and node_modules to be hidden: %v", names)
	}
}

func TestFSTreeDepthRecurse(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	entries := treeEntries(t, runTree(t, d, fsTreeParams{Path: ".", Depth: 3}))

	names := map[string]bool{}
	for _, e := range entries {
		names[e.Path] = true
	}
	if !names["src/index.ts"] || !names["src/deep/util.ts"] {
		t.Fatalf("expected nested files at depth 3: %v", names)
	}
	// node_modules subtree stays hidden even when recursing.
	for p := range names {
		if p == "node_modules" || p == "node_modules/pkg" {
			t.Fatalf("node_modules subtree should be pruned: %v", names)
		}
	}
}

func TestFSTreeNoGitignore(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	respect := false
	entries := treeEntries(t, runTree(t, d, fsTreeParams{Path: ".", Depth: 1, RespectGitignore: &respect}))

	names := map[string]bool{}
	for _, e := range entries {
		names[e.Path] = true
	}
	// With gitignore off, node_modules is visible; .git is always hidden.
	if !names["node_modules"] {
		t.Fatalf("expected node_modules visible without gitignore: %v", names)
	}
	if names[".git"] {
		t.Fatalf(".git must always be hidden: %v", names)
	}
}

func TestFSTreeTruncated(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	m := runTree(t, d, fsTreeParams{Path: ".", Depth: 3, Limit: 2})
	entries := treeEntries(t, m)
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries under limit, got %d", len(entries))
	}
	if truncated, _ := m["truncated"].(bool); !truncated {
		t.Fatalf("expected truncated=true when limit reached")
	}
}

func writeRequest(t *testing.T, params fsWriteParams) protocol.RPCRequest {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal write params: %v", err)
	}
	return protocol.RPCRequest{
		RequestScopedMessage: protocol.RequestScopedMessage{RequestID: "req-w"},
		Method:               "fs.write",
		Params:               raw,
	}
}

func editRequest(t *testing.T, params fsEditParams) protocol.RPCRequest {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal edit params: %v", err)
	}
	return protocol.RPCRequest{
		RequestScopedMessage: protocol.RequestScopedMessage{RequestID: "req-e"},
		Method:               "fs.edit",
		Params:               raw,
	}
}

func TestFSEditApplies(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("alpha\nbeta\ngamma\n"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	res := d.handleFSEdit(editRequest(t, fsEditParams{
		Path:  "a.txt",
		Edits: []fsEditItem{{OldText: "beta", NewText: "BETA"}},
	}))
	result, ok := res.(map[string]interface{})
	if !ok {
		t.Fatalf("expected edit to succeed, got %T (%v)", res, res)
	}
	if applied, _ := result["applied"].(int); applied != 1 {
		t.Fatalf("applied = %v, want 1", result["applied"])
	}
	content, err := os.ReadFile(filepath.Join(root, "a.txt"))
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	if string(content) != "alpha\nBETA\ngamma\n" {
		t.Fatalf("content = %q", string(content))
	}
}

func TestFSEditMultipleEditsApplyIncrementally(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("alpha\nbeta\n"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	res := d.handleFSEdit(editRequest(t, fsEditParams{
		Path: "a.txt",
		Edits: []fsEditItem{
			{OldText: "alpha", NewText: "ALPHA"},
			{OldText: "beta", NewText: "BETA"},
		},
	}))
	if _, ok := res.(map[string]interface{}); !ok {
		t.Fatalf("expected edit to succeed, got %T (%v)", res, res)
	}
	content, err := os.ReadFile(filepath.Join(root, "a.txt"))
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	if string(content) != "ALPHA\nBETA\n" {
		t.Fatalf("content = %q", string(content))
	}
}

func TestFSEditMatchErrors(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("alpha\nalpha\nbeta\n"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	notFound := d.handleFSEdit(editRequest(t, fsEditParams{Path: "a.txt", Edits: []fsEditItem{{OldText: "missing", NewText: "x"}}}))
	failed, ok := notFound.(protocol.RPCFailed)
	if !ok {
		t.Fatalf("expected EDIT_NOT_FOUND, got %T (%v)", notFound, notFound)
	}
	if failed.Error.Code != "EDIT_NOT_FOUND" {
		t.Fatalf("error code = %q, want EDIT_NOT_FOUND", failed.Error.Code)
	}

	notUnique := d.handleFSEdit(editRequest(t, fsEditParams{Path: "a.txt", Edits: []fsEditItem{{OldText: "alpha", NewText: "x"}}}))
	failed, ok = notUnique.(protocol.RPCFailed)
	if !ok {
		t.Fatalf("expected EDIT_NOT_UNIQUE, got %T (%v)", notUnique, notUnique)
	}
	if failed.Error.Code != "EDIT_NOT_UNIQUE" {
		t.Fatalf("error code = %q, want EDIT_NOT_UNIQUE", failed.Error.Code)
	}

	// A failed edit must not modify the file.
	content, err := os.ReadFile(filepath.Join(root, "a.txt"))
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	if string(content) != "alpha\nalpha\nbeta\n" {
		t.Fatalf("failed edit modified content: %q", string(content))
	}
}

func TestFSEditMissingFile(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)

	res := d.handleFSEdit(editRequest(t, fsEditParams{Path: "missing.txt", Edits: []fsEditItem{{OldText: "x", NewText: "y"}}}))
	failed, ok := res.(protocol.RPCFailed)
	if !ok {
		t.Fatalf("expected failure for missing file, got %T (%v)", res, res)
	}
	if failed.Error.Code != "NOT_FOUND" {
		t.Fatalf("error code = %q, want NOT_FOUND", failed.Error.Code)
	}
}

func TestFSEditConcurrentDisjointRegions(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	// A larger file widens the read-modify-write window so the race is
	// observable without the per-path lock.
	var seed strings.Builder
	for i := 0; i < 20000; i++ {
		fmt.Fprintf(&seed, "line-%05d\n", i)
	}
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte(seed.String()), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	// Concurrent edits to disjoint regions must all land: each edit reads the
	// latest content inside the per-path lock, so no edit is based on stale
	// content. Without the lock, the last writer would silently drop the
	// earlier edits.
	const rounds = 16
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < rounds; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			var item fsEditItem
			if i%2 == 0 {
				item = fsEditItem{OldText: "line-00001", NewText: "ALPHA"}
			} else {
				item = fsEditItem{OldText: "line-19999", NewText: "GAMMA"}
			}
			raw, err := json.Marshal(fsEditParams{Path: "a.txt", Edits: []fsEditItem{item}})
			if err != nil {
				return
			}
			req := protocol.RPCRequest{
				RequestScopedMessage: protocol.RequestScopedMessage{RequestID: fmt.Sprintf("req-%d", i)},
				Method:               "fs.edit",
				Params:               raw,
			}
			d.handleFSEdit(req)
		}(i)
	}
	close(start)
	wg.Wait()

	content, err := os.ReadFile(filepath.Join(root, "a.txt"))
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	text := string(content)
	if strings.Contains(text, "line-00001") || strings.Contains(text, "line-19999") {
		t.Fatalf("concurrent edits lost updates (line-00001 or line-19999 still present)")
	}
	if !strings.Contains(text, "ALPHA") || !strings.Contains(text, "GAMMA") {
		t.Fatalf("concurrent edits did not both land: %q", text[:80])
	}
}

func mkdirRequest(t *testing.T, params fsMkdirParams) protocol.RPCRequest {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal mkdir params: %v", err)
	}
	return protocol.RPCRequest{
		RequestScopedMessage: protocol.RequestScopedMessage{RequestID: "req-mkdir"},
		Method:               "fs.mkdir",
		Params:               raw,
	}
}

func TestFSMutationsReportFileParentAsNotDirectory(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	if err := os.WriteFile(filepath.Join(root, "parent-file"), []byte("keep"), 0o644); err != nil {
		t.Fatalf("write parent file: %v", err)
	}

	results := []interface{}{
		d.handleFSWrite(writeRequest(t, fsWriteParams{Path: "parent-file/child.txt", Content: "content"})),
		d.handleFSMkdir(mkdirRequest(t, fsMkdirParams{Path: "parent-file/child"})),
	}
	for index, result := range results {
		failed, ok := result.(protocol.RPCFailed)
		if !ok {
			t.Fatalf("mutation %d: expected failure, got %T (%v)", index, result, result)
		}
		if failed.Error.Code != "NOT_DIRECTORY" {
			t.Fatalf("mutation %d: error code = %q, want NOT_DIRECTORY", index, failed.Error.Code)
		}
	}

	content, err := os.ReadFile(filepath.Join(root, "parent-file"))
	if err != nil {
		t.Fatalf("read parent file: %v", err)
	}
	if string(content) != "keep" {
		t.Fatalf("parent file content = %q, want unchanged", content)
	}
}

func TestFSWriteReportsCreatedFileAndParentDirectories(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)

	res := d.handleFSWrite(writeRequest(t, fsWriteParams{Path: "aa/bb/c.txt", Content: "one"}))
	result, ok := res.(map[string]interface{})
	if !ok {
		t.Fatalf("expected nested write to succeed, got %T (%v)", res, res)
	}
	if created, _ := result["created"].(bool); !created {
		t.Fatalf("expected created=true, got %v", result["created"])
	}
	createdDirs, _ := result["createdDirs"].([]string)
	if !reflect.DeepEqual(createdDirs, []string{"aa", "aa/bb"}) {
		t.Fatalf("createdDirs = %v, want [aa aa/bb]", createdDirs)
	}

	res = d.handleFSWrite(writeRequest(t, fsWriteParams{Path: "aa/bb/c.txt", Content: "two"}))
	result, ok = res.(map[string]interface{})
	if !ok {
		t.Fatalf("expected overwrite to succeed, got %T (%v)", res, res)
	}
	if created, _ := result["created"].(bool); created {
		t.Fatalf("expected created=false for overwrite")
	}
	createdDirs, _ = result["createdDirs"].([]string)
	if len(createdDirs) != 0 {
		t.Fatalf("createdDirs = %v, want none", createdDirs)
	}
}

func TestFSWriteSourceExpectedVersion(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	target := filepath.Join(root, "source.txt")
	staging := filepath.Join(root, ".cohub-upload.source")
	if err := os.WriteFile(target, []byte("old"), 0o644); err != nil {
		t.Fatalf("seed target: %v", err)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("stat target: %v", err)
	}
	if err := os.WriteFile(staging, []byte("uploaded"), 0o600); err != nil {
		t.Fatalf("write staging file: %v", err)
	}

	res := d.handleFSWrite(writeRequest(t, fsWriteParams{
		Path:       "source.txt",
		SourcePath: staging,
		Expected:   &fsWriteVersion{Size: info.Size(), MtimeMs: protocol.FileTimeMs(info.ModTime())},
	}))
	if _, ok := res.(map[string]interface{}); !ok {
		t.Fatalf("expected source install to succeed, got %T (%v)", res, res)
	}
	content, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	if string(content) != "uploaded" {
		t.Fatalf("target content = %q, want uploaded", content)
	}
	if _, err := os.Stat(staging); !os.IsNotExist(err) {
		t.Fatalf("staging file should be consumed, stat error = %v", err)
	}
}

func TestFSWriteSourceExpectedVersionMatchesNodeMtime(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	target := filepath.Join(root, "copied.txt")
	staging := filepath.Join(root, ".cohub-upload.copied")
	if err := os.WriteFile(target, []byte("old"), 0o644); err != nil {
		t.Fatalf("seed target: %v", err)
	}
	mtime := time.Unix(1795066953, 793999910)
	if err := os.Chtimes(target, mtime, mtime); err != nil {
		t.Fatalf("set mtime: %v", err)
	}
	if err := os.WriteFile(staging, []byte("copied"), 0o600); err != nil {
		t.Fatalf("write staging file: %v", err)
	}

	res := d.handleFSWrite(writeRequest(t, fsWriteParams{
		Path:       "copied.txt",
		SourcePath: staging,
		Expected:   &fsWriteVersion{Size: 3, MtimeMs: 1795066953794},
	}))
	if _, ok := res.(map[string]interface{}); !ok {
		t.Fatalf("expected source install to succeed, got %T (%v)", res, res)
	}
}

func TestFSWriteSourceExpectedVersionConflict(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	target := filepath.Join(root, "source-conflict.txt")
	staging := filepath.Join(root, ".cohub-upload.conflict")
	if err := os.WriteFile(target, []byte("old"), 0o644); err != nil {
		t.Fatalf("seed target: %v", err)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("stat target: %v", err)
	}
	if err := os.WriteFile(staging, []byte("uploaded"), 0o600); err != nil {
		t.Fatalf("write staging file: %v", err)
	}
	if err := os.WriteFile(target, []byte("edited by user"), 0o644); err != nil {
		t.Fatalf("edit target: %v", err)
	}

	res := d.handleFSWrite(writeRequest(t, fsWriteParams{
		Path:       "source-conflict.txt",
		SourcePath: staging,
		Expected:   &fsWriteVersion{Size: info.Size(), MtimeMs: protocol.FileTimeMs(info.ModTime())},
	}))
	failed, ok := res.(protocol.RPCFailed)
	if !ok {
		t.Fatalf("expected source install conflict, got %T (%v)", res, res)
	}
	if failed.Error.Code != "CONFLICT" {
		t.Fatalf("error code = %q, want CONFLICT", failed.Error.Code)
	}
	content, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	if string(content) != "edited by user" {
		t.Fatalf("conflict clobbered target: %q", content)
	}
	if _, err := os.Stat(staging); err != nil {
		t.Fatalf("staging file should remain for cleanup, stat error = %v", err)
	}
}

func TestFSWriteSourceExclusiveCreate(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	staging := filepath.Join(root, ".cohub-upload.create")
	if err := os.WriteFile(staging, []byte("created"), 0o600); err != nil {
		t.Fatalf("write staging file: %v", err)
	}

	res := d.handleFSWrite(writeRequest(t, fsWriteParams{
		Path:       "created-from-upload.txt",
		SourcePath: staging,
		Exclusive:  true,
	}))
	if _, ok := res.(map[string]interface{}); !ok {
		t.Fatalf("expected source create to succeed, got %T (%v)", res, res)
	}
	content, err := os.ReadFile(filepath.Join(root, "created-from-upload.txt"))
	if err != nil {
		t.Fatalf("read created target: %v", err)
	}
	if string(content) != "created" {
		t.Fatalf("target content = %q, want created", content)
	}
	if _, err := os.Stat(staging); !os.IsNotExist(err) {
		t.Fatalf("staging file should be consumed, stat error = %v", err)
	}
}

func TestFSWriteSourceExclusiveCreateConflict(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	staging := filepath.Join(root, ".cohub-upload.create-conflict")
	if err := os.WriteFile(staging, []byte("uploaded"), 0o600); err != nil {
		t.Fatalf("write staging file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "created-by-user.txt"), []byte("user"), 0o644); err != nil {
		t.Fatalf("create target: %v", err)
	}

	res := d.handleFSWrite(writeRequest(t, fsWriteParams{
		Path:       "created-by-user.txt",
		SourcePath: staging,
		Exclusive:  true,
	}))
	failed, ok := res.(protocol.RPCFailed)
	if !ok {
		t.Fatalf("expected source create conflict, got %T (%v)", res, res)
	}
	if failed.Error.Code != "ALREADY_EXISTS" {
		t.Fatalf("error code = %q, want ALREADY_EXISTS", failed.Error.Code)
	}
	content, err := os.ReadFile(filepath.Join(root, "created-by-user.txt"))
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	if string(content) != "user" {
		t.Fatalf("exclusive conflict clobbered target: %q", content)
	}
}

func TestFSWriteExclusive(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)

	// First exclusive create succeeds.
	res := d.handleFSWrite(writeRequest(t, fsWriteParams{Path: "new.txt", Content: "one", Exclusive: true}))
	if _, ok := res.(map[string]interface{}); !ok {
		t.Fatalf("expected first exclusive create to succeed, got %T (%v)", res, res)
	}

	// Second exclusive create on the same path must fail ALREADY_EXISTS and not
	// clobber the original content.
	res2 := d.handleFSWrite(writeRequest(t, fsWriteParams{Path: "new.txt", Content: "two", Exclusive: true}))
	failed, ok := res2.(protocol.RPCFailed)
	if !ok {
		t.Fatalf("expected second exclusive create to fail, got %T", res2)
	}
	if failed.Error.Code != "ALREADY_EXISTS" {
		t.Fatalf("expected ALREADY_EXISTS, got %s", failed.Error.Code)
	}
	got, _ := os.ReadFile(filepath.Join(root, "new.txt"))
	if string(got) != "one" {
		t.Fatalf("exclusive create clobbered content: got %q", string(got))
	}
}

func TestResolvePathLockKeySymlinkAliases(t *testing.T) {
	root := setupTree(t)
	target := filepath.Join(root, "target.txt")
	if err := os.WriteFile(target, []byte("x"), 0o644); err != nil {
		t.Fatalf("seed target: %v", err)
	}
	for _, alias := range []string{"alias-a.txt", "alias-b.txt"} {
		if err := os.Symlink(target, filepath.Join(root, alias)); err != nil {
			t.Fatalf("create %s: %v", alias, err)
		}
	}

	// Distinct symlink aliases must resolve to the same lock key so writes
	// through either alias serialize against the same target file.
	keyA := resolvePathLockKey(filepath.Join(root, "alias-a.txt"))
	keyB := resolvePathLockKey(filepath.Join(root, "alias-b.txt"))
	if keyA != keyB {
		t.Fatalf("alias lock keys differ: %q vs %q", keyA, keyB)
	}
	if keyA != target {
		t.Fatalf("alias lock key = %q, want target %q", keyA, target)
	}

	// A path that does not exist yet falls back to the lexical path: there is
	// no symlink to resolve when the file is about to be created.
	missing := filepath.Join(root, "missing.txt")
	if key := resolvePathLockKey(missing); key != missing {
		t.Fatalf("missing path lock key = %q, want lexical %q", key, missing)
	}
}

func TestResolvePathLockKeySymlinkedParentMissingLeaf(t *testing.T) {
	root := setupTree(t)
	realDir := filepath.Join(root, "real")
	if err := os.Mkdir(realDir, 0o755); err != nil {
		t.Fatalf("mkdir real: %v", err)
	}
	if err := os.Symlink(realDir, filepath.Join(root, "alias")); err != nil {
		t.Fatalf("create alias dir: %v", err)
	}

	// The leaf file does not exist yet, so EvalSymlinks on the full path
	// fails; the longest existing ancestor (the symlinked parent) must still
	// be resolved so both aliases share one lock for the about-to-be-created
	// file.
	keyReal := resolvePathLockKey(filepath.Join(realDir, "new.txt"))
	keyAlias := resolvePathLockKey(filepath.Join(root, "alias", "new.txt"))
	if keyReal != keyAlias {
		t.Fatalf("symlinked-parent lock keys differ: %q vs %q", keyReal, keyAlias)
	}
	if keyReal != filepath.Join(realDir, "new.txt") {
		t.Fatalf("lock key = %q, want %q", keyReal, filepath.Join(realDir, "new.txt"))
	}
}

func TestFSWriteConcurrentSymlinkAliases(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	target := filepath.Join(root, "target.txt")
	if err := os.WriteFile(target, []byte(""), 0o644); err != nil {
		t.Fatalf("seed target: %v", err)
	}
	if err := os.Symlink(target, filepath.Join(root, "alias-a.txt")); err != nil {
		t.Fatalf("create alias-a: %v", err)
	}
	if err := os.Symlink(target, filepath.Join(root, "alias-b.txt")); err != nil {
		t.Fatalf("create alias-b: %v", err)
	}

	// Writes through distinct symlink aliases target the same file and must
	// share one per-path lock, otherwise the shorter write can leave the
	// longer content's tail behind (torn write).
	contents := []string{
		strings.Repeat("a", 4096),
		strings.Repeat("b", 2048),
	}
	paths := []string{"alias-a.txt", "alias-b.txt"}
	const rounds = 12
	var wg sync.WaitGroup
	for i := 0; i < rounds; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			raw, err := json.Marshal(fsWriteParams{Path: paths[i%2], Content: contents[i%2]})
			if err != nil {
				return
			}
			req := protocol.RPCRequest{
				RequestScopedMessage: protocol.RequestScopedMessage{RequestID: fmt.Sprintf("req-%d", i)},
				Method:               "fs.write",
				Params:               raw,
			}
			d.handleFSWrite(req)
		}(i)
	}
	wg.Wait()

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	wantLen := 4096
	if got[0] == 'b' {
		wantLen = 2048
	}
	if len(got) != wantLen {
		t.Fatalf("torn write via symlink aliases: length = %d, want %d", len(got), wantLen)
	}
	for index, b := range got {
		if b != got[0] {
			t.Fatalf("torn write via symlink aliases: mixed content at byte %d", index)
		}
	}
}

func TestFSTreeRootUnreadable(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	// A non-existent root surfaces NOT_FOUND (stat) rather than an empty tree.
	res := d.handleFSTree(treeRequest(t, fsTreeParams{Path: "does-not-exist", Depth: 1}))
	if _, ok := res.(protocol.RPCFailed); !ok {
		t.Fatalf("expected failure for missing root, got %T", res)
	}
}

func writeResultVersion(t *testing.T, res interface{}) (size int64, mtimeMs int64) {
	t.Helper()
	result, ok := res.(map[string]interface{})
	if !ok {
		t.Fatalf("expected write to succeed, got %T (%v)", res, res)
	}
	written, ok := result["bytesWritten"].(int)
	if !ok {
		t.Fatalf("write result missing bytesWritten: %v", result)
	}
	size = int64(written)
	mtimeMs, ok = result["mtimeMs"].(int64)
	if !ok {
		t.Fatalf("write result missing mtimeMs: %v", result)
	}
	return size, mtimeMs
}

func TestFSWriteExpectedVersionMatches(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)

	size, mtimeMs := writeResultVersion(t, d.handleFSWrite(writeRequest(t, fsWriteParams{Path: "v.txt", Content: "one"})))

	res := d.handleFSWrite(writeRequest(t, fsWriteParams{
		Path:     "v.txt",
		Content:  "two",
		Expected: &fsWriteVersion{Size: size, MtimeMs: mtimeMs},
	}))
	if _, ok := res.(map[string]interface{}); !ok {
		t.Fatalf("expected versioned write to succeed, got %T (%v)", res, res)
	}
	content, err := os.ReadFile(filepath.Join(root, "v.txt"))
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	if string(content) != "two" {
		t.Fatalf("content = %q, want %q", string(content), "two")
	}
}

func TestFSWriteExpectedVersionConflict(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)

	size, mtimeMs := writeResultVersion(t, d.handleFSWrite(writeRequest(t, fsWriteParams{Path: "v.txt", Content: "one"})))
	// Another writer modifies the file after the baseline was captured.
	d.handleFSWrite(writeRequest(t, fsWriteParams{Path: "v.txt", Content: "changed by someone else"}))

	res := d.handleFSWrite(writeRequest(t, fsWriteParams{
		Path:     "v.txt",
		Content:  "mine",
		Expected: &fsWriteVersion{Size: size, MtimeMs: mtimeMs},
	}))
	failed, ok := res.(protocol.RPCFailed)
	if !ok {
		t.Fatalf("expected version conflict, got %T (%v)", res, res)
	}
	if failed.Error.Code != "CONFLICT" {
		t.Fatalf("error code = %q, want CONFLICT", failed.Error.Code)
	}
	content, err := os.ReadFile(filepath.Join(root, "v.txt"))
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	if string(content) != "changed by someone else" {
		t.Fatalf("conflicting write clobbered content: got %q", string(content))
	}
}

func TestFSWriteExpectedVersionMissingFile(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)

	res := d.handleFSWrite(writeRequest(t, fsWriteParams{
		Path:     "missing.txt",
		Content:  "x",
		Expected: &fsWriteVersion{Size: 0, MtimeMs: 123},
	}))
	failed, ok := res.(protocol.RPCFailed)
	if !ok {
		t.Fatalf("expected version conflict for missing file, got %T (%v)", res, res)
	}
	if failed.Error.Code != "CONFLICT" {
		t.Fatalf("error code = %q, want CONFLICT", failed.Error.Code)
	}
}

func TestFSWriteConcurrentSamePath(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	path := filepath.Join(root, "concurrent.txt")
	if err := os.WriteFile(path, []byte(""), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	// Unequal lengths are required to expose torn writes: a shorter write that
	// lands after a longer one leaves the longer content's tail in the file.
	contents := []string{
		strings.Repeat("a", 4096),
		strings.Repeat("b", 2048),
	}
	const rounds = 12
	var wg sync.WaitGroup
	for i := 0; i < rounds; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			raw, err := json.Marshal(fsWriteParams{Path: "concurrent.txt", Content: contents[i%2]})
			if err != nil {
				return
			}
			req := protocol.RPCRequest{
				RequestScopedMessage: protocol.RequestScopedMessage{RequestID: fmt.Sprintf("req-%d", i)},
				Method:               "fs.write",
				Params:               raw,
			}
			d.handleFSWrite(req)
		}(i)
	}
	wg.Wait()

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	wantLen := 4096
	if got[0] == 'b' {
		wantLen = 2048
	}
	if len(got) != wantLen {
		t.Fatalf("torn write: length = %d, want %d", len(got), wantLen)
	}
	for index, b := range got {
		if b != got[0] {
			t.Fatalf("torn write: mixed content at byte %d", index)
		}
	}
}
