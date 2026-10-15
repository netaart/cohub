package rpc

import (
	"encoding/base64"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/cohub/apps/sandbox/env"
)

// errPathConflict reports that the target file no longer matches the caller's
// expected version (size/mtimeMs). The write is rejected instead of silently
// overwriting a concurrent mutation (optimistic concurrency).
var errPathConflict = errors.New("file changed since it was opened")

// refCountedMutex serializes filesystem mutations for one resolved path.
type refCountedMutex struct {
	mu   sync.Mutex
	refs int
	gone bool
}

var pathLockTable sync.Map // canonical path -> *refCountedMutex

// resolvePathLockKey canonicalizes the lock key through filesystem aliases so
// symlink aliases pointing at the same target share one lock (matching the
// realpath semantics of the upstream mutation queue). When the full path does
// not exist yet (e.g. a file about to be created), the longest existing
// ancestor is resolved and the missing leaf components are re-appended, so
// aliases under a symlinked parent directory still map to the same key.
func resolvePathLockKey(path string) string {
	resolved, err := canonicalExistingPath(path)
	if err == nil {
		return resolved
	}
	probe := path
	var trailing []string
	for {
		resolved, err := canonicalExistingPath(probe)
		if err == nil {
			full := resolved
			for i := len(trailing) - 1; i >= 0; i-- {
				full = filepath.Join(full, trailing[i])
			}
			return full
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			// Reached the filesystem root without an existing ancestor.
			return path
		}
		trailing = append(trailing, filepath.Base(probe))
		probe = parent
	}
}

// withPathLock runs fn while holding the per-path lock for key. Mutations to
// the same path are serialized; distinct paths proceed in parallel. Entries are
// garbage collected when the last waiter leaves so long-running sandboxes do
// not accumulate locks. The gone flag makes LoadOrStore racing with a delete
// retry instead of sharing a lock that is about to be removed.
func withPathLock(key string, fn func() error) error {
	key = resolvePathLockKey(key)
	for {
		value, _ := pathLockTable.LoadOrStore(key, &refCountedMutex{})
		entry := value.(*refCountedMutex)
		entry.mu.Lock()
		if entry.gone {
			entry.mu.Unlock()
			continue
		}
		entry.refs++
		err := fn()
		entry.refs--
		if entry.refs == 0 {
			entry.gone = true
			pathLockTable.Delete(key)
		}
		entry.mu.Unlock()
		return err
	}
}

func ensureParentDirs(root, path string) ([]string, error) {
	return ensureDirs(root, filepath.Dir(path))
}

func ensureDirs(root, target string) ([]string, error) {
	rel, err := filepath.Rel(root, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return []string{}, os.MkdirAll(target, 0o755)
	}
	if rel == "." {
		return []string{}, nil
	}

	parts := strings.Split(rel, string(filepath.Separator))
	current := filepath.Clean(root)
	created := make([]string, 0, len(parts))
	for i, part := range parts {
		current = filepath.Join(current, part)
		err := os.Mkdir(current, 0o755)
		if err == nil {
			created = append(created, filepath.ToSlash(filepath.Join(parts[:i+1]...)))
			continue
		}
		if !os.IsExist(err) {
			return created, err
		}
		info, statErr := os.Stat(current)
		if statErr != nil {
			return created, statErr
		}
		if !info.IsDir() {
			return created, &os.PathError{Op: "mkdir", Path: current, Err: syscall.ENOTDIR}
		}
	}
	return created, nil
}

func writeFileWithDisposition(path string, content []byte) (bool, error) {
	for {
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			return true, writeAndClose(file, content)
		}
		if !os.IsExist(err) {
			return false, err
		}

		file, err = os.OpenFile(path, os.O_WRONLY|os.O_TRUNC, 0o644)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return false, err
		}
		return false, writeAndClose(file, content)
	}
}

