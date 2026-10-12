package process

import (
	"slices"
	"testing"
)

func TestSandboxCredentialsAreNotInherited(t *testing.T) {
	got := sanitizeInheritedEnv([]string{
		"SANDBOX_RPC_TOKEN=rpc-secret", "SANDBOX_REPORT_TOKEN=report-secret",
		"COHUB_RELAY_TOKEN=relay-secret", "PATH=/usr/bin", "COHUB_SPACE_ID=space-a",
	})
	if !slices.Equal(got, []string{"PATH=/usr/bin", "COHUB_SPACE_ID=space-a"}) {
		t.Fatal("sandbox credentials were inherited")
	}
}
