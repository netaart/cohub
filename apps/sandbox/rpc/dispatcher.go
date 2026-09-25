package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/google/uuid"
	ignore "github.com/sabhiram/go-gitignore"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/process"
	"github.com/cohub/apps/sandbox/protocol"
	"github.com/cohub/apps/sandbox/search"
)

type IdentityRouter interface {
	SendToIdentity(identity string, v interface{}) error
}

type Dispatcher struct {
	cfg            env.Config
	processManager *process.Manager
	logger         *slog.Logger
	router         IdentityRouter
	opSeq          int64
	mu             sync.Mutex
	gitignoreMu    sync.Mutex
	gitignoreCache *gitignoreCacheEntry
	searchManager  *search.Manager
}

type gitignoreMatcher struct {
	gi *ignore.GitIgnore
}

// ignore reports whether a workspace-root-relative path should be hidden. It
// always hides the .git directory and, when a .gitignore is present, applies
// its rules (checking the directory form so ignored dirs are pruned).
func (m *gitignoreMatcher) ignore(relPath string, isDir bool) bool {
	if relPath == ".git" || strings.HasPrefix(relPath, ".git/") {
		return true
	}
	if m.gi == nil {
		return false
	}
	if m.gi.MatchesPath(relPath) {
		return true
	}
	return isDir && m.gi.MatchesPath(relPath+"/")
}

type gitignoreCacheEntry struct {
	matcher   *gitignoreMatcher
	signature string
	expiresAt time.Time
}

const gitignoreCacheTTL = 30 * time.Second

// loadGitignore builds (and briefly caches) a matcher from the workspace root
// .gitignore. When respect is false it returns a matcher that only hides .git.
func (d *Dispatcher) loadGitignore(respect bool) *gitignoreMatcher {
	if !respect {
		return &gitignoreMatcher{}
	}
	path := filepath.Join(d.cfg.WorkspaceDir, ".gitignore")
	signature := "missing"
	if info, err := os.Stat(path); err == nil {
		signature = fmt.Sprintf("%d:%d", info.ModTime().UnixNano(), info.Size())
	}

	d.gitignoreMu.Lock()
	defer d.gitignoreMu.Unlock()
	now := time.Now()
	if d.gitignoreCache != nil && d.gitignoreCache.signature == signature && d.gitignoreCache.expiresAt.After(now) {
		return d.gitignoreCache.matcher
	}

	matcher := &gitignoreMatcher{}
	if gi, err := ignore.CompileIgnoreFile(path); err == nil {
		matcher.gi = gi
	}
	d.gitignoreCache = &gitignoreCacheEntry{matcher: matcher, signature: signature, expiresAt: now.Add(gitignoreCacheTTL)}
	return matcher
}

func NewDispatcher(cfg env.Config, processManager *process.Manager, logger *slog.Logger) *Dispatcher {
	return &Dispatcher{cfg: cfg, processManager: processManager, logger: logger}
}

func (d *Dispatcher) SetRouter(router IdentityRouter) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.router = router
}

func (d *Dispatcher) SetSearchManager(manager *search.Manager) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.searchManager = manager
}

func (d *Dispatcher) nextSeq() int64 {
	return atomic.AddInt64(&d.opSeq, 1)
}

func (d *Dispatcher) Handle(request protocol.RPCRequest, ownerIdentity string) (protocol.RPCAccepted, interface{}) {
	accepted := protocol.RPCAccepted{
		RequestScopedMessage: protocol.RequestScopedMessage{
			BaseMessage: protocol.BaseMessage{
				Version:   protocol.Version,
				Type:      "rpc.accepted",
				SpaceID:   request.SpaceID,
				SandboxID: request.SandboxID,
				Timestamp: nowMS(),
			},
			RequestID:  request.RequestID,
			SessionID:  request.SessionID,
			ToolCallID: request.ToolCallID,
		},
		OpID: uuid.NewString(),
	}

	switch request.Method {
	case "fs.read":
		return accepted, d.complete(request, accepted.OpID, d.handleFSRead(request))
	case "fs.write":
		return accepted, d.complete(request, accepted.OpID, d.handleFSWrite(request))
	case "fs.edit":
		return accepted, d.complete(request, accepted.OpID, d.handleFSEdit(request))
	case "fs.mkdir":
		return accepted, d.complete(request, accepted.OpID, d.handleFSMkdir(request))
	case "fs.stat":
		return accepted, d.complete(request, accepted.OpID, d.handleFSStat(request))
	case "fs.ls":
		return accepted, d.complete(request, accepted.OpID, d.handleFSLs(request))
	case "fs.tree":
		return accepted, d.complete(request, accepted.OpID, d.handleFSTree(request))
	case "fs.find":
		return accepted, d.complete(request, accepted.OpID, d.handleFSFind(request))
	case "fs.grep":
		return accepted, d.complete(request, accepted.OpID, d.handleFSGrep(request))
	case "fs.search":
		return accepted, d.complete(request, accepted.OpID, d.handleFSSearch(request))
	case "fs.pathSearch":
		return accepted, d.complete(request, accepted.OpID, d.handleFSPathSearch(request))
	case "process.start":
		return accepted, d.handleProcessStart(request, accepted.OpID, ownerIdentity)
	case "process.abort":
		return accepted, d.complete(request, accepted.OpID, d.handleProcessAbort(request))
	default:
		return accepted, d.failed(request, accepted.OpID, "UNSUPPORTED_METHOD", fmt.Sprintf("unsupported method: %s", request.Method))
	}
}

type fsReadParams struct {
	Path   string `json:"path"`
	CWD    string `json:"cwd"`
	Offset int    `json:"offset"`
	Limit  int    `json:"limit"`
	Binary bool   `json:"binary"`
}

type fsWriteParams struct {
	Path       string          `json:"path"`
	CWD        string          `json:"cwd"`
	Content    string          `json:"content"`
	SourcePath string          `json:"sourcePath"`
	Encoding   string          `json:"encoding"`
	Exclusive  bool            `json:"exclusive"`
	Expected   *fsWriteVersion `json:"expected"`
}

