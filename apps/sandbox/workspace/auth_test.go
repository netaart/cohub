package workspace

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/cohub/apps/sandbox/env"
)

func TestSetupDoesNotInheritSandboxCredentials(t *testing.T) {
	t.Setenv("COHUB_SPACE_ID", "test-space")
	t.Setenv("WORKSPACE_DIR", t.TempDir())
	t.Setenv("USER_AGENTS_DIR", t.TempDir())
	t.Setenv("SANDBOX_RPC_TOKEN", "test-rpc-token")
	t.Setenv("SANDBOX_REPORT_TOKEN", "test-report-token")
	script := "printf '%s:%s' \"${SANDBOX_RPC_TOKEN-unset}\" \"${SANDBOX_REPORT_TOKEN-unset}\"\n"
	if err := os.WriteFile(filepath.Join(os.Getenv("USER_AGENTS_DIR"), "setup.sh"), []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := env.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SandboxRPCToken != "test-rpc-token" || cfg.SandboxReportToken != "test-report-token" {
		t.Fatal("credentials were not retained in Config")
	}
	summary, err := Prepare(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if summary.Setup == nil || summary.Setup.ExitCode != 0 || summary.Setup.Stdout != "unset:unset" {
		t.Fatal("setup.sh inherited sandbox credentials")
	}
}
