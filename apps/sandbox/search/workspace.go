package search

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/filewatch"
	"github.com/google/uuid"
)

const maxIndexedFileBytes = 4 * 1024 * 1024
const maxMutationBatchBytes = 16 * 1024 * 1024

type workspaceAdapter struct {
	cfg        env.Config
	client     *client
	known      map[string]string
	cursor     string
	generation string
}

func (a *workspaceAdapter) reference(path string) documentRef {
	return documentRef{Type: "file", SpaceID: a.cfg.SpaceID, ID: path}
}

func (a *workspaceAdapter) filters() []searchFilter {
	return []searchFilter{
		{Field: "_type", Operation: "equal", Value: "file"},
		{Field: "_space", Operation: "equal", Value: a.cfg.SpaceID},
	}
}

// Fingerprints live in the same durable commit as the indexed content, so a
// restart never trusts a newer filesystem snapshot paired with an older index.
func (a *workspaceAdapter) snapshot(ctx context.Context) (map[string]string, error) {
	entries := map[string]string{}
	query := documentQuery{Terms: []searchTerm{}, Filters: a.filters(), Limit: 256}
	for {
		result, err := a.client.query(ctx, query)
		if err != nil {
			return nil, err
		}
		for _, hit := range result.Hits {
			entries[hit.Document.ID] = hit.Fields["fingerprint"]
		}
		if !result.Truncated {
			return entries, nil
		}
		query.Offset += len(result.Hits)
		query.Snapshot = result.Snapshot
	}
}

func escapeGlob(value string) string {
	return strings.NewReplacer("\\", "\\\\", "*", "\\*", "?", "\\?", "[", "\\[", "]", "\\]", "{", "\\{", "}", "\\}", ",", "\\,").Replace(value)
}

func workspaceFiles(ctx context.Context, workspace string) ([]string, error) {
	args := []string{"--files", "--hidden", "--null", "--no-config", "--no-require-git", "--no-ignore-parent", "--no-ignore-global", "--no-ignore-exclude", "--no-ignore-dot"}
	for _, pattern := range filewatch.IgnorePatterns() {
		pattern = escapeGlob(pattern)
		if strings.Contains(pattern, "/") {
			pattern = "/" + pattern
		}
		args = append(args, "--glob", "!"+pattern, "--glob", "!"+pattern+"/**")
	}
	args = append(args, "--", ".")
	cmd := exec.CommandContext(ctx, "rg", args...)
	cmd.Dir = workspace
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 1 || len(output) != 0 || stderr.Len() != 0 {
			return nil, fmt.Errorf("enumerate workspace with rg / 枚举工作区失败: %w: %s", err, stderr.String())
		}
	}
	paths := make([]string, 0)
	for _, path := range bytes.Split(output, []byte{0}) {
		if len(path) == 0 || !utf8.Valid(path) {
			continue
		}
		paths = append(paths, strings.TrimPrefix(filepath.ToSlash(string(path)), "./"))
	}
	sort.Strings(paths)
	return paths, nil
}

func safeRelative(path string) bool {
	return path != "" && path != "." && !filepath.IsAbs(path) && filepath.Clean(path) == path && path != ".." && !strings.HasPrefix(path, ".."+string(filepath.Separator))
}

func inspectFile(root *os.Root, path string) (os.FileInfo, error) {
	if !safeRelative(path) {
		return nil, fmt.Errorf("invalid workspace path / 工作区路径无效: %q", path)
	}
	parts := strings.Split(path, string(filepath.Separator))
	for i := range parts {
		info, err := root.Lstat(filepath.Join(parts[:i+1]...))
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, nil
		}
		if i == len(parts)-1 {
			if !info.Mode().IsRegular() {
				return nil, nil
			}
			return info, nil
		}
		if !info.IsDir() {
			return nil, nil
		}
	}
	return nil, nil
}

func fingerprint(info os.FileInfo) string {
	return fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano())
}

