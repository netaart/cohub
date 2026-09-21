package search

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/cohub/apps/sandbox/env"
)

const (
	searchBinaryName       = "cohub-search"
	searchReleaseAssetName = "cohub-search-linux-amd64"
	maxSearchBinaryBytes   = 64 * 1024 * 1024
	maxChecksumBytes       = 4 * 1024
	downloadTimeout        = 2 * time.Minute
)

var searchVersionPattern = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+$`)

type latestRelease struct {
	Version string `json:"version"`
}

type downloader struct {
	client *http.Client
}

func newDownloader() *downloader {
	return &downloader{client: &http.Client{Timeout: downloadTimeout}}
}

func (d *downloader) ensure(ctx context.Context, cfg env.Config, logger *slog.Logger) (string, error) {
	if binary := resolveBinary(cfg.SearchBinaryPath); binary != "" {
		return binary, nil
	}
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		return "", fmt.Errorf("search binary download is unsupported on %s/%s", runtime.GOOS, runtime.GOARCH)
	}

	version, err := d.resolveVersion(ctx, cfg.SearchCDNBaseURL, cfg.SearchVersion)
	if err != nil {
		return "", err
	}
	installDir := filepath.Join(cfg.SearchDownloadDir, version)
	installed := filepath.Join(installDir, searchBinaryName)
	if isExecutableFile(installed) {
		return installed, nil
	}
	if err := os.MkdirAll(installDir, 0o700); err != nil {
		return "", fmt.Errorf("create search binary directory: %w", err)
	}

	baseURL := strings.TrimRight(cfg.SearchCDNBaseURL, "/") + "/" + version
	checksumText, err := d.fetchLimited(ctx, baseURL+"/"+searchReleaseAssetName+".sha256", maxChecksumBytes)
	if err != nil {
		return "", fmt.Errorf("download search checksum: %w", err)
	}
	expected, err := parseChecksum(string(checksumText))
	if err != nil {
		return "", err
	}
	binary, err := d.fetchLimited(ctx, baseURL+"/"+searchReleaseAssetName, maxSearchBinaryBytes)
	if err != nil {
		return "", fmt.Errorf("download search binary: %w", err)
	}
	actual := sha256.Sum256(binary)
	if hex.EncodeToString(actual[:]) != expected {
		return "", fmt.Errorf("search binary checksum mismatch")
	}

	temporary, err := os.CreateTemp(installDir, ".cohub-search-*")
	if err != nil {
		return "", fmt.Errorf("create temporary search binary: %w", err)
	}
	temporaryPath := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	if _, err := temporary.Write(binary); err != nil {
		cleanup()
		return "", fmt.Errorf("write temporary search binary: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		cleanup()
		return "", fmt.Errorf("sync temporary search binary: %w", err)
	}
	if err := temporary.Chmod(0o700); err != nil {
		cleanup()
		return "", fmt.Errorf("chmod temporary search binary: %w", err)
	}
	if err := temporary.Close(); err != nil {
		cleanup()
		return "", fmt.Errorf("close temporary search binary: %w", err)
	}
	if err := os.Rename(temporaryPath, installed); err != nil {
		cleanup()
		return "", fmt.Errorf("install search binary: %w", err)
	}
	logger.Info("search binary downloaded",
		slog.String("version", version),
		slog.String("path", installed),
	)
	return installed, nil
}

func (d *downloader) resolveVersion(ctx context.Context, baseURL, requested string) (string, error) {
	requested = strings.TrimSpace(requested)
	if requested == "" || requested == "latest" {
		body, err := d.fetchLimited(ctx, strings.TrimRight(baseURL, "/")+"/latest.json", maxChecksumBytes)
		if err != nil {
			return "", fmt.Errorf("resolve latest search release: %w", err)
		}
		var latest latestRelease
		if err := json.Unmarshal(body, &latest); err != nil {
			return "", fmt.Errorf("decode latest search release: %w", err)
		}
		requested = strings.TrimSpace(latest.Version)
	}
	if !searchVersionPattern.MatchString(requested) {
		return "", fmt.Errorf("invalid search release version %q", requested)
	}
	return requested, nil
}

func (d *downloader) fetchLimited(ctx context.Context, url string, limit int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	response, err := d.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("HTTP %s", response.Status)
	}
	if response.ContentLength > limit {
		return nil, fmt.Errorf("response exceeds %d bytes", limit)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("response exceeds %d bytes", limit)
	}
	return body, nil
}

func parseChecksum(value string) (string, error) {
	fields := strings.Fields(value)
	if len(fields) == 0 || len(fields[0]) != sha256.Size*2 {
		return "", fmt.Errorf("invalid search checksum manifest")
	}
	checksum := strings.ToLower(fields[0])
	if _, err := hex.DecodeString(checksum); err != nil {
		return "", fmt.Errorf("invalid search checksum manifest")
	}
	return checksum, nil
}

func isExecutableFile(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0
}
