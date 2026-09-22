package search

import (
	"context"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/filewatch"
)

func putFile(t *testing.T, root, path, content string) {
	t.Helper()
	full := filepath.Join(root, path)
	if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestWorkspaceEnumerationHonorsNestedIgnoresWithoutRepository(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg is required")
	}
	root := t.TempDir()
	t.Setenv("FS_WATCH_IGNORE", "custom/cache,.idea,../invalid")
	for path, content := range map[string]string{
		".gitignore": "*.log\n", "nested/.gitignore": "!keep.log\n",
		"hidden.log": "secret", "nested/keep.log": "visible", "nested/skip.log": "secret",
		"visible.txt": "visible", ".hidden.txt": "visible", "node_modules/pkg.txt": "secret",
		"custom/cache/secret.txt": "secret", ".idea/config": "secret",
	} {
		putFile(t, root, path, content)
	}
	files, err := workspaceFiles(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{".gitignore", ".hidden.txt", "nested/.gitignore", "nested/keep.log", "visible.txt"}
	if !reflect.DeepEqual(files, want) {
		t.Fatalf("files = %v, want %v", files, want)
	}
}

func TestWorkspaceEnumerationAcceptsEmptyWorkspace(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg is required")
	}
	files, err := workspaceFiles(context.Background(), t.TempDir())
	if err != nil || len(files) != 0 {
		t.Fatalf("files=%v err=%v", files, err)
	}
}

func TestWorkspaceReaderRejectsSymlinksAndNonText(t *testing.T) {
	rootPath := t.TempDir()
	putFile(t, rootPath, "visible.txt", "hello")
	putFile(t, rootPath, "binary", "hello\x00world")
	putFile(t, rootPath, "bad-utf8", "hello\xff")
	if err := os.Symlink(filepath.Join(rootPath, "visible.txt"), filepath.Join(rootPath, "link")); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	adapter := workspaceAdapter{cfg: env.Config{SpaceID: "space"}}
	for _, path := range []string{"link", "binary", "bad-utf8"} {
		info, err := inspectFile(root, path)
		if err != nil {
			t.Fatal(err)
		}
		mutation, err := adapter.readMutation(root, path, info)
		if err != nil || mutation.Operation != "delete" {
			t.Fatalf("%s: %+v, %v", path, mutation, err)
		}
	}
	if _, err := inspectFile(root, "../escape"); err == nil {
		t.Fatal("accepted traversal")
	}
}

