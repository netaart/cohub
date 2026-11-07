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

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/protocol"
)

// A local sandbox has no Pod mounts: the agent mirrors the platform/user skill
// directories and each enabled Mod into CacheDir, and the fence exposes them
// read-only at their cloud sandbox paths. Revisions are the agent's own
// fingerprints; this side only stores and compares them.

var (
	mountSlugPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$`)
	mountsMu         sync.Mutex
)

const (
	mountStateFile      = "mounts.json"
	mountStagingDir     = "mount-staging"
	mountRevisionMaxLen = 256
	// Mounts can hold the Space owner's private user skills: readable by this OS user only.
	mountDirMode  = 0o700
	mountFileMode = 0o600
	mountExecMode = 0o700
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
	Files    []mountFile `json:"files"`
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
	if err := os.WriteFile(target+".tmp", raw, mountFileMode); err != nil {
		return err
	}
	return os.Rename(target+".tmp", target)
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
	// The platform/user roots stay as empty fence roots when not desired.
	for _, mountPath := range []string{virtualPlatformAgentsRoot, virtualUserAgentsRoot} {
		if _, ok := desired[mountPath]; !ok {
			dir, _ := d.mountHostDir(mountPath)
			if err := resetDir(dir); err != nil {
				return d.failed(request, "", "IO_ERROR", err.Error())
			}
		}
	}
	if err := os.MkdirAll(d.cfg.ModsDir, mountDirMode); err != nil {
		return d.failed(request, "", "IO_ERROR", err.Error())
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

	statuses := make([]mountStatus, 0, len(params.Mounts))
	for _, mount := range params.Mounts {
		statuses = append(statuses, mountStatus{Path: mount.Path, HostPath: desired[mount.Path], Revision: state[mount.Path]})
	}
	return map[string]interface{}{"mounts": statuses}
}

// handleMountsWrite replaces a whole mount: files are staged, then swapped in with one rename.
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
	if params.Revision == "" || len(params.Revision) > mountRevisionMaxLen {
		return d.failed(request, "", "BAD_REQUEST", "invalid revision")
	}

	stagingRoot := filepath.Join(d.cfg.CacheDir, mountStagingDir)
	if err := os.MkdirAll(stagingRoot, mountDirMode); err != nil {
		return d.failed(request, "", "IO_ERROR", err.Error())
	}
	staging, err := os.MkdirTemp(stagingRoot, "mount-")
	if err != nil {
		return d.failed(request, "", "IO_ERROR", err.Error())
	}
	defer os.RemoveAll(staging)
	for _, file := range params.Files {
		if err := writeMountFile(staging, file); err != nil {
			return d.failed(request, "", "BAD_REQUEST", err.Error())
		}
	}

	mountsMu.Lock()
	defer mountsMu.Unlock()
	previous := staging + ".previous"
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
	if err := os.MkdirAll(filepath.Dir(target), mountDirMode); err != nil {
		return err
	}
	mode := os.FileMode(mountFileMode)
	if file.Executable {
		mode = mountExecMode
	}
	return os.WriteFile(target, content, mode)
}

// ClearMounts empties every mount; sandboxd calls it at start and on exit so mounts live
// only while it runs, and the agent re-syncs them on its next Turn.
func ClearMounts(cfg env.Config) error {
	if cfg.CacheDir == "" {
		return nil
	}
	mountsMu.Lock()
	defer mountsMu.Unlock()
	return errors.Join(
		resetDir(cfg.PlatformAgentsDir),
		resetDir(cfg.UserAgentsDir),
		resetDir(cfg.ModsDir),
		os.RemoveAll(filepath.Join(cfg.CacheDir, mountStagingDir)),
		os.RemoveAll(filepath.Join(cfg.CacheDir, mountStateFile)),
	)
}

func resetDir(dir string) error {
	if entries, err := os.ReadDir(dir); err == nil && len(entries) == 0 {
		return nil
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	return os.MkdirAll(dir, mountDirMode)
}
