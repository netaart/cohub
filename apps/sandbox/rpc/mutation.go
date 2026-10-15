package rpc

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/cohub/apps/sandbox/protocol"
)

// fs.delete and fs.move replace the coreutils argv fallback (rm/rmdir/mv -T)
// on hosts without those tools. They are advertised only where that fallback is unavailable.

type fsDeleteParams struct {
	Path      string `json:"path"`
	CWD       string `json:"cwd"`
	Recursive bool   `json:"recursive"`
}

type fsMoveParams struct {
	FromPath string `json:"fromPath"`
	ToPath   string `json:"toPath"`
	CWD      string `json:"cwd"`
}

func nodeType(info os.FileInfo) string {
	if info.IsDir() {
		return "dir"
	}
	return "file"
}

func (d *Dispatcher) resolveMutablePath(request protocol.RPCRequest, rawPath, cwd string) (string, interface{}, bool) {
	resolved, errResponse, ok := d.resolvePathForRequest(request, rawPath, cwd)
	if !ok {
		return "", errResponse, false
	}
	mutationTarget := resolved.path
	info, err := os.Lstat(mutationTarget)
	if err != nil && !os.IsNotExist(err) {
		return "", d.failedFSMutation(request, err), false
	}
	// Resolve directory aliases without following a final symlink or junction.
	if err == nil && info.IsDir() {
		mutationTarget, err = canonicalExistingPath(mutationTarget)
		if err != nil {
			return "", d.failedFSMutation(request, err), false
		}
	}
	if samePath(mutationTarget, d.cfg.WorkspaceDir) {
		return "", d.failed(request, "", "INVALID_PATH", "cannot modify the workspace root"), false
	}
	if isReadOnlyPath(d.cfg, resolved.path) {
		return "", d.failed(request, "", "READ_ONLY_FILESYSTEM", fmt.Sprintf("path is read-only: %s", resolved.path)), false
	}
	return resolved.path, nil, true
}

func (d *Dispatcher) handleFSDelete(request protocol.RPCRequest) interface{} {
	var params fsDeleteParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return d.failed(request, "", "BAD_REQUEST", err.Error())
	}
	path, errResponse, ok := d.resolveMutablePath(request, params.Path, params.CWD)
	if !ok {
		return errResponse
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return d.failed(request, "", "NOT_FOUND", fmt.Sprintf("file not found: %s", path))
	}
	if err != nil {
		return d.failedFSMutation(request, err)
	}
	if info.IsDir() && params.Recursive {
		// A partial failure (locked or protected entry) reports its own cause, not "not empty".
		if err := os.RemoveAll(path); err != nil {
			return d.failedFSMutation(request, err)
		}
	} else if err := os.Remove(path); err != nil {
		if entries, readErr := os.ReadDir(path); info.IsDir() && readErr == nil && len(entries) > 0 {
			return d.failed(request, "", "DIRECTORY_NOT_EMPTY", fmt.Sprintf("directory is not empty: %s", path))
		}
		return d.failedFSMutation(request, err)
	}
	return map[string]interface{}{"path": path, "deleted": true, "nodeType": nodeType(info)}
}

func (d *Dispatcher) handleFSMove(request protocol.RPCRequest) interface{} {
	var params fsMoveParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return d.failed(request, "", "BAD_REQUEST", err.Error())
	}
	from, errResponse, ok := d.resolveMutablePath(request, params.FromPath, params.CWD)
	if !ok {
		return errResponse
	}
	to, errResponse, ok := d.resolveMutablePath(request, params.ToPath, params.CWD)
	if !ok {
		return errResponse
	}
	info, err := os.Lstat(from)
	if os.IsNotExist(err) {
		return d.failed(request, "", "NOT_FOUND", fmt.Sprintf("file not found: %s", from))
	}
	if err != nil {
		return d.failedFSMutation(request, err)
	}
	// Exact-target rename, matching `mv -T`: an existing directory is never moved into.
	if err := os.Rename(from, to); err != nil {
		return d.failedFSMutation(request, err)
	}
	return map[string]interface{}{"fromPath": from, "toPath": to, "nodeType": nodeType(info)}
}
