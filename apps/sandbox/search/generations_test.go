package search

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/filewatch"
)

func waitFor(t *testing.T, description string, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("timed out: " + description)
}

func liveSchemaManager(t *testing.T, workspace, index, schema string) *Manager {
	t.Helper()
	binary := os.Getenv("COHUB_SEARCH_TEST_BIN")
	if binary == "" {
		t.Skip("set COHUB_SEARCH_TEST_BIN for schema lifecycle integration tests")
	}
	binary, err := filepath.Abs(binary)
	if err != nil {
		t.Fatal(err)
	}
	run, err := os.MkdirTemp("", "schema-run-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(run) })
	manager := NewManager(env.Config{Mode: env.ModeListen, SpaceID: "space", SearchEnabled: true, SearchBinaryPath: binary, SearchSchemaPath: schema, SearchIndexDir: index, SearchSocketPath: filepath.Join(run, "s"), WorkspaceDir: workspace}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	manager.schemaPollInterval = 30 * time.Millisecond
	manager.Start()
	t.Cleanup(manager.Close)
	manager.Activate()
	waitFor(t, "initial schema activation", manager.ProcessReady)
	return manager
}

func writeSchema(t *testing.T, path string, version int, stored bool) {
	t.Helper()
	definition := defaultWorkspaceDefinition()
	definition.SchemaVersion = version
	definition.Fields["content"] = fieldDefinition{Kind: "trigram", Stored: stored}
	body, err := json.Marshal(definition)
	if err != nil {
		t.Fatal(err)
	}
	if err := atomicFile(path, body); err != nil {
		t.Fatal(err)
	}
}

func waitVersion(t *testing.T, manager *Manager, version int) *searchGeneration {
	t.Helper()
	waitFor(t, "schema version activation", func() bool {
		generation := testGeneration(manager)
		return generation != nil && generation.definition.SchemaVersion == version && manager.ProcessReady()
	})
	return testGeneration(manager)
}

func TestSchemaFallbackLiveUpdateInvalidConfigAndRestart(t *testing.T) {
	workspace, index, config := t.TempDir(), t.TempDir(), t.TempDir()
	schema := filepath.Join(config, "workspace.json")
	putFile(t, workspace, "file.txt", "initial needle")
	manager := liveSchemaManager(t, workspace, index, schema)
	initial := testGeneration(manager)
	if initial.definition.SchemaVersion != 1 {
		t.Fatal(initial.definition)
	}
	if _, err := os.Stat(schema); !os.IsNotExist(err) {
		t.Fatal("fallback wrote Platform Config")
	}
	if got := queryPaths(t, manager, "needle", "", ""); !reflect.DeepEqual(got, []string{"file.txt"}) {
		t.Fatal(got)
	}

	// Content change without a version bump must still rebuild.
	writeSchema(t, schema, 1, true)
	waitFor(t, "same-version content change", func() bool { return testGeneration(manager).fingerprint != initial.fingerprint })
	configured := testGeneration(manager)
	result, err := configured.client.query(context.Background(), documentQuery{Terms: []searchTerm{}, Filters: configured.workspace.filters(), Limit: 10})
	if err != nil || result.Hits[0].Fields["content"] != "initial needle" {
		t.Fatalf("result=%+v err=%v", result, err)
	}

	// Formatting and property order alone must not rebuild.
	body := []byte(`{"fields":{"fingerprint":{"stored":true,"kind":"keyword"},"content":{"stored":true,"kind":"trigram"}},"schemaVersion":1,"family":"workspace.candidates"}`)
	if err := atomicFile(schema, body); err != nil {
		t.Fatal(err)
	}
	time.Sleep(120 * time.Millisecond)
	if testGeneration(manager) != configured {
		t.Fatal("formatting caused rebuild")
	}

	if err := atomicFile(schema, []byte("{")); err != nil {
		t.Fatal(err)
	}
	putFile(t, workspace, "file.txt", "changed needle")
	manager.Apply(filewatch.Batch{Changes: []filewatch.Change{{Path: "file.txt", Kind: "modify", NodeType: "file"}}})
	waitFor(t, "updates continue under invalid schema", func() bool {
		result, err := manager.Query(context.Background(), QueryInput{Literals: []string{"changed"}, Limit: 10})
		return err == nil && len(result.Matches) == 1
	})
	if testGeneration(manager) != configured {
		t.Fatal("invalid config displaced active index")
	}

	manager.Close()
	manager = liveSchemaManager(t, workspace, index, schema)
	if testGeneration(manager).root != configured.root {
		t.Fatal("restart failed to restore last good index")
	}
	if got := queryPaths(t, manager, "changed", "", ""); len(got) != 1 {
		t.Fatal(got)
	}

	writeSchema(t, schema, 2, false)
	second := waitVersion(t, manager, 2)
	if second.root == configured.root {
		t.Fatal("schema rebuilt in active directory")
	}
	publicClient := newClient(manager.cfg.SearchSocketPath)
	status, err := publicClient.status(context.Background())
	publicClient.http.CloseIdleConnections()
	if err != nil || status.SchemaVersion != 2 {
		t.Fatalf("configured socket did not follow cutover: %+v %v", status, err)
	}
	second.cancel()
	waitFor(t, "published generation restarts", func() bool {
		generation := testGeneration(manager)
		return generation != nil && generation != second && generation.root == second.root && manager.ProcessReady()
	})
	if got := queryPaths(t, manager, "changed", "", ""); len(got) != 1 {
		t.Fatal(got)
	}
	// Removing the override returns to built-in config through the same safe rebuild.
	if err := os.Remove(schema); err != nil {
		t.Fatal(err)
	}
	waitVersion(t, manager, 1)
	if got := queryPaths(t, manager, "changed", "", ""); len(got) != 1 {
		t.Fatal(got)
	}
}

func TestSchemaRebuildKeepsQueriesAndRepairsQueuedChanges(t *testing.T) {
	workspace, index, config := t.TempDir(), t.TempDir(), t.TempDir()
	schema := filepath.Join(config, "workspace.json")
	putFile(t, workspace, "file.txt", "old needle")
	manager := liveSchemaManager(t, workspace, index, schema)
	original := testGeneration(manager)

	// Delay only the adapter's file enumeration to observe a rebuild in flight.
	realRG, err := exec.LookPath("rg")
	if err != nil {
		t.Fatal(err)
	}
	tools := t.TempDir()
	marker, release := filepath.Join(tools, "entered"), filepath.Join(tools, "release")
	script := "#!/bin/sh\ntouch \"$SCHEMA_TEST_ENTERED\"\nwhile [ ! -f \"$SCHEMA_TEST_RELEASE\" ]; do sleep 0.02; done\nexec \"$SCHEMA_TEST_RG\" \"$@\"\n"
	if err := os.WriteFile(filepath.Join(tools, "rg"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SCHEMA_TEST_ENTERED", marker)
	t.Setenv("SCHEMA_TEST_RELEASE", release)
	t.Setenv("SCHEMA_TEST_RG", realRG)
	t.Setenv("PATH", tools+string(os.PathListSeparator)+os.Getenv("PATH"))
	writeSchema(t, schema, 2, true)
	waitFor(t, "rebuild entered file scan", func() bool { _, err := os.Stat(marker); return err == nil })
	if got := queryPaths(t, manager, "old", "", ""); len(got) != 1 {
		t.Fatal(got)
	}
	if testGeneration(manager) != original {
		t.Fatal("unfinished index published")
	}
	putFile(t, workspace, "file.txt", "new needle")
	for i := 0; i < commandBufferSize+20; i++ {
		manager.Apply(filewatch.Batch{Changes: []filewatch.Change{{Path: "file.txt", Kind: "modify", NodeType: "file"}}})
	}
	// A newer config supersedes the in-flight candidate.
	writeSchema(t, schema, 3, true)
	if err := os.WriteFile(release, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	waitVersion(t, manager, 3)
	waitFor(t, "queued file changes applied", func() bool {
		result, err := manager.Query(context.Background(), QueryInput{Literals: []string{"new"}, Limit: 10})
		return err == nil && len(result.Matches) == 1
	})
	if got := queryPaths(t, manager, "old", "", ""); len(got) != 0 {
		t.Fatal(got)
	}
}

func TestSchemaEngineRejectionAndFailedBuildKeepActiveGeneration(t *testing.T) {
	workspace, index, config := t.TempDir(), t.TempDir(), t.TempDir()
	schema := filepath.Join(config, "workspace.json")
	putFile(t, workspace, "file.txt", "preserved needle")
	manager := liveSchemaManager(t, workspace, index, schema)
	original := testGeneration(manager)
	definition := defaultWorkspaceDefinition()
	definition.Fields["unsupported"] = fieldDefinition{Kind: "not-an-analyzer"}
	body, _ := json.Marshal(definition)
	if err := atomicFile(schema, body); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if testGeneration(manager) != original {
		t.Fatal("invalid engine schema replaced index")
	}
	if got := queryPaths(t, manager, "preserved", "", ""); len(got) != 1 {
		t.Fatal(got)
	}

	// Valid schema, unavailable source: candidate build fails, active data survives.
	moved := workspace + "-moved"
	if err := os.Rename(workspace, moved); err != nil {
		t.Fatal(err)
	}
	defer os.Rename(moved, workspace)
	writeSchema(t, schema, 4, false)
	time.Sleep(250 * time.Millisecond)
	if testGeneration(manager) != original {
		t.Fatal("failed build replaced index")
	}
	if got := queryPaths(t, manager, "preserved", "", ""); len(got) != 1 {
		t.Fatal(got)
	}
	if err := os.Rename(moved, workspace); err != nil {
		t.Fatal(err)
	}
	waitVersion(t, manager, 4)
}

func TestSchemaRebuildShutdownCancelsCandidateAndRetainsPublishedIndex(t *testing.T) {
	workspace, index, config := t.TempDir(), t.TempDir(), t.TempDir()
	schema := filepath.Join(config, "workspace.json")
	putFile(t, workspace, "file.txt", "retained needle")
	manager := liveSchemaManager(t, workspace, index, schema)
	original := testGeneration(manager)
	tools := t.TempDir()
	marker := filepath.Join(tools, "entered")
	if err := os.WriteFile(filepath.Join(tools, "rg"), []byte("#!/bin/sh\ntouch \"$SCHEMA_TEST_ENTERED\"\nexec sleep 30\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SCHEMA_TEST_ENTERED", marker)
	originalPath := os.Getenv("PATH")
	t.Setenv("PATH", tools+string(os.PathListSeparator)+originalPath)
	writeSchema(t, schema, 2, false)
	waitFor(t, "candidate scan", func() bool { _, err := os.Stat(marker); return err == nil })
	closed := make(chan struct{})
	go func() { manager.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown blocked on candidate")
	}
	definition, root, err := manager.initialDefinition()
	if err != nil || root != original.root || definition.SchemaVersion != 1 {
		t.Fatalf("published generation lost: %s %+v %v", root, definition, err)
	}
	select {
	case <-original.done:
	default:
		t.Fatal("active process survived shutdown")
	}
	entries, err := os.ReadDir(filepath.Join(index, "generations"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("unpublished candidate was not cleaned: %v %v", entries, err)
	}
}
