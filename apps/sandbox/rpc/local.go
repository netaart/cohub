package rpc

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"

	"github.com/google/uuid"

	"github.com/cohub/apps/sandbox/protocol"
)

const LocalIdentity = "local"

// LocalMethods are what the loopback API may call. Processes stay on the
// Cohub pipeline, where Turns and Tasks record them; rtc.* needs the API's
// viewer authorization and TURN credentials.
var LocalMethods = []string{
	"fs.read", "fs.write", "fs.edit", "fs.mkdir", "fs.delete", "fs.move", "fs.stat",
	"fs.ls", "fs.tree", "fs.find", "fs.grep", "fs.search",
	"display.list", "display.capture", "display.tree", "display.input", "display.start", "display.stop",
}

type FileVersion = fsWriteVersion

func (d *Dispatcher) Invoke(method string, params []byte) (interface{}, *protocol.RPCErrorPayload) {
	if !slices.Contains(LocalMethods, method) {
		return nil, &protocol.RPCErrorPayload{Code: "UNSUPPORTED_METHOD", Message: fmt.Sprintf("unsupported method: %s", method)}
	}
	if len(params) == 0 {
		params = []byte("{}")
	}
	_, response := d.Handle(protocol.RPCRequest{Method: method, Params: params}, LocalIdentity)
	return outcome(response)
}

func outcome(response interface{}) (interface{}, *protocol.RPCErrorPayload) {
	switch value := response.(type) {
	case protocol.RPCCompleted:
		return value.Result, nil
	case protocol.RPCFailed:
		return nil, &value.Error
	default:
		return value, nil
	}
}

func failure(code, message string) *protocol.RPCErrorPayload {
	return &protocol.RPCErrorPayload{Code: code, Message: message}
}

func (d *Dispatcher) OpenFile(rawPath string) (*os.File, os.FileInfo, *protocol.RPCErrorPayload) {
	if d.activity != nil {
		d.activity()
	}
	resolved, err := resolveSandboxPath(d.cfg, rawPath, "")
	if err != nil {
		return nil, nil, pathFailure(err)
	}
	file, err := os.Open(resolved.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, failure("NOT_FOUND", err.Error())
		}
		return nil, nil, failure("IO_ERROR", err.Error())
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, nil, failure("IO_ERROR", err.Error())
	}
	if info.IsDir() {
		_ = file.Close()
		return nil, nil, failure("NOT_FILE", fmt.Sprintf("not a file: %s", resolved.path))
	}
	return file, info, nil
}

func (d *Dispatcher) PutFile(rawPath string, body io.Reader, exclusive bool, expected *FileVersion) (interface{}, *protocol.RPCErrorPayload) {
	if d.activity != nil {
		d.activity()
	}
	resolved, err := resolveSandboxPath(d.cfg, rawPath, "")
	if err != nil {
		return nil, pathFailure(err)
	}
	request := protocol.RPCRequest{Method: "fs.write"}
	if isReadOnlyPath(d.cfg, resolved.path) {
		return nil, failure("READ_ONLY_FILESYSTEM", fmt.Sprintf("path is read-only: %s", resolved.path))
	}
	if info, err := os.Stat(resolved.path); err == nil && info.IsDir() {
		return nil, failure("NOT_DIRECTORY", fmt.Sprintf("cannot write to a directory: %s", resolved.path))
	}
	createdDirs, err := ensureParentDirs(d.cfg.WorkspaceDir, resolved.path)
	if err != nil {
		return outcome(d.failedFSMutation(request, err))
	}
	staging := filepath.Join(filepath.Dir(resolved.path), ".cohub-upload."+uuid.NewString())
	defer os.Remove(staging)
	if err := copyToFile(staging, body); err != nil {
		return outcome(d.failedFSMutation(request, err))
	}
	mode, err := installedMode(resolved.path)
	if err == nil {
		err = os.Chmod(staging, mode)
	}
	if err != nil {
		return outcome(d.failedFSMutation(request, err))
	}
	written := d.writeFile(fileWrite{target: resolved.path, source: staging, exclusive: exclusive, expected: expected})
	written.createdDirs = append(createdDirs, written.createdDirs...)
	return outcome(d.writeResult(request, resolved.path, written))
}

// installedMode keeps a replaced file's mode, since the rename replaces its inode;
// a new file is at most as open as its directory.
func installedMode(target string) (os.FileMode, error) {
	if info, err := os.Stat(target); err == nil {
		return info.Mode().Perm(), nil
	}
	info, err := os.Stat(filepath.Dir(target))
	if err != nil {
		return 0, err
	}
	return info.Mode().Perm() & 0o644, nil
}

// copyToFile stages privately: the content may be replacing a private file.
func copyToFile(path string, body io.Reader) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(file, body); err != nil {
		_ = file.Close()
		return err
	}
	// Durable before the rename that replaces the target.
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func pathFailure(err error) *protocol.RPCErrorPayload {
	if errors.Is(err, errPathOutsideRoot) {
		return failure("ACCESS_DENIED", err.Error())
	}
	return failure("INVALID_PATH", err.Error())
}