func (a *workspaceAdapter) readMutation(root *os.Root, relative string, info os.FileInfo) (documentMutation, error) {
	deleted := documentMutation{Operation: "delete", Document: a.reference(relative)}
	if info == nil || info.Size() > maxIndexedFileBytes {
		return deleted, nil
	}
	file, err := root.Open(filepath.FromSlash(relative))
	if errors.Is(err, os.ErrNotExist) {
		return deleted, nil
	}
	if err != nil {
		return deleted, err
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil {
		return deleted, err
	}
	if !os.SameFile(info, before) || fingerprint(info) != fingerprint(before) {
		return deleted, fmt.Errorf("file changed while indexing / 索引期间文件已变化: %s", relative)
	}
	content, err := io.ReadAll(io.LimitReader(file, maxIndexedFileBytes+1))
	if err != nil {
		return deleted, err
	}
	after, err := file.Stat()
	if err != nil {
		return deleted, err
	}
	if fingerprint(before) != fingerprint(after) {
		return deleted, fmt.Errorf("file changed while reading / 读取期间文件已变化: %s", relative)
	}
	if len(content) > maxIndexedFileBytes || bytes.IndexByte(content, 0) >= 0 || !utf8.Valid(content) {
		return deleted, nil
	}
	return documentMutation{Operation: "upsert", Document: a.reference(relative), Fields: map[string]string{"content": string(content), "fingerprint": fingerprint(after)}}, nil
}

// Each batch is conditional on the previous durable cursor. Any timeout or
// conflict exits; the manager repairs by reconciling authoritative source data.
func (a *workspaceAdapter) write(ctx context.Context, cursor **string, changes []documentMutation, coverage string) error {
	if changes == nil {
		changes = []documentMutation{}
	}
	result, err := a.client.apply(ctx, mutationBatch{ExpectedCursor: *cursor, Cursor: uuid.NewString(), Changes: changes, Coverage: coverage})
	if err != nil || coverage != "complete" {
		a.known = nil
	}
	if err != nil {
		return err
	}
	*cursor = result.SourceCursor
	return nil
}

func (a *workspaceAdapter) reconcile(ctx context.Context) error {
	previous := a.known
	a.known = nil
	status, err := a.client.status(ctx)
	if err != nil {
		return err
	}
	if status.SourceCursor == nil || *status.SourceCursor != a.cursor || status.Generation != a.generation {
		previous = nil
	}
	cursor := status.SourceCursor
	if err := a.write(ctx, &cursor, nil, "partial"); err != nil {
		return err
	}
	if previous == nil {
		previous, err = a.snapshot(ctx)
		if err != nil {
			return err
		}
	}
	paths, err := workspaceFiles(ctx, a.cfg.WorkspaceDir)
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(a.cfg.WorkspaceDir)
	if err != nil {
		return err
	}
	defer root.Close()
	changes := []documentMutation{}
	batchBytes := 0
	appendChange := func(change documentMutation) error {
		encoded, err := json.Marshal(change)
		if err != nil {
			return err
		}
		if len(changes) >= 500 || batchBytes+len(encoded) > maxMutationBatchBytes {
			if err := a.write(ctx, &cursor, changes, "partial"); err != nil {
				return err
			}
			changes = nil
			batchBytes = 0
		}
		changes = append(changes, change)
		batchBytes += len(encoded)
		return nil
	}
	next := map[string]string{}
	for _, path := range paths {
		if err := ctx.Err(); err != nil {
			return err
		}
		info, err := inspectFile(root, filepath.FromSlash(path))
		if err != nil {
			return err
		}
		old, existed := previous[path]
		delete(previous, path)
		if info != nil && old == fingerprint(info) {
			next[path] = old
			continue
		}
		change, err := a.readMutation(root, path, info)
		if err != nil {
			return err
		}
		if change.Operation == "upsert" {
			next[path] = change.Fields["fingerprint"]
		}
		if change.Operation == "delete" && !existed {
			continue
		}
		if err := appendChange(change); err != nil {
			return err
		}
	}
	for path := range previous {
		if err := appendChange(documentMutation{Operation: "delete", Document: a.reference(path)}); err != nil {
			return err
		}
	}
	if err := a.write(ctx, &cursor, changes, "complete"); err != nil {
		return err
	}
	a.known, a.cursor, a.generation = next, *cursor, status.Generation
	return nil
}

func (a *workspaceAdapter) update(ctx context.Context, batch filewatch.Batch) error {
	// New paths, directory operations and ignore-rule changes require a scan to
	// preserve nested .gitignore semantics. Ordinary edits only read changed files.
	for _, change := range batch.Changes {
		if change.Kind != "modify" || change.OldPath != "" || change.NodeType != "file" || filepath.Base(change.Path) == ".gitignore" {
			return a.reconcile(ctx)
		}
	}
	if batch.Resync {
		return a.reconcile(ctx)
	}
	status, err := a.client.status(ctx)
	if err != nil {
		return err
	}
	if status.Coverage != "complete" || a.known == nil || status.SourceCursor == nil || *status.SourceCursor != a.cursor || status.Generation != a.generation {
		return a.reconcile(ctx)
	}
	root, err := os.OpenRoot(a.cfg.WorkspaceDir)
	if err != nil {
		return err
	}
	defer root.Close()
	cursor := status.SourceCursor
	changes := []documentMutation{}
	batchBytes := 0
	seen := map[string]bool{}
	for _, change := range batch.Changes {
		if seen[change.Path] {
			continue
		}
		seen[change.Path] = true
		if _, exists := a.known[change.Path]; !exists {
			return a.reconcile(ctx)
		}
		info, err := inspectFile(root, filepath.FromSlash(change.Path))
		if err != nil {
			return err
		}
		mutation, err := a.readMutation(root, change.Path, info)
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(mutation)
		if err != nil {
			return err
		}
		if len(changes) >= 500 || batchBytes+len(encoded) > maxMutationBatchBytes {
			if err := a.write(ctx, &cursor, changes, "partial"); err != nil {
				return err
			}
			changes = nil
			batchBytes = 0
		}
		changes = append(changes, mutation)
		batchBytes += len(encoded)
	}
	if len(changes) == 0 {
		return nil
	}
	if err := a.write(ctx, &cursor, changes, "complete"); err != nil {
		a.known = nil
		return err
	}
	// Intermediate partial commits invalidate the cache and trigger a reconcile
	// on the next batch; the common one-commit edit path updates it in place.
	if a.known != nil && status.SourceCursor != nil && *status.SourceCursor == a.cursor {
		for _, change := range changes {
			if change.Operation == "delete" {
				delete(a.known, change.Document.ID)
			} else {
				a.known[change.Document.ID] = change.Fields["fingerprint"]
			}
		}
		a.cursor = *cursor
	}
	return nil
}
