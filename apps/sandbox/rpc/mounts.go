package rpc

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/cohub/apps/sandbox/protocol"
)

// A local sandbox has no Pod mounts: the agent mirrors the platform/user skill
// directories and each enabled Mod into CacheDir, and the fence exposes them
// read-only at their cloud sandbox paths. Revisions are the agent's own
// fingerprints; this side only stores and compares them.

var (
	mountSlugPattern     = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$`)
	mountUploadIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)
	mountsMu             sync.Mutex
)

const (
	mountStateFile      = "mounts.json"
	mountStagingDir     = "mount-staging"
	mountStagingMaxAge  = 10 * time.Minute
	mountRevisionMaxLen = 256
)

type mountSpec struct {
	Path     string `json:"path"`
	Revision string `json:"revision"`
}

type mountSyncParams struct {
	Mounts []mountSpec `json:"mounts"`
}

type mountFile struct {
	Path          string `json:"path"`
	ContentBase64 string `json:"contentBase64"`
	Executable    bool   `json:"executable,omitempty"`
}

type mountWriteParams struct {
	Path     string      `json:"path"`
	Revision string      `json:"revision"`
	UploadID string      `json:"uploadId"`
	Files    []mountFile `json:"files"`
	Final    bool        `json:"final"`
}

type mountStatus struct {
	Path     string `json:"path"`
	HostPath string `json:"hostPath"`
	Revision string `json:"revision,omitempty"`
}

// mountHostDir maps a mount's sandbox path to its directory under CacheDir.
func (d *Dispatcher) mountHostDir(mountPath string) (string, error) {
	switch mountPath {
	case virtualPlatformAgentsRoot:
		return d.cfg.PlatformAgentsDir, nil
	case virtualUserAgentsRoot:
		return d.cfg.UserAgentsDir, nil
	}
	slug, ok := strings.CutPrefix(mountPath, virtualModsRoot+"/")
	if !ok || !mountSlugPattern.MatchString(slug) {
		return "", fmt.Errorf("unsupported mount path: %s", mountPath)
	}
	return filepath.Join(d.cfg.ModsDir, slug), nil
}

func (d *Dispatcher) readMountState() map[string]string {
	state := map[string]string{}
	if raw, err := os.ReadFile(filepath.Join(d.cfg.CacheDir, mountStateFile)); err == nil {
		_ = json.Unmarshal(raw, &state)
	}
	return state
}

func (d *Dispatcher) writeMountState(state map[string]string) error {
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	target := filepath.Join(d.cfg.CacheDir, mountStateFile)
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, target)
}

func (d *Dispatcher) mountsSupported() bool {
	return d.cfg.IsLocal() && d.cfg.CacheDir != ""
}

// handleMountsSync drops mounts outside the desired set and reports the revision each desired mount holds.
func (d *Dispatcher) handleMountsSync(request protocol.RPCRequest) interface{} {
	if !d.mountsSupported() {
		return d.failed(request, "", "UNSUPPORTED_METHOD", "mounts are only synced to local sandboxes")
	}
	var params mountSyncParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return d.failed(request, "", "BAD_REQUEST", err.Error())
	}
	desired := map[string]string{}
	for _, mount := range params.Mounts {
		dir, err := d.mountHostDir(mount.Path)
		if err != nil {
			return d.failed(request, "", "BAD_REQUEST", err.Error())
		}
		desired[mount.Path] = dir
	}

	mountsMu.Lock()
	defer mountsMu.Unlock()
	state := d.readMountState()
	for mountPath := range state {
		if _, ok := desired[mountPath]; !ok {
			delete(state, mountPath)
		}
	}
	// Clear what is no longer desired; the platform/user roots stay as empty fence roots.
	for _, mountPath := range []string{virtualPlatformAgentsRoot, virtualUserAgentsRoot} {
		if _, ok := desired[mountPath]; !ok {
			dir, _ := d.mountHostDir(mountPath)
			if err := resetDir(dir); err != nil {
				return d.failed(request, "", "IO_ERROR", err.Error())
			}
		}
	}
	entries, err := os.ReadDir(d.cfg.ModsDir)
	if err != nil {
		return d.failed(request, "", "IO_ERROR", err.Error())
	}
	for _, entry := range entries {
		if _, ok := desired[virtualModsRoot+"/"+entry.Name()]; !ok {
			if err := os.RemoveAll(filepath.Join(d.cfg.ModsDir, entry.Name())); err != nil {
				return d.failed(request, "", "IO_ERROR", err.Error())
			}
		}
	}
	for mountPath, dir := range desired {
		if _, err := os.Stat(dir); err != nil {
			delete(state, mountPath)
		}
	}
	if err := d.writeMountState(state); err != nil {
		return d.failed(request, "", "IO_ERROR", err.Error())
	}
	d.pruneMountStaging()

	statuses := make([]mountStatus, 0, len(params.Mounts))
	for _, mount := range params.Mounts {
		statuses = append(statuses, mountStatus{Path: mount.Path, HostPath: desired[mount.Path], Revision: state[mount.Path]})
	}
	return map[string]interface{}{"mounts": statuses}
}

// handleMountsWrite stages one batch of a mount's files; the final batch replaces the mount in one rename.
func (d *Dispatcher) handleMountsWrite(request protocol.RPCRequest) interface{} {
	if !d.mountsSupported() {
		return d.failed(request, "", "UNSUPPORTED_METHOD", "mounts are only synced to local sandboxes")
	}
	var params mountWriteParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return d.failed(request, "", "BAD_REQUEST", err.Error())
	}
	target, err := d.mountHostDir(params.Path)
	if err != nil {
		return d.failed(request, "", "BAD_REQUEST", err.Error())
	}
	if !mountUploadIDPattern.MatchString(params.UploadID) {
		return d.failed(request, "", "BAD_REQUEST", "invalid uploadId")
	}
	if params.Revision == "" || len(params.Revision) > mountRevisionMaxLen {
		return d.failed(request, "", "BAD_REQUEST", "invalid revision")
	}

	staging := filepath.Join(d.cfg.CacheDir, mountStagingDir, params.UploadID)
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return d.failed(request, "", "IO_ERROR", err.Error())
	}
	for _, file := range params.Files {
		if err := writeMountFile(staging, file); err != nil {
			return d.failed(request, "", "BAD_REQUEST", err.Error())
		}
	}
	if !params.Final {
		return map[string]interface{}{"path": params.Path, "written": len(params.Files)}
	}

	mountsMu.Lock()
	defer mountsMu.Unlock()
	previous := staging + ".previous"
	if err := os.RemoveAll(previous); err != nil {
		return d.failed(request, "", "IO_ERROR", err.Error())
	}
	if err := os.Rename(target, previous); err != nil && !errors.Is(err, os.ErrNotExist) {
		return d.failed(request, "", "IO_ERROR", err.Error())
	}
	if err := os.Rename(staging, target); err != nil {
		_ = os.Rename(previous, target)
		return d.failed(request, "", "IO_ERROR", err.Error())
	}
	_ = os.RemoveAll(previous)
	state := d.readMountState()
	state[params.Path] = params.Revision
	if err := d.writeMountState(state); err != nil {
		return d.failed(request, "", "IO_ERROR", err.Error())
	}
	return mountStatus{Path: params.Path, HostPath: target, Revision: params.Revision}
}

func writeMountFile(root string, file mountFile) error {
	rel := file.Path
	if rel == "" || strings.ContainsAny(rel, "\\\x00:") || path.IsAbs(rel) || path.Clean(rel) != rel || rel == ".." || strings.HasPrefix(rel, "../") {
		return fmt.Errorf("invalid mount file path: %q", rel)
	}
	content, err := base64.StdEncoding.DecodeString(file.ContentBase64)
	if err != nil {
		return fmt.Errorf("invalid content for %s: %w", rel, err)
	}
	target := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	mode := os.FileMode(0o644)
	if file.Executable {
		mode = 0o755
	}
	return os.WriteFile(target, content, mode)
}

func resetDir(dir string) error {
	if entries, err := os.ReadDir(dir); err == nil && len(entries) == 0 {
		return nil
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	return os.MkdirAll(dir, 0o755)
}

// pruneMountStaging removes uploads an agent abandoned mid-way.
func (d *Dispatcher) pruneMountStaging() {
	root := filepath.Join(d.cfg.CacheDir, mountStagingDir)
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		info, err := entry.Info()
		if err == nil && time.Since(info.ModTime()) > mountStagingMaxAge {
			_ = os.RemoveAll(filepath.Join(root, entry.Name()))
		}
	}
}