func writeAndClose(file *os.File, content []byte) error {
	if _, err := file.Write(content); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

// statMtimeMs returns the file's modification time in epoch milliseconds, or
// 0 when the file cannot be statted. Callers holding the per-path lock use it
// to capture the response version so it always belongs to this mutation.
func statMtimeMs(path string) int64 {
	if info, err := os.Stat(path); err == nil {
		return info.ModTime().UnixMilli()
	}
	return 0
}

// osWriteFileExclusive creates path atomically, failing with os.IsExist when it
// already exists (O_EXCL). Used for exclusive-create semantics.
func osWriteFileExclusive(path string, content []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	return writeAndClose(f, content)
}

// installFileExclusive atomically claims a missing destination with a hard
// link. Source and target are validated to share a directory, so they are on
// the same filesystem. Removing the staging name is cleanup only; once the
// link succeeds the uploaded data is already installed safely.
func installFileExclusive(source, target string) error {
	if err := os.Link(source, target); err != nil {
		return err
	}
	_ = os.Remove(source)
	return nil
}

func osReadFile(path string) (string, error) {
	bytes, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(bytes), nil
}

func osReadFileBytes(path string) ([]byte, error) {
	return os.ReadFile(path)
}

func fileToBase64(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}

func decodeBase64(value string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(value)
}

// detectMimeType uses file extension first, then content sniffing as fallback.
// Dotfiles (e.g. .npmrc, .gitignore) are treated as text/plain so callers do not
// misclassify empty or config files as application/octet-stream.
func detectMimeType(path string, data []byte) string {
	base := strings.ToLower(filepath.Base(path))
	if base == "." || base == ".." {
		// fall through
	} else if strings.HasPrefix(base, ".") {
		return "text/plain; charset=utf-8"
	}

	ext := strings.ToLower(filepath.Ext(path))
	imageTypes := map[string]string{
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".png":  "image/png",
		".gif":  "image/gif",
		".webp": "image/webp",
		".svg":  "image/svg+xml",
		".bmp":  "image/bmp",
		".ico":  "image/x-icon",
	}
	if mt, ok := imageTypes[ext]; ok {
		return mt
	}
	// Fallback: sniff content bytes.
	return http.DetectContentType(data)
}

func osReadDir(path string) ([]os.DirEntry, error) {
	return os.ReadDir(path)
}

func splitLines(content string) []string {
	return strings.Split(content, "\n")
}

func joinLines(lines []string) string {
	return strings.Join(lines, "\n")
}

func nowMS() int64 {
	return time.Now().UnixMilli()
}

type resolvedSandboxPath struct {
	path string
}

const virtualWorkspaceRoot = "/workspace"

func mapVirtualWorkspacePath(cfg env.Config, cleaned string) string {
	if !cfg.Fence {
		return cleaned
	}
	workspaceRoot := filepath.Clean(cfg.WorkspaceDir)
	virtualRoot := filepath.Clean(virtualWorkspaceRoot)
	if workspaceRoot == virtualRoot {
		return cleaned
	}
	if cleaned == virtualRoot {
		return workspaceRoot
	}
	if strings.HasPrefix(cleaned, virtualRoot+string(filepath.Separator)) {
		relativePath := strings.TrimPrefix(cleaned, virtualRoot+string(filepath.Separator))
		return filepath.Join(workspaceRoot, relativePath)
	}
	return cleaned
}

func resolveSandboxPath(cfg env.Config, rawPath string, cwd string) (resolvedSandboxPath, error) {
	base := strings.TrimSpace(cwd)
	if base == "" {
		base = cfg.WorkspaceDir
	}

	candidate := strings.TrimSpace(rawPath)
	if err := validateHostPathSyntax(candidate); err != nil {
		return resolvedSandboxPath{}, err
	}
	if err := validateHostPathSyntax(strings.TrimSpace(cwd)); err != nil {
		return resolvedSandboxPath{}, err
	}
	if candidate == "" || candidate == "." {
		candidate = base
	}

	var cleaned string
	if isAbsSandboxPath(candidate) {
		cleaned = filepath.Clean(candidate)
	} else {
		cleaned = filepath.Clean(filepath.Join(base, candidate))
	}
	cleaned = mapVirtualWorkspacePath(cfg, cleaned)

	if cfg.Fence {
		if err := ensureWithinRoot(cfg.WorkspaceDir, cleaned); err != nil {
			return resolvedSandboxPath{}, err
		}
	}

	return resolvedSandboxPath{path: cleaned}, nil
}

// errPathOutsideRoot is returned when a fenced sandbox receives a path that
// would escape the workspace root, either lexically or via a symlink.
var errPathOutsideRoot = errors.New("path escapes sandbox root")

// ensureWithinRoot verifies that cleaned resolves inside root. It guards
// against both lexical traversal (..) and symlink escape by resolving the
// longest existing ancestor of the path before comparing.
// The root itself is assumed to be already symlink-resolved (see env.LoadLocal).
func ensureWithinRoot(root, cleaned string) error {
	root = filepath.Clean(root)
	if cleaned == root {
		return nil
	}

	// Resolve symlinks on the longest existing ancestor so a symlinked
	// directory cannot be used to step outside the root. Non-existent leaf
	// components (e.g. a file about to be written) are re-appended afterwards.
	probe := cleaned
	var trailing []string
	for {
		resolved, err := canonicalExistingPath(probe)
		if err == nil {
			full := resolved
			for i := len(trailing) - 1; i >= 0; i-- {
				full = filepath.Join(full, trailing[i])
			}
			if pathWithin(root, full) {
				return nil
			}
			return errPathOutsideRoot
		}
		if !os.IsNotExist(err) && !errors.Is(err, syscall.ENOTDIR) {
			return err
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			// Reached the filesystem root without finding an existing ancestor.
			break
		}
		trailing = append(trailing, filepath.Base(probe))
		probe = parent
	}

	// No existing ancestor resolved; fall back to a lexical prefix check.
	if pathWithin(root, cleaned) {
		return nil
	}
	return errPathOutsideRoot
}

func isReadOnlyPath(cfg env.Config, path string) bool {
	roots := []string{
		filepath.Clean(cfg.PlatformAgentsDir),
		filepath.Clean(cfg.UserAgentsDir),
	}
	candidate := filepath.Clean(path)
	for _, root := range roots {
		if pathWithin(root, candidate) {
			return true
		}
	}
	return false
}