// fsWriteVersion is the caller's baseline for optimistic concurrency: reject
// the write when the file no longer matches this version (size + mtimeMs).
type fsWriteVersion struct {
	Size    int64 `json:"size"`
	MtimeMs int64 `json:"mtimeMs"`
}

type fsEditItem struct {
	OldText string `json:"oldText"`
	NewText string `json:"newText"`
}

type fsEditParams struct {
	Path  string       `json:"path"`
	CWD   string       `json:"cwd"`
	Edits []fsEditItem `json:"edits"`
}

type fsMkdirParams struct {
	Path string `json:"path"`
	CWD  string `json:"cwd"`
}

type fsLsParams struct {
	Path  string `json:"path"`
	CWD   string `json:"cwd"`
	Limit int    `json:"limit"`
}

type fsTreeParams struct {
	Path             string `json:"path"`
	CWD              string `json:"cwd"`
	Depth            int    `json:"depth"`
	Limit            int    `json:"limit"`
	RespectGitignore *bool  `json:"respectGitignore"`
}

type fsFindParams struct {
	Pattern    string   `json:"pattern"`
	Path       string   `json:"path"`
	CWD        string   `json:"cwd"`
	Limit      int      `json:"limit"`
	Mode       string   `json:"mode"`
	Hidden     bool     `json:"hidden"`
	RequireGit bool     `json:"requireGit"`
	IgnoreVcs  bool     `json:"ignoreVcs"`
	FullPath   bool     `json:"fullPath"`
	Ignore     []string `json:"ignore"`
}

type fsSearchParams struct {
	Pattern      string `json:"pattern"`
	Path         string `json:"path"`
	CWD          string `json:"cwd"`
	FixedStrings bool   `json:"fixedStrings"`
	IgnoreCase   bool   `json:"ignoreCase"`
	Glob         string `json:"glob"`
	Limit        int    `json:"limit"`
}

type fsPathSearchParams struct {
	Pattern  string `json:"pattern"`
	Path     string `json:"path"`
	CWD      string `json:"cwd"`
	Limit    int    `json:"limit"`
	FullPath bool   `json:"fullPath"`
}

type fsGrepParams struct {
	Pattern    string `json:"pattern"`
	Path       string `json:"path"`
	CWD        string `json:"cwd"`
	Glob       string `json:"glob"`
	IgnoreCase bool   `json:"ignoreCase"`
	Literal    bool   `json:"literal"`
	Context    int    `json:"context"`
	Limit      int    `json:"limit"`
	MaxCount   int    `json:"maxCount"`
	JSON       bool   `json:"json"`
	RequireGit bool   `json:"requireGit"`
	IgnoreVcs  bool   `json:"ignoreVcs"`
	Hidden     bool   `json:"hidden"`
}

const (
	processStartMaxArgvItems      = 256
	processStartMaxArgvItemBytes  = 8 * 1024
	processStartMaxArgvTotalBytes = 64 * 1024
	processOutputQueueSize        = 64
)

type processStartParams struct {
	Command     string            `json:"command"`
	Argv        []string          `json:"argv"`
	TimeoutSecs int               `json:"timeoutSecs"`
	CWD         string            `json:"cwd"`
	Env         map[string]string `json:"env"`
}

type processAbortParams struct {
	ProcessID string `json:"processId"`
}

func (d *Dispatcher) resolvePathForRequest(request protocol.RPCRequest, rawPath string, cwd string) (resolvedSandboxPath, interface{}, bool) {
	resolved, err := resolveSandboxPath(d.cfg, rawPath, cwd)
	if err != nil {
		code := "INVALID_PATH"
		if errors.Is(err, errPathOutsideRoot) {
			code = "ACCESS_DENIED"
		}
		return resolvedSandboxPath{}, d.failed(request, "", code, err.Error()), false
	}
	return resolved, nil, true
}

func (d *Dispatcher) handleFSRead(request protocol.RPCRequest) interface{} {
	var params fsReadParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return d.failed(request, "", "BAD_REQUEST", err.Error())
	}

	resolved, errResponse, ok := d.resolvePathForRequest(request, params.Path, params.CWD)
	if !ok {
		return errResponse
	}

	if params.Binary {
		rawBytes, err := osReadFileBytes(resolved.path)
		if err != nil {
			if os.IsNotExist(err) {
				return d.failed(request, "", "NOT_FOUND", err.Error())
			}
			return d.failed(request, "", "IO_ERROR", err.Error())
		}
		mimeType := detectMimeType(resolved.path, rawBytes)
		result := map[string]interface{}{
			"path":          resolved.path,
			"content":       "",
			"contentBase64": fileToBase64(rawBytes),
			"mimeType":      mimeType,
			"size":          int64(len(rawBytes)),
		}
		if info, statErr := os.Stat(resolved.path); statErr == nil {
			result["size"] = info.Size()
			result["mtimeMs"] = info.ModTime().UnixMilli()
			if ctimeMs, ok := fileCtimeMs(info); ok {
				result["ctimeMs"] = ctimeMs
			}
		}
		return result
	}

	content, err := osReadFile(resolved.path)
	if err != nil {
		if os.IsNotExist(err) {
			return d.failed(request, "", "NOT_FOUND", err.Error())
		}
		return d.failed(request, "", "IO_ERROR", err.Error())
	}

	lines := splitLines(content)
	start := 0
	if params.Offset > 1 {
		start = params.Offset - 1
	}
	if start < 0 {
		start = 0
	}
	if start > len(lines) {
		start = len(lines)
	}

	end := len(lines)
	if params.Limit > 0 && start+params.Limit < end {
		end = start + params.Limit
	}

	result := map[string]interface{}{
		"path":    resolved.path,
		"content": joinLines(lines[start:end]),
	}
	if info, statErr := os.Stat(resolved.path); statErr == nil {
		result["size"] = info.Size()
		result["mtimeMs"] = info.ModTime().UnixMilli()
		if ctimeMs, ok := fileCtimeMs(info); ok {
			result["ctimeMs"] = ctimeMs
		}
	}
	return result
}

func (d *Dispatcher) failedFSMutation(request protocol.RPCRequest, err error) interface{} {
	if errors.Is(err, syscall.ENOTDIR) || errors.Is(err, syscall.EISDIR) {
		return d.failed(request, "", "NOT_DIRECTORY", err.Error())
	}
	return d.failed(request, "", "IO_ERROR", err.Error())
}

