package rpc

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/process"
	"github.com/cohub/apps/sandbox/protocol"
	"github.com/cohub/apps/sandbox/search"
)

func searchRequest(t *testing.T, method string, params interface{}) protocol.RPCRequest {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	return protocol.RPCRequest{
		RequestScopedMessage: protocol.RequestScopedMessage{RequestID: "req-1"},
		Method:               method,
		Params:               raw,
	}
}

func TestSearchFallsBackWithoutAnEnabledIndex(t *testing.T) {
	root := t.TempDir()
	cfg := env.Config{WorkspaceDir: root, Fence: true}
	d := NewDispatcher(cfg, process.NewManager(slog.Default()), slog.Default())

	result, ok := d.handleFSSearch(searchRequest(t, "fs.search", fsSearchParams{Pattern: "needle"})).(map[string]interface{})
	if !ok || result["fallback"] != search.FallbackUnavailable {
		t.Fatalf("fs.search without a manager = %#v", result)
	}

	d.SetSearchManager(search.NewManager(env.Config{Mode: env.ModeListen, SearchEnabled: false}, slog.Default(), nil))
	result, ok = d.handleFSPathSearch(searchRequest(t, "fs.pathSearch", fsPathSearchParams{Pattern: "*.ts"})).(map[string]interface{})
	if !ok || result["fallback"] != search.FallbackUnavailable {
		t.Fatalf("fs.pathSearch with a disabled manager = %#v", result)
	}
}

func TestSearchScopeMapsPathsToWorkspaceRelativeRoots(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	d := NewDispatcher(env.Config{WorkspaceDir: root}, process.NewManager(slog.Default()), slog.Default())
	d.SetSearchManager(search.NewManager(env.Config{Mode: env.ModeListen, SearchEnabled: true}, slog.Default(), nil))

	for path, want := range map[string]string{root: "", filepath.Join(root, "src"): "src"} {
		if _, got, fallback := d.searchScope(path); fallback != "" || got != want {
			t.Fatalf("searchScope(%q) = %q, %q", path, got, fallback)
		}
	}
	if _, _, fallback := d.searchScope(filepath.Dir(root)); fallback != "scope" {
		t.Fatalf("path outside the workspace fallback = %q", fallback)
	}
	if got := relativeToRoot("src", []string{"src/a.ts", "src/sub/b.ts"}); !reflect.DeepEqual(got, []string{"a.ts", "sub/b.ts"}) {
		t.Fatalf("relativeToRoot = %v", got)
	}
	if got := relativeToRoot("", []string{"a.ts"}); !reflect.DeepEqual(got, []string{"a.ts"}) {
		t.Fatalf("relativeToRoot at the workspace root = %v", got)
	}
}

func TestReconcileInvalidatesOnlyAnEnabledIndex(t *testing.T) {
	d := NewDispatcher(env.Config{WorkspaceDir: t.TempDir()}, process.NewManager(slog.Default()), slog.Default())
	invalidated := func() interface{} {
		t.Helper()
		_, response := d.Handle(searchRequest(t, "fs.reconcile", struct{}{}), "")
		completed, ok := response.(protocol.RPCCompleted)
		if !ok {
			t.Fatalf("fs.reconcile response = %#v", response)
		}
		return completed.Result.(map[string]interface{})["invalidated"]
	}

	if got := invalidated(); got != false {
		t.Fatalf("without a manager invalidated = %v", got)
	}
	d.SetSearchManager(search.NewManager(env.Config{Mode: env.ModeListen, SearchEnabled: false}, slog.Default(), nil))
	if got := invalidated(); got != false {
		t.Fatalf("with a disabled manager invalidated = %v", got)
	}
	d.SetSearchManager(search.NewManager(env.Config{Mode: env.ModeListen, SearchEnabled: true}, slog.Default(), nil))
	if got := invalidated(); got != true {
		t.Fatalf("with an enabled manager invalidated = %v", got)
	}
}