func startDocumentManager(t *testing.T, workspace, index string) *Manager {
	t.Helper()
	binary := os.Getenv("COHUB_SEARCH_TEST_BIN")
	if binary == "" {
		t.Skip("set COHUB_SEARCH_TEST_BIN to run the Rust/Go integration tests")
	}
	binary, err := filepath.Abs(binary)
	if err != nil {
		t.Fatal(err)
	}
	// Unix socket paths have a small platform limit, so avoid long test names.
	run, err := os.MkdirTemp("", "search-run-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(run) })
	manager := NewManager(env.Config{Mode: env.ModeListen, SpaceID: "space", SearchEnabled: true, SearchBinaryPath: binary, SearchSchemaPath: testWorkspaceSchema(t), SearchIndexDir: index, SearchSocketPath: filepath.Join(run, "search.sock"), WorkspaceDir: workspace}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	manager.Start()
	t.Cleanup(manager.Close)
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		generation := testGeneration(manager)
		if generation != nil {
			if _, err := generation.client.status(context.Background()); err == nil {
				return manager
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("search process did not become available")
	return nil
}

func testGeneration(manager *Manager) *searchGeneration {
	manager.generationMu.RLock()
	defer manager.generationMu.RUnlock()
	return manager.active
}

func queryPaths(t *testing.T, manager *Manager, literal, prefix, glob string) []string {
	t.Helper()
	result, err := manager.Query(context.Background(), QueryInput{Literals: []string{literal}, PathPrefix: prefix, Glob: glob, Limit: 1000})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(result.Matches)
	return result.Matches
}

func TestDocumentBinarySnapshotsSchemaWithoutChangingPlatformConfig(t *testing.T) {
	manager := startDocumentManager(t, t.TempDir(), t.TempDir())
	original, err := os.ReadFile(manager.cfg.SearchSchemaPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := testGeneration(manager).workspace.reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	snapshot, err := loadWorkspaceDefinition(filepath.Join(testGeneration(manager).root, "schema.json"))
	if err != nil || snapshot.Family != workspaceFamily {
		t.Fatalf("invalid generation schema: %+v %v", snapshot, err)
	}
	actual, err := os.ReadFile(manager.cfg.SearchSchemaPath)
	if err != nil || string(actual) != string(original) {
		t.Fatal("platform schema was changed")
	}
}

func TestDocumentBinaryWorkspaceLifecycle(t *testing.T) {
	workspace, index := t.TempDir(), t.TempDir()
	putFile(t, workspace, "src/file.txt", "first needle")
	putFile(t, workspace, "srcfoo/file.txt", "other needle")
	putFile(t, workspace, "src[a,b]/file.txt", "special needle")
	putFile(t, workspace, ".gitignore", "ignored.txt\n")
	putFile(t, workspace, "ignored.txt", "secret needle")
	manager := startDocumentManager(t, workspace, index)
	ctx := context.Background()
	if err := testGeneration(manager).workspace.reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if got := queryPaths(t, manager, "needle", "src", "*.txt"); !reflect.DeepEqual(got, []string{"src/file.txt"}) {
		t.Fatal(got)
	}
	if got := queryPaths(t, manager, "needle", "src/file.txt", ""); !reflect.DeepEqual(got, []string{"src/file.txt"}) {
		t.Fatal(got)
	}
	if got := queryPaths(t, manager, "needle", "src[a,b]", ""); !reflect.DeepEqual(got, []string{"src[a,b]/file.txt"}) {
		t.Fatal(got)
	}
	putFile(t, workspace, "src/file.txt", "updated content")
	if err := manager.sendBatch(ctx, filewatch.Batch{Changes: []filewatch.Change{{Path: "src/file.txt", Kind: "modify", NodeType: "file"}}}); err != nil {
		t.Fatal(err)
	}
	if got := queryPaths(t, manager, "needle", "src", ""); len(got) != 0 {
		t.Fatal(got)
	}
	if got := queryPaths(t, manager, "updated", "", ""); !reflect.DeepEqual(got, []string{"src/file.txt"}) {
		t.Fatal(got)
	}
	if err := os.Rename(filepath.Join(workspace, "src"), filepath.Join(workspace, "renamed")); err != nil {
		t.Fatal(err)
	}
	if err := manager.sendBatch(ctx, filewatch.Batch{Changes: []filewatch.Change{{Path: "renamed", OldPath: "src", Kind: "rename", NodeType: "dir"}}}); err != nil {
		t.Fatal(err)
	}
	if got := queryPaths(t, manager, "updated", "", ""); !reflect.DeepEqual(got, []string{"renamed/file.txt"}) {
		t.Fatal(got)
	}
	putFile(t, workspace, ".gitignore", "")
	if err := manager.sendBatch(ctx, filewatch.Batch{Changes: []filewatch.Change{{Path: ".gitignore", Kind: "modify", NodeType: "file"}}}); err != nil {
		t.Fatal(err)
	}
	if got := queryPaths(t, manager, "secret", "", ""); !reflect.DeepEqual(got, []string{"ignored.txt"}) {
		t.Fatal(got)
	}
	manager.Close()
	putFile(t, workspace, "renamed/file.txt", "restart reconciled")
	manager = startDocumentManager(t, workspace, index)
	if err := testGeneration(manager).workspace.reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if got := queryPaths(t, manager, "restart", "", ""); !reflect.DeepEqual(got, []string{"renamed/file.txt"}) {
		t.Fatal(got)
	}
	if err := os.RemoveAll(filepath.Join(workspace, "renamed")); err != nil {
		t.Fatal(err)
	}
	if err := manager.sendBatch(ctx, filewatch.Batch{Changes: []filewatch.Change{{Path: "renamed", Kind: "delete", NodeType: "dir"}}}); err != nil {
		t.Fatal(err)
	}
	if got := queryPaths(t, manager, "restart", "", ""); len(got) != 0 {
		t.Fatal(got)
	}
}

func TestDocumentBinaryActivationAndMetadataOnlyReconcile(t *testing.T) {
	workspace, index := t.TempDir(), t.TempDir()
	putFile(t, workspace, "file.txt", "persistent needle")
	manager := startDocumentManager(t, workspace, index)
	manager.Activate()
	deadline := time.Now().Add(5 * time.Second)
	for !manager.ProcessReady() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !manager.ProcessReady() {
		t.Fatal("manager activation did not finish")
	}
	if got := queryPaths(t, manager, "persistent", "", ""); !reflect.DeepEqual(got, []string{"file.txt"}) {
		t.Fatal(got)
	}
	// Use a fresh adapter to exercise durable fingerprints, not the memory cache.
	adapter := workspaceAdapter{cfg: manager.cfg, client: testGeneration(manager).client}
	path := filepath.Join(workspace, "file.txt")
	if err := os.Chmod(path, 0); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(path, 0o600)
	if err := adapter.reconcile(context.Background()); err != nil {
		t.Fatalf("unchanged file should not be reread: %v", err)
	}
	if got := queryPaths(t, manager, "persistent", "", ""); !reflect.DeepEqual(got, []string{"file.txt"}) {
		t.Fatal(got)
	}
}

func TestDocumentBinaryReconcileDoesNotAcknowledgeMissingWorkspace(t *testing.T) {
	workspace, index := t.TempDir(), t.TempDir()
	putFile(t, workspace, "file.txt", "keep needle")
	manager := startDocumentManager(t, workspace, index)
	ctx := context.Background()
	if err := testGeneration(manager).workspace.reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	testGeneration(manager).workspace.cfg.WorkspaceDir = filepath.Join(workspace, "missing")
	if err := testGeneration(manager).workspace.reconcile(ctx); err == nil {
		t.Fatal("missing source accepted")
	}
	result, err := manager.Query(ctx, QueryInput{Literals: []string{"needle"}, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if result.Coverage != "partial" || !reflect.DeepEqual(result.Matches, []string{"file.txt"}) {
		t.Fatalf("%+v", result)
	}
}

func TestDocumentBinaryReportsProtocolAndCoverage(t *testing.T) {
	workspace, index := t.TempDir(), t.TempDir()
	manager := startDocumentManager(t, workspace, index)
	if err := testGeneration(manager).workspace.reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	status, err := testGeneration(manager).client.status(context.Background())
	if err != nil || status.ProtocolVersion != documentProtocolVersion || status.Coverage != "complete" {
		t.Fatalf("status=%+v err=%v", status, err)
	}
	if strings.Contains(strings.Join(processArgs(manager.cfg), " "), "--workspace") {
		t.Fatal("binary still reads the workspace")
	}
}