func (d *Dispatcher) handleFSWrite(request protocol.RPCRequest) interface{} {
	var params fsWriteParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return d.failed(request, "", "BAD_REQUEST", err.Error())
	}

	resolved, errResponse, ok := d.resolvePathForRequest(request, params.Path, params.CWD)
	if !ok {
		return errResponse
	}
	if isReadOnlyPath(d.cfg, resolved.path) {
		return d.failed(request, "", "READ_ONLY_FILESYSTEM", fmt.Sprintf("path is read-only: %s", resolved.path))
	}
	if info, err := os.Stat(resolved.path); err == nil && info.IsDir() {
		return d.failed(request, "", "NOT_DIRECTORY", fmt.Sprintf("cannot write to a directory: %s", resolved.path))
	}

	var source *resolvedSandboxPath
	data := []byte(params.Content)
	if params.SourcePath != "" {
		if params.Content != "" || params.Encoding != "" || (params.Expected == nil && !params.Exclusive) {
			return d.failed(request, "", "BAD_REQUEST", "sourcePath requires an expected version or exclusive create and no inline content")
		}
		resolvedSource, sourceErrResponse, sourceOK := d.resolvePathForRequest(request, params.SourcePath, params.CWD)
		if !sourceOK {
			return sourceErrResponse
		}
		if isReadOnlyPath(d.cfg, resolvedSource.path) {
			return d.failed(request, "", "READ_ONLY_FILESYSTEM", fmt.Sprintf("source path is read-only: %s", resolvedSource.path))
		}
		if filepath.Base(resolvedSource.path) == filepath.Base(resolved.path) ||
			!strings.HasPrefix(filepath.Base(resolvedSource.path), ".cohub-upload.") ||
			resolvePathLockKey(filepath.Dir(resolvedSource.path)) != resolvePathLockKey(filepath.Dir(resolved.path)) {
			return d.failed(request, "", "INVALID_PATH", "sourcePath must be an upload staging file next to the target")
		}
		info, err := os.Lstat(resolvedSource.path)
		if err != nil {
			return d.failedFSMutation(request, err)
		}
		if !info.Mode().IsRegular() {
			return d.failed(request, "", "INVALID_PATH", "sourcePath must be a regular file")
		}
		source = &resolvedSource
	} else if params.Encoding == "base64" {
		decoded, decErr := decodeBase64(params.Content)
		if decErr != nil {
			return d.failed(request, "", "BAD_REQUEST", decErr.Error())
		}
		data = decoded
	}

	// The version check and the write must be atomic with respect to other
	// writes to the same path, otherwise a concurrent mutation can land between
	// the stat and the write (TOCTOU) and the check is meaningless. The
	// response version (mtimeMs) is also captured under the lock so it cannot
	// belong to a subsequent writer.
	var created bool
	var createdDirs []string
	var bytesWritten int
	var mtimeMs int64
	lockErr := withPathLock(resolved.path, func() error {
		if params.Expected != nil && !params.Exclusive {
			info, err := os.Stat(resolved.path)
			if err != nil {
				if os.IsNotExist(err) {
					return errPathConflict
				}
				return err
			}
			if info.Size() != params.Expected.Size || info.ModTime().UnixMilli() != params.Expected.MtimeMs {
				return errPathConflict
			}
		}
		if source != nil {
			targetInfo, targetErr := os.Lstat(resolved.path)
			if targetErr == nil {
				if targetInfo.Mode()&os.ModeSymlink != 0 || !targetInfo.Mode().IsRegular() {
					return errPathConflict
				}
			} else if !os.IsNotExist(targetErr) {
				return targetErr
			}
		}
		var err error
		createdDirs, err = ensureParentDirs(d.cfg.WorkspaceDir, resolved.path)
		if err != nil {
			return err
		}
		if source != nil {
			// Install the already-downloaded file while holding the same path lock
			// used by editor writes; never expose an unconditional late mv.
			sourceInfo, statErr := os.Lstat(source.path)
			if statErr != nil {
				return statErr
			}
			if !sourceInfo.Mode().IsRegular() {
				return errPathConflict
			}
			if params.Exclusive {
				if err := installFileExclusive(source.path, resolved.path); err != nil {
					return err
				}
				created = true
			} else {
				if err := os.Rename(source.path, resolved.path); err != nil {
					return err
				}
				created = false
			}
			bytesWritten = int(sourceInfo.Size())
		} else if params.Exclusive {
			// Atomic create: O_EXCL fails if the path already exists, so concurrent
			// exclusive creates cannot clobber each other.
			if err := osWriteFileExclusive(resolved.path, data); err != nil {
				return err
			}
			created = true
			bytesWritten = len(data)
		} else {
			created, err = writeFileWithDisposition(resolved.path, data)
			if err != nil {
				return err
			}
			bytesWritten = len(data)
		}
		mtimeMs = statMtimeMs(resolved.path)
		return nil
	})
	if lockErr != nil {
		if errors.Is(lockErr, errPathConflict) {
			return d.failed(request, "", "CONFLICT", "file changed since it was opened")
		}
		if errors.Is(lockErr, os.ErrExist) {
			return d.failed(request, "", "ALREADY_EXISTS", fmt.Sprintf("path already exists: %s", resolved.path))
		}
		return d.failedFSMutation(request, lockErr)
	}

	result := map[string]interface{}{
		"path":         resolved.path,
		"bytesWritten": bytesWritten,
		"created":      created,
		"createdDirs":  createdDirs,
	}
	if mtimeMs > 0 {
		result["mtimeMs"] = mtimeMs
	}
	return result
}

