package rpc

import (
	"encoding/base64"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/process"
)

func newMountsDispatcher(t *testing.T) (*Dispatcher, env.Config) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(base, "cache")
	cfg := env.Config{
		Mode:              env.ModeLocal,
		WorkspaceDir:      filepath.Join(base, "workspace"),
		CacheDir:          cache,
		PlatformAgentsDir: filepath.Join(cache, "platform-agents"),
		UserAgentsDir:     filepath.Join(cache, "user-agents"),
		ModsDir:           filepath.Join(cache, "mods"),
		Fence:             true,
	}
	for _, dir := range []string{cfg.WorkspaceDir, cfg.PlatformAgentsDir, cfg.UserAgentsDir, cfg.ModsDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return NewDispatcher(cfg, process.NewManager(slog.Default()), slog.Default()), cfg
}

func syncedRevision(t *testing.T, result interface{}, mountPath string) string {
	t.Helper()
	for _, status := range result.(map[string]interface{})["mounts"].([]mountStatus) {
		if status.Path == mountPath {
			return status.Revision
		}
	}
	t.Fatalf("mount %s missing from %v", mountPath, result)
	return ""
}

func TestMountsSyncWriteAndFence(t *testing.T) {
	d, cfg := newMountsDispatcher(t)
	content := base64.StdEncoding.EncodeToString([]byte("skill"))
	write := func(revision string, files []mountFile, final bool) interface{} {
		return d.handleMountsWrite(mutationRequest(t, "mounts.write", mountWriteParams{Path: "/mods/demo", Revision: revision, UploadID: "u-" + revision, Files: files, Final: final}))
	}

	if code := failureCode(t, write("r1", []mountFile{{Path: "../escape", ContentBase64: content}}, true)); code != "BAD_REQUEST" {
		t.Fatalf("escaping file path: got %q", code)
	}
	write("r1", []mountFile{{Path: ".agents/skills/demo/SKILL.md", ContentBase64: content}}, false)
	if code := failureCode(t, write("r1", []mountFile{{Path: "run.sh", ContentBase64: content, Executable: true}}, true)); code != "" {
		t.Fatalf("final write failed: %s", code)
	}

	result := d.handleMountsSync(mutationRequest(t, "mounts.sync", mountSyncParams{Mounts: []mountSpec{{Path: "/mods/demo"}, {Path: "/configs/platform/.agents"}}}))
	if got := syncedRevision(t, result, "/mods/demo"); got != "r1" {
		t.Fatalf("revision: got %q", got)
	}

	resolved, err := resolveSandboxPath(cfg, "/mods/demo/.agents/skills/demo/SKILL.md", "/workspace")
	if err != nil || resolved.path != filepath.Join(cfg.ModsDir, "demo", ".agents", "skills", "demo", "SKILL.md") {
		t.Fatalf("virtual mount path: %v %q", err, resolved.path)
	}
	if !isReadOnlyPath(cfg, resolved.path) {
		t.Fatalf("mount files must be read-only to tools")
	}
	if _, err := resolveSandboxPath(cfg, filepath.Join(cfg.CacheDir, "mounts.json"), "/workspace"); err == nil {
		t.Fatalf("mount state outside the mount roots must stay fenced")
	}

	if err := ClearMounts(cfg); err != nil {
		t.Fatal(err)
	}
	if got := syncedRevision(t, d.handleMountsSync(mutationRequest(t, "mounts.sync", mountSyncParams{Mounts: []mountSpec{{Path: "/mods/demo"}}})), "/mods/demo"); got != "" {
		t.Fatalf("cleared mounts must be re-synced, got revision %q", got)
	}
	write("r2", []mountFile{{Path: "run.sh", ContentBase64: content}}, true)

	d.handleMountsSync(mutationRequest(t, "mounts.sync", mountSyncParams{}))
	if _, err := os.Stat(filepath.Join(cfg.ModsDir, "demo")); !os.IsNotExist(err) {
		t.Fatalf("undesired mod should be removed: %v", err)
	}
	if code := failureCode(t, d.handleMountsSync(mutationRequest(t, "mounts.sync", mountSyncParams{Mounts: []mountSpec{{Path: "/mods/../etc"}}}))); code != "BAD_REQUEST" {
		t.Fatalf("invalid mount path: got %q", code)
	}
}
