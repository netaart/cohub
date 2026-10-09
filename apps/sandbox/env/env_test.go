package env

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"testing"
)

func setControlPublicKey(t *testing.T) {
	t.Helper()
	key, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SANDBOX_CONTROL_PUBLIC_KEY", string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})))
}

func TestCloudControlKeyRequired(t *testing.T) {
	t.Setenv("COHUB_SPACE_ID", "space-a")
	for _, value := range []string{"", "invalid"} {
		t.Setenv("SANDBOX_CONTROL_PUBLIC_KEY", value)
		if _, err := Load(); err == nil {
			t.Fatal("cloud sandbox accepted invalid control key")
		}
	}
}

func TestCloudSearchDefaultsToEnabledLatestRelease(t *testing.T) {
	setControlPublicKey(t)
	t.Setenv("COHUB_SPACE_ID", "00000000-0000-0000-0000-000000000001")
	t.Setenv("COHUB_SEARCH_ENABLED", "")
	t.Setenv("COHUB_SEARCH_VERSION", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.SearchEnabled {
		t.Fatal("cloud workspace search should be enabled by default")
	}
	if cfg.SearchVersion != DefaultSearchVersion {
		t.Fatalf("SearchVersion = %q", cfg.SearchVersion)
	}
}

func TestSearchDownloadDefaults(t *testing.T) {
	t.Setenv("COHUB_SEARCH_VERSION", "")
	t.Setenv("COHUB_SEARCH_CDN_BASE_URL", "")
	t.Setenv("COHUB_SEARCH_DOWNLOAD_DIR", "")
	if got := resolveSearchVersion(); got != DefaultSearchVersion {
		t.Fatalf("resolveSearchVersion() = %q", got)
	}
	if got := resolveSearchCDNBaseURL(); got != DefaultSearchCDNBaseURL {
		t.Fatalf("resolveSearchCDNBaseURL() = %q", got)
	}
	if got := resolveSearchDownloadDir(); got != DefaultSearchDownloadDir {
		t.Fatalf("resolveSearchDownloadDir() = %q", got)
	}
}

func TestSearchFeatureCanBeDisabled(t *testing.T) {
	t.Setenv("COHUB_SEARCH_ENABLED", "false")
	if got := parseBoolEnv("COHUB_SEARCH_ENABLED", true); got {
		t.Fatal("search feature should be disabled")
	}
}

func TestResolveSandboxVersion(t *testing.T) {
	t.Run("prefers Cohub version", func(t *testing.T) {
		t.Setenv("COHUB_SANDBOX_VERSION", " cohub-sandbox:current ")
		t.Setenv("IMAGE_VERSION", "cohub-sandbox:legacy")
		if got := ResolveSandboxVersion("fallback"); got != "cohub-sandbox:current" {
			t.Fatalf("ResolveSandboxVersion() = %q, want current version", got)
		}
	})

	t.Run("accepts legacy version", func(t *testing.T) {
		t.Setenv("COHUB_SANDBOX_VERSION", "")
		t.Setenv("IMAGE_VERSION", " cohub-sandbox:legacy ")
		if got := ResolveSandboxVersion("fallback"); got != "cohub-sandbox:legacy" {
			t.Fatalf("ResolveSandboxVersion() = %q, want legacy version", got)
		}
	})

	t.Run("uses fallback", func(t *testing.T) {
		t.Setenv("COHUB_SANDBOX_VERSION", "")
		t.Setenv("IMAGE_VERSION", "")
		if got := ResolveSandboxVersion("fallback"); got != "fallback" {
			t.Fatalf("ResolveSandboxVersion() = %q, want fallback", got)
		}
	})
}