func (d *Dispatcher) handleFSEdit(request protocol.RPCRequest) interface{} {
	var params fsEditParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return d.failed(request, "", "BAD_REQUEST", err.Error())
	}
	if len(params.Edits) == 0 {
		return d.failed(request, "", "BAD_REQUEST", "edits must contain at least one replacement")
	}

	resolved, errResponse, ok := d.resolvePathForRequest(request, params.Path, params.CWD)
	if !ok {
		return errResponse
	}
	if isReadOnlyPath(d.cfg, resolved.path) {
		return d.failed(request, "", "READ_ONLY_FILESYSTEM", fmt.Sprintf("path is read-only: %s", resolved.path))
	}
	if info, err := os.Stat(resolved.path); err == nil && info.IsDir() {
		return d.failed(request, "", "NOT_DIRECTORY", fmt.Sprintf("cannot edit a directory: %s", resolved.path))
	}

	// Read, edit validation, and write run atomically under the per-path lock:
	// all edits are matched against the same latest snapshot, then applied only
	// after every range is valid and non-overlapping. The response version
	// (bytesWritten/mtimeMs) is captured under the lock so it cannot belong to a
	// subsequent writer.
	var applied int
	var bytesWritten int64
	var mtimeMs int64
	var currentContent string
	lockErr := withPathLock(resolved.path, func() error {
		content, err := os.ReadFile(resolved.path)
		if err != nil {
			return err
		}
		text := string(content)
		currentContent = text
		updated, err := applyFSEdits(text, params.Edits)
		if err != nil {
			return err
		}
		text = updated
		applied = len(params.Edits)
		if err := os.WriteFile(resolved.path, []byte(text), 0o644); err != nil {
			return err
		}
		bytesWritten = int64(len(text))
		mtimeMs = statMtimeMs(resolved.path)
		return nil
	})
	if lockErr != nil {
		var matchErr *editMatchError
		if errors.As(lockErr, &matchErr) {
			message := formatFSEditMatchError(resolved.path, currentContent, matchErr, params.Edits[matchErr.index].OldText, len(params.Edits))
			if matchErr.matches == 0 {
				return d.failed(request, "", "EDIT_NOT_FOUND", message)
			}
			return d.failed(request, "", "EDIT_NOT_UNIQUE", message)
		}
		var inputErr *editInputError
		if errors.As(lockErr, &inputErr) {
			return d.failed(request, "", "BAD_REQUEST", inputErr.Error())
		}
		var overlapErr *editOverlapError
		if errors.As(lockErr, &overlapErr) {
			return d.failed(request, "", "BAD_REQUEST", overlapErr.Error()+"; merge nearby changes into one edit")
		}
		if errors.Is(lockErr, os.ErrNotExist) {
			return d.failed(request, "", "NOT_FOUND", fmt.Sprintf("file not found: %s", resolved.path))
		}
		return d.failedFSMutation(request, lockErr)
	}

	result := map[string]interface{}{
		"path":         resolved.path,
		"applied":      applied,
		"bytesWritten": bytesWritten,
	}
	if mtimeMs > 0 {
		result["mtimeMs"] = mtimeMs
	}
	return result
}

func (d *Dispatcher) handleFSMkdir(request protocol.RPCRequest) interface{} {
	var params fsMkdirParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return d.failed(request, "", "BAD_REQUEST", err.Error())
	}

	resolved, errResponse, ok := d.resolvePathForRequest(request, params.Path, params.CWD)
	if !ok {
		return errResponse
	}
	if isReadOnlyPath(d.cfg, resolved.path) {
		return d.failed(request, "", "READ_ONLY_FILESYSTEM", fmt.Sprintf("path is read-only: %s", resolved.path))
	}
	createdDirs, err := ensureDirs(d.cfg.WorkspaceDir, resolved.path)
	if err != nil {
		return d.failedFSMutation(request, err)
	}
	info, err := os.Stat(resolved.path)
	if err != nil {
		return d.failedFSMutation(request, err)
	}
	if !info.IsDir() {
		return d.failed(request, "", "NOT_DIRECTORY", fmt.Sprintf("cannot create directory over a file: %s", resolved.path))
	}
	return map[string]interface{}{
		"path":        resolved.path,
		"createdDirs": createdDirs,
		"mtimeMs":     info.ModTime().UnixMilli(),
	}
}

type fsStatParams struct {
	Path string `json:"path"`
	CWD  string `json:"cwd"`
}

func (d *Dispatcher) handleFSStat(request protocol.RPCRequest) interface{} {
	var params fsStatParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return d.failed(request, "", "BAD_REQUEST", err.Error())
	}

	resolved, errResponse, ok := d.resolvePathForRequest(request, params.Path, params.CWD)
	if !ok {
		return errResponse
	}

	info, err := os.Stat(resolved.path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]interface{}{
				"path":        resolved.path,
				"exists":      false,
				"isDirectory": false,
			}
		}
		return d.failed(request, "", "IO_ERROR", err.Error())
	}

	result := map[string]interface{}{
		"path":        resolved.path,
		"exists":      true,
		"isDirectory": info.IsDir(),
		"isFile":      info.Mode().IsRegular(),
		"size":        info.Size(),
		"mtimeMs":     info.ModTime().UnixMilli(),
	}
	if ctimeMs, ok := fileCtimeMs(info); ok {
		result["ctimeMs"] = ctimeMs
	}
	return result
}

func (d *Dispatcher) handleFSLs(request protocol.RPCRequest) interface{} {
	var params fsLsParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return d.failed(request, "", "BAD_REQUEST", err.Error())
	}

	resolved, errResponse, ok := d.resolvePathForRequest(request, params.Path, params.CWD)
	if !ok {
		return errResponse
	}

	info, err := os.Stat(resolved.path)
	if err != nil {
		if os.IsNotExist(err) {
			return d.failed(request, "", "NOT_FOUND", err.Error())
		}
		return d.failed(request, "", "IO_ERROR", err.Error())
	}
	if !info.IsDir() {
		return d.failed(request, "", "NOT_DIRECTORY", fmt.Sprintf("not a directory: %s", resolved.path))
	}

	entries, err := osReadDir(resolved.path)
	if err != nil {
		return d.failed(request, "", "IO_ERROR", err.Error())
	}

	results := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() {
			name += "/"
		}
		results = append(results, name)
	}
	sort.Slice(results, func(i, j int) bool {
		return strings.ToLower(results[i]) < strings.ToLower(results[j])
	})

	limit := params.Limit
	if limit <= 0 {
		limit = 500
	}
	truncated := len(results) > limit
	if truncated {
		results = results[:limit]
	}

	return map[string]interface{}{
		"path":      resolved.path,
		"entries":   results,
		"truncated": truncated,
	}
}

type fsTreeEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Type    string `json:"type"`
	Size    int64  `json:"size"`
	MtimeMs int64  `json:"mtimeMs"`
}

// handleFSTree walks a directory breadth-first up to depth, returning a flat
// list of entries with metadata. Entry paths are relative to the requested
// root so callers can compose their own workspace-relative paths. It always
// hides .git and, when respectGitignore is set (default), applies the
// workspace root .gitignore for parity with the web file tree.
func (d *Dispatcher) handleFSTree(request protocol.RPCRequest) interface{} {
	var params fsTreeParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return d.failed(request, "", "BAD_REQUEST", err.Error())
	}

	resolved, errResponse, ok := d.resolvePathForRequest(request, params.Path, params.CWD)
	if !ok {
		return errResponse
	}

	info, err := os.Stat(resolved.path)
	if err != nil {
		if os.IsNotExist(err) {
			return d.failed(request, "", "NOT_FOUND", err.Error())
		}
		return d.failed(request, "", "IO_ERROR", err.Error())
	}
	if !info.IsDir() {
		return d.failed(request, "", "NOT_DIRECTORY", fmt.Sprintf("not a directory: %s", resolved.path))
	}

	depth := params.Depth
	if depth <= 0 {
		depth = 1
	}
	if depth > 10 {
		depth = 10
	}
	limit := params.Limit
	if limit <= 0 {
		limit = 1000
	}
	if limit > 5000 {
		limit = 5000
	}
	respectGitignore := params.RespectGitignore == nil || *params.RespectGitignore

	matcher := d.loadGitignore(respectGitignore)

	entries := make([]fsTreeEntry, 0, 64)
	truncated := false

	type queued struct {
		absPath string
		relPath string
		level   int
	}
	queue := []queued{{absPath: resolved.path, relPath: "", level: 0}}

	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		if current.level >= depth {
			continue
		}

		dirEntries, readErr := osReadDir(current.absPath)
		if readErr != nil {
			// The requested root must be readable; a failure there is a hard
			// error rather than a silently empty tree. Deeper directories may
			// legitimately be unreadable (permissions, races) and are skipped.
			if current.level == 0 {
				return d.failed(request, "", "IO_ERROR", readErr.Error())
			}
			continue
		}
		sort.Slice(dirEntries, func(i, j int) bool {
			return strings.ToLower(dirEntries[i].Name()) < strings.ToLower(dirEntries[j].Name())
		})

		for _, entry := range dirEntries {
			name := entry.Name()
			relPath := name
			if current.relPath != "" {
				relPath = current.relPath + "/" + name
			}
			if matcher != nil && matcher.ignore(relPath, entry.IsDir()) {
				continue
			}

			if len(entries) >= limit {
				truncated = true
				queue = nil
				break
			}

			absChild := filepath.Join(current.absPath, name)
			stats, statErr := os.Lstat(absChild)
			if statErr != nil {
				continue
			}
			nodeType := "file"
			if stats.Mode()&os.ModeSymlink != 0 {
				nodeType = "symlink"
			} else if stats.IsDir() {
				nodeType = "dir"
			}
			entries = append(entries, fsTreeEntry{
				Name:    name,
				Path:    relPath,
				Type:    nodeType,
				Size:    stats.Size(),
				MtimeMs: stats.ModTime().UnixMilli(),
			})
			if nodeType == "dir" && current.level+1 < depth {
				queue = append(queue, queued{absPath: absChild, relPath: relPath, level: current.level + 1})
			}
		}
	}

	return map[string]interface{}{
		"path":      resolved.path,
		"entries":   entries,
		"truncated": truncated,
	}
}

func (d *Dispatcher) handleFSFind(request protocol.RPCRequest) interface{} {
	var params fsFindParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return d.failed(request, "", "BAD_REQUEST", err.Error())
	}

	resolved, errResponse, ok := d.resolvePathForRequest(request, params.Path, params.CWD)
	if !ok {
		return errResponse
	}

	limit := params.Limit
	if limit <= 0 {
		limit = 1000
	}

	args := []string{"--color=never"}
	switch params.Mode {
	case "glob":
		args = append(args, "--glob")
	case "fixed-strings":
		args = append(args, "--fixed-strings")
	}
	if params.Hidden {
		args = append(args, "--hidden")
	}
	if !params.RequireGit {
		args = append(args, "--no-require-git")
	}
	if params.IgnoreVcs {
		args = append(args, "--no-ignore-vcs")
	}
	if params.FullPath {
		args = append(args, "--full-path")
	}
	for _, pattern := range params.Ignore {
		if pattern != "" {
			args = append(args, "--exclude", pattern)
		}
	}

	args = append(args, "--max-results", fmt.Sprintf("%d", limit))
	args = append(args, params.Pattern, resolved.path)

	cmd := exec.Command("fd", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		if strings.Contains(err.Error(), "executable file not found") {
			return d.failed(request, "", "INTERNAL_ERROR", "fd is not installed in sandbox")
		}
		stderr := strings.TrimSpace(string(output))
		if stderr == "" {
			stderr = err.Error()
		}
		return d.failed(request, "", "IO_ERROR", stderr)
	}

	matches := make([]string, 0)
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if line == "" {
			continue
		}
		relativePath, relErr := filepath.Rel(resolved.path, line)
		if relErr != nil {
			matches = append(matches, line)
		} else {
			matches = append(matches, filepath.ToSlash(relativePath))
		}
	}
	truncated := len(matches) > limit
	if truncated {
		matches = matches[:limit]
	}

	return map[string]interface{}{
		"path":      resolved.path,
		"matches":   matches,
		"truncated": truncated,
	}
}

