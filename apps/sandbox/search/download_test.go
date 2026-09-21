package search

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/cohub/apps/sandbox/env"
)

func TestDownloaderHonorsConfiguredSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test requires Unix executable permissions and symlinks")
	}
	root := t.TempDir()
	binary := filepath.Join(root, "cohub-search-v1")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, searchBinaryName)
	if err := os.Symlink(binary, link); err != nil {
		t.Fatal(err)
	}

	path, err := newDownloader().ensure(context.Background(), env.Config{
		SearchBinaryPath: link,
		SearchVersion:    "invalid",
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("configured binary should bypass release resolution: %v", err)
	}
	if path != link {
		t.Fatalf("selected binary = %q, want %q", path, link)
	}
	if isExecutableFile(link) {
		t.Fatal("downloaded binary validation must still reject symlinks")
	}
}

func TestDownloaderResolvesLatestAndVerifiesBinary(t *testing.T) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skip("search release binary is linux/amd64")
	}
	binary := []byte("#!/bin/sh\nexit 0\n")
	digest := sha256.Sum256(binary)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latest.json":
			_, _ = io.WriteString(w, `{"version":"v9.8.7"}`)
		case "/v9.8.7/cohub-search-linux-amd64.sha256":
			_, _ = fmt.Fprintf(w, "%x  cohub-search-linux-amd64\n", digest)
		case "/v9.8.7/cohub-search-linux-amd64":
			_, _ = w.Write(binary)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	root := t.TempDir()
	d := newDownloader()
	path, err := d.ensure(context.Background(), env.Config{
		SearchVersion:     "latest",
		SearchCDNBaseURL:  server.URL,
		SearchDownloadDir: root,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("ensure() error = %v", err)
	}
	if path != filepath.Join(root, "v9.8.7", searchBinaryName) {
		t.Fatalf("installed path = %q", path)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !info.Mode().IsRegular() || info.Mode()&0o111 == 0 {
		t.Fatalf("installed binary mode = %v", info.Mode())
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != string(binary) {
		t.Fatal("installed binary content mismatch")
	}
}

func TestDownloaderRejectsChecksumMismatch(t *testing.T) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skip("search release binary is linux/amd64")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.2.3/cohub-search-linux-amd64.sha256":
			_, _ = io.WriteString(w, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  cohub-search-linux-amd64\n")
		case "/v1.2.3/cohub-search-linux-amd64":
			_, _ = io.WriteString(w, "not the expected binary")
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	_, err := newDownloader().ensure(context.Background(), env.Config{
		SearchVersion:     "v1.2.3",
		SearchCDNBaseURL:  server.URL,
		SearchDownloadDir: t.TempDir(),
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err == nil {
		t.Fatal("ensure() accepted a checksum mismatch")
	}
}

func TestDownloaderRejectsInvalidVersion(t *testing.T) {
	_, err := newDownloader().resolveVersion(context.Background(), "https://example.invalid", "../latest")
	if err == nil {
		t.Fatal("resolveVersion() accepted an unsafe version")
	}
}