// handleFSSearch returns the rg targets that search exactly what an rg walk of
// the requested path would, or a fallback reason when the index cannot tell.
// Paths are relative to the requested path; root is its workspace-relative
// form.
func (d *Dispatcher) handleFSSearch(request protocol.RPCRequest) interface{} {
	var params fsSearchParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return d.failed(request, "", "BAD_REQUEST", err.Error())
	}
	resolved, errResponse, ok := d.resolvePathForRequest(request, params.Path, params.CWD)
	if !ok {
		return errResponse
	}
	manager, root, fallback := d.searchScope(resolved.path)
	if fallback != "" {
		return map[string]interface{}{"path": resolved.path, "fallback": fallback}
	}
	plan, err := manager.Plan(context.Background(), search.PlanInput{
		Pattern:      params.Pattern,
		FixedStrings: params.FixedStrings,
		IgnoreCase:   params.IgnoreCase,
		PathPrefix:   root,
		Glob:         params.Glob,
		Limit:        params.Limit,
	})
	if err != nil {
		return d.failed(request, "", "INTERNAL_ERROR", err.Error())
	}
	if plan.Fallback != "" {
		return map[string]interface{}{"path": resolved.path, "fallback": plan.Fallback}
	}
	return map[string]interface{}{
		"path":      resolved.path,
		"root":      root,
		"files":     relativeToRoot(root, plan.Files),
		"walkFiles": relativeToRoot(root, plan.WalkFiles),
		"dirs":      relativeToRoot(root, plan.Dirs),
	}
}

// handleFSPathSearch returns what fd reports for a glob below the requested
// path, plus directories fd must still walk, or a fallback reason.
func (d *Dispatcher) handleFSPathSearch(request protocol.RPCRequest) interface{} {
	var params fsPathSearchParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return d.failed(request, "", "BAD_REQUEST", err.Error())
	}
	resolved, errResponse, ok := d.resolvePathForRequest(request, params.Path, params.CWD)
	if !ok {
		return errResponse
	}
	manager, root, fallback := d.searchScope(resolved.path)
	if fallback != "" {
		return map[string]interface{}{"path": resolved.path, "fallback": fallback}
	}
	result, err := manager.Paths(context.Background(), search.PathInput{
		Pattern:    params.Pattern,
		PathPrefix: root,
		FullPath:   params.FullPath,
		Limit:      params.Limit,
	})
	if err != nil {
		return d.failed(request, "", "INTERNAL_ERROR", err.Error())
	}
	if result.Fallback != "" {
		return map[string]interface{}{"path": resolved.path, "fallback": result.Fallback}
	}
	return map[string]interface{}{
		"path":      resolved.path,
		"root":      root,
		"matches":   relativeToRoot(root, result.Matches),
		"truncated": result.Truncated,
		"dirs":      relativeToRoot(root, result.Dirs),
	}
}

// searchScope maps a resolved path to its workspace-relative index root.
func (d *Dispatcher) searchScope(path string) (*search.Manager, string, string) {
	d.mu.Lock()
	manager := d.searchManager
	d.mu.Unlock()
	if manager == nil || !manager.Enabled() {
		return nil, "", search.FallbackUnavailable
	}
	root, err := filepath.Rel(d.cfg.WorkspaceDir, path)
	if err != nil || root == ".." || strings.HasPrefix(root, ".."+string(filepath.Separator)) {
		return nil, "", "scope"
	}
	if root == "." {
		return manager, "", ""
	}
	return manager, filepath.ToSlash(root), ""
}

func relativeToRoot(root string, paths []string) []string {
	relative := make([]string, 0, len(paths))
	for _, path := range paths {
		if root != "" {
			path = strings.TrimPrefix(path, root+"/")
		}
		relative = append(relative, path)
	}
	return relative
}

func (d *Dispatcher) handleFSGrep(request protocol.RPCRequest) interface{} {
	var params fsGrepParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return d.failed(request, "", "BAD_REQUEST", err.Error())
	}

	resolved, errResponse, ok := d.resolvePathForRequest(request, params.Path, params.CWD)
	if !ok {
		return errResponse
	}

	limit := params.Limit
	if limit <= 0 {
		limit = 100
	}

	args := []string{"--line-number", "--color=never"}
	if params.Hidden {
		args = append(args, "--hidden")
	}
	if !params.RequireGit {
		args = append(args, "--no-require-git")
	}
	if params.IgnoreVcs {
		args = append(args, "--no-ignore-vcs")
	}
	if params.MaxCount > 0 {
		args = append(args, "--max-count", fmt.Sprintf("%d", params.MaxCount))
	}
	if params.JSON {
		args = append(args, "--json")
	}
	if params.Context > 0 {
		args = append(args, "--context", fmt.Sprintf("%d", params.Context))
	}
	if params.IgnoreCase {
		args = append(args, "--ignore-case")
	}
	if params.Literal {
		args = append(args, "--fixed-strings")
	}
	if strings.TrimSpace(params.Glob) != "" {
		args = append(args, "--glob", params.Glob)
	}
	args = append(args, params.Pattern, resolved.path)

	cmd := exec.Command("rg", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		if exec.ErrNotFound != nil && strings.Contains(err.Error(), exec.ErrNotFound.Error()) {
			return d.failed(request, "", "INTERNAL_ERROR", "rg is not installed in sandbox")
		}

		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			outputText := strings.TrimSpace(string(output))
			if outputText == "" {
				return map[string]interface{}{
					"path":      resolved.path,
					"lines":     []string{},
					"truncated": false,
				}
			}
			if params.JSON {
				lines := make([]string, 0)
				for _, line := range strings.Split(outputText, "\n") {
					trimmed := strings.TrimSpace(line)
					if trimmed == "" {
						continue
					}
					lines = append(lines, trimmed)
				}
				onlySummary := true
				for _, line := range lines {
					var payload struct {
						Type string `json:"type"`
					}
					if json.Unmarshal([]byte(line), &payload) != nil || payload.Type != "summary" {
						onlySummary = false
						break
					}
				}
				if onlySummary && len(lines) > 0 {
					return map[string]interface{}{
						"path":      resolved.path,
						"lines":     []string{},
						"truncated": false,
					}
				}
			}
		}

		stderr := strings.TrimSpace(string(output))
		if stderr == "" {
			stderr = err.Error()
		}
		if !strings.Contains(stderr, "No files were searched") && !strings.Contains(stderr, "No such file or directory") {
			return d.failed(request, "", "IO_ERROR", stderr)
		}
	}

	lines := make([]string, 0)
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if line == "" {
			continue
		}
		lines = append(lines, line)
	}
	truncated := len(lines) > limit
	if truncated {
		lines = lines[:limit]
	}

	return map[string]interface{}{
		"path":      resolved.path,
		"lines":     lines,
		"truncated": truncated,
	}
}

func validateProcessArgv(argv []string) error {
	if len(argv) == 0 {
		return fmt.Errorf("argv must be non-empty")
	}
	if len(argv) > processStartMaxArgvItems {
		return fmt.Errorf("argv has too many items: %d > %d", len(argv), processStartMaxArgvItems)
	}
	totalBytes := 0
	for i, item := range argv {
		itemBytes := len([]byte(item))
		if itemBytes == 0 && i == 0 {
			return fmt.Errorf("argv[0] must be a non-empty executable")
		}
		if itemBytes > processStartMaxArgvItemBytes {
			return fmt.Errorf("argv[%d] is too large: %d > %d bytes", i, itemBytes, processStartMaxArgvItemBytes)
		}
		totalBytes += itemBytes
		if totalBytes > processStartMaxArgvTotalBytes {
			return fmt.Errorf("argv is too large: %d > %d bytes", totalBytes, processStartMaxArgvTotalBytes)
		}
	}
	return nil
}

func processArgvSummary(argv []string, limit int) string {
	if limit <= 0 {
		return ""
	}
	var b strings.Builder
	for i, item := range argv {
		if i > 0 {
			if b.Len()+1 > limit {
				return b.String()
			}
			b.WriteByte(' ')
		}
		remaining := limit - b.Len()
		if remaining <= 0 {
			break
		}
		if len(item) > remaining {
			b.WriteString(item[:remaining])
			break
		}
		b.WriteString(item)
	}
	return b.String()
}

type processOutput struct {
	typeName string
	chunk    string
}

func (d *Dispatcher) handleProcessStart(request protocol.RPCRequest, opID string, ownerIdentity string) interface{} {
	var params processStartParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return d.failed(request, opID, "BAD_REQUEST", err.Error())
	}

	commandProvided := strings.TrimSpace(params.Command) != ""
	argvProvided := len(params.Argv) > 0
	if commandProvided == argvProvided {
		return d.failed(request, opID, "BAD_REQUEST", "exactly one of command or argv must be provided")
	}
	if argvProvided {
		if err := validateProcessArgv(params.Argv); err != nil {
			return d.failed(request, opID, "BAD_REQUEST", err.Error())
		}
	}

	cmdSummary := strings.TrimSpace(params.Command)
	if argvProvided {
		cmdSummary = processArgvSummary(params.Argv, 80)
	}
	if len(cmdSummary) > 80 {
		cmdSummary = cmdSummary[:80]
	}

	resolved, errResponse, ok := d.resolvePathForRequest(request, params.CWD, d.cfg.WorkspaceDir)
	if !ok {
		return errResponse
	}

	info, err := os.Stat(resolved.path)
	if err != nil {
		if os.IsNotExist(err) {
			return d.failed(request, opID, "NOT_FOUND", err.Error())
		}
		return d.failed(request, opID, "IO_ERROR", err.Error())
	}
	if !info.IsDir() {
		return d.failed(request, opID, "NOT_DIRECTORY", fmt.Sprintf("not a directory: %s", resolved.path))
	}

	processID, stdout, stderr, exitCh, err := d.processManager.StartWithOptions(ownerIdentity, process.StartOptions{
		Command:     params.Command,
		Argv:        params.Argv,
		CWD:         resolved.path,
		TimeoutSecs: params.TimeoutSecs,
		Env:         params.Env,
	})
	if err != nil {
		d.logger.Error("process:start failed", slog.String("cmd", cmdSummary), slog.String("error", err.Error()))
		return d.failed(request, opID, "PROCESS_SPAWN_FAILED", err.Error())
	}
	d.logger.Info("process:start", slog.String("processId", processID), slog.String("ownerIdentity", ownerIdentity), slog.String("cmd", cmdSummary), slog.String("cwd", resolved.path))

	var outputSendFailed atomic.Bool
	if err := d.sendEventToIdentity(ownerIdentity, d.event(request, opID, protocol.RPCEventPayload{Type: "started", ProcessID: processID})); err != nil {
		outputSendFailed.Store(true)
		d.logger.Warn("process:started event delivery failed", slog.String("processId", processID), slog.String("ownerIdentity", ownerIdentity), slog.String("error", err.Error()))
	}

	outputQueue := make(chan processOutput, processOutputQueueSize)
	outputSendDone := make(chan struct{})
	go func() {
		defer close(outputSendDone)
		for output := range outputQueue {
			if outputSendFailed.Load() {
				continue
			}
			if err := d.sendEventToIdentity(ownerIdentity, d.event(request, opID, protocol.RPCEventPayload{Type: output.typeName, Chunk: output.chunk})); err != nil && outputSendFailed.CompareAndSwap(false, true) {
				d.logger.Warn("process output delivery failed; dropping remaining output", slog.String("processId", processID), slog.String("ownerIdentity", ownerIdentity), slog.String("error", err.Error()))
			}
		}
	}()

	stdoutStream, stderrStream := process.StreamBoth(stdout, stderr, func(chunk string, stream process.Stream) {
		if outputSendFailed.Load() {
			return
		}
		typeName := "stdout"
		if stream == process.StreamStderr {
			typeName = "stderr"
		}
		select {
		case outputQueue <- processOutput{typeName: typeName, chunk: chunk}:
		default:
			if outputSendFailed.CompareAndSwap(false, true) {
				d.logger.Warn("process output queue full; dropping remaining output", slog.String("processId", processID), slog.String("ownerIdentity", ownerIdentity))
			}
		}
	})

	// The exit event and completed message are sent after the stream goroutines
	// have drained or been released by WaitDelay. When output delivery fails,
	// remaining output is intentionally dropped rather than blocking the
	// process forever, but terminal events are still attempted.
	go func() {
		exitInfo := <-exitCh
		streamErr := process.WaitStreams(stdoutStream, stderrStream)
		if streamErr != nil {
			outputSendFailed.Store(true)
			d.logger.Warn("process output read failed; output may be truncated", slog.String("processId", processID), slog.String("ownerIdentity", ownerIdentity), slog.String("error", streamErr.Error()))
		}
		close(outputQueue)
		<-outputSendDone
		termination := processTermination(exitInfo)
		termination.OutputTruncated = outputSendFailed.Load() || exitInfo.OutputTruncated
		if termination.OutputTruncated && termination.Message == "" {
			termination.Message = "Process output was truncated before completion."
		}
		codeStr := "unknown"
		if exitInfo.ExitCode != nil {
			codeStr = fmt.Sprintf("%d", *exitInfo.ExitCode)
		}
		d.logger.Info("process:exit", slog.String("processId", processID), slog.String("ownerIdentity", ownerIdentity), slog.String("exitCode", codeStr), slog.String("reason", termination.Reason), slog.String("cmd", cmdSummary))
		if err := d.sendEventToIdentity(ownerIdentity, d.event(request, opID, protocol.RPCEventPayload{Type: "exit", ExitCode: exitInfo.ExitCode, Termination: termination})); err != nil {
			d.logger.Warn("process exit event delivery failed", slog.String("processId", processID), slog.String("ownerIdentity", ownerIdentity), slog.String("error", err.Error()))
		}
		result := map[string]interface{}{
			"processId":   processID,
			"exitCode":    exitInfo.ExitCode,
			"termination": termination,
		}
		if err := d.sendEventToIdentity(ownerIdentity, d.complete(request, opID, result)); err != nil {
			d.logger.Warn("process completed message delivery failed", slog.String("processId", processID), slog.String("ownerIdentity", ownerIdentity), slog.String("error", err.Error()))
		}
	}()

	return nil
}

func processTermination(exitInfo process.ExitInfo) *protocol.ProcessTermination {
	reason := exitInfo.Reason
	message := ""
	switch reason {
	case "timeout":
		reason = "timed_out"
		message = fmt.Sprintf("Command timed out after %d seconds.", exitInfo.TimeoutSecs)
	case "abort", "identity_disconnect":
		reason = "aborted"
		message = "Command aborted."
	case "exited", "":
		reason = "exited"
	default:
		reason = "aborted"
		message = "Command aborted."
	}

	termination := &protocol.ProcessTermination{
		Reason:          reason,
		ExitCode:        exitInfo.ExitCode,
		Message:         message,
		OutputTruncated: exitInfo.OutputTruncated,
	}
	if exitInfo.OutputTruncated && termination.Message == "" {
		termination.Message = "Process output was truncated before completion."
	}
	if reason == "timed_out" && exitInfo.TimeoutSecs > 0 {
		termination.TimeoutSecs = exitInfo.TimeoutSecs
	}
	return termination
}

func (d *Dispatcher) handleProcessAbort(request protocol.RPCRequest) interface{} {
	var params processAbortParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return d.failed(request, "", "BAD_REQUEST", err.Error())
	}

	if err := d.processManager.Abort(params.ProcessID); err != nil {
		d.logger.Warn("process:abort failed", slog.String("processId", params.ProcessID), slog.String("error", err.Error()))
		return d.failed(request, "", "PROCESS_ABORT_FAILED", err.Error())
	}
	d.logger.Info("process:abort", slog.String("processId", params.ProcessID))

	return map[string]interface{}{
		"processId": params.ProcessID,
		"aborted":   true,
	}
}

func (d *Dispatcher) complete(request protocol.RPCRequest, opID string, result interface{}) interface{} {
	// If a handler already produced a terminal failure payload, enrich and forward it.
	// Note: the type assertion yields a value copy; we intentionally mutate that copy
	// and return it as the finalized failed payload.
	if failed, ok := result.(protocol.RPCFailed); ok {
		if opID != "" && failed.OpID == "" {
			failed.OpID = opID
		}
		if failed.Seq == 0 {
			failed.Seq = d.nextSeq()
		}
		return failed
	}
	return protocol.RPCCompleted{
		OperationScopedMessage: protocol.OperationScopedMessage{
			BaseMessage: protocol.BaseMessage{
				Version:   protocol.Version,
				Type:      "rpc.completed",
				SpaceID:   request.SpaceID,
				SandboxID: request.SandboxID,
				Timestamp: nowMS(),
			},
			OpID:       opID,
			RequestID:  request.RequestID,
			Seq:        d.nextSeq(),
			SessionID:  request.SessionID,
			ToolCallID: request.ToolCallID,
		},
		Result: result,
	}
}

func (d *Dispatcher) failed(request protocol.RPCRequest, opID string, code string, message string) protocol.RPCFailed {
	return protocol.RPCFailed{
		OperationScopedMessage: protocol.OperationScopedMessage{
			BaseMessage: protocol.BaseMessage{
				Version:   protocol.Version,
				Type:      "rpc.failed",
				SpaceID:   request.SpaceID,
				SandboxID: request.SandboxID,
				Timestamp: nowMS(),
			},
			OpID:       opID,
			RequestID:  request.RequestID,
			Seq:        d.nextSeq(),
			SessionID:  request.SessionID,
			ToolCallID: request.ToolCallID,
		},
		Error: protocol.RPCErrorPayload{Code: code, Message: message, Retryable: false},
	}
}

func (d *Dispatcher) event(request protocol.RPCRequest, opID string, event protocol.RPCEventPayload) protocol.RPCEvent {
	return protocol.RPCEvent{
		OperationScopedMessage: protocol.OperationScopedMessage{
			BaseMessage: protocol.BaseMessage{
				Version:   protocol.Version,
				Type:      "rpc.event",
				SpaceID:   request.SpaceID,
				SandboxID: request.SandboxID,
				Timestamp: nowMS(),
			},
			OpID:       opID,
			RequestID:  request.RequestID,
			Seq:        d.nextSeq(),
			SessionID:  request.SessionID,
			ToolCallID: request.ToolCallID,
		},
		Event: event,
	}
}

func (d *Dispatcher) sendEventToIdentity(identity string, payload interface{}) error {
	d.mu.Lock()
	router := d.router
	d.mu.Unlock()
	if router == nil {
		return nil
	}
	return router.SendToIdentity(identity, payload)
}
