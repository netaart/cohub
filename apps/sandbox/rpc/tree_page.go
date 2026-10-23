package rpc

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/cohub/apps/sandbox/protocol"
)

type treeCursor struct {
	Version int    `json:"v"`
	Scope   string `json:"s"`
	After   string `json:"a"`
}

func (d *Dispatcher) listTreePage(request protocol.RPCRequest, params fsTreeParams, root string) interface{} {
	if params.Depth > 1 || params.Depth < 0 || params.Limit < 0 || params.Limit > 5000 {
		return d.failed(request, "", "BAD_REQUEST", "Directory pagination requires depth 1 and a page size up to 5000.")
	}
	limit := params.Limit
	if limit == 0 {
		limit = 1000
	}
	respectGitignore := params.RespectGitignore == nil || *params.RespectGitignore
	scope := fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("%s:%t", root, respectGitignore))))
	cursor := treeCursor{Version: 1, Scope: scope}
	if params.Cursor != "" {
		if len(params.Cursor) > 16384 {
			return d.failed(request, "", "INVALID_CURSOR", "Invalid directory cursor.")
		}
		var decoded treeCursor
		data, err := base64.RawURLEncoding.DecodeString(params.Cursor)
		if err != nil || json.Unmarshal(data, &decoded) != nil || decoded.Version != 1 || decoded.Scope != scope {
			return d.failed(request, "", "INVALID_CURSOR", "Invalid directory cursor.")
		}
		cursor = decoded
	}
	names, err := osReadDir(root)
	if err != nil {
		return d.failed(request, "", "IO_ERROR", err.Error())
	}
	sort.Slice(names, func(i, j int) bool { return names[i].Name() < names[j].Name() })
	start := sort.Search(len(names), func(i int) bool { return names[i].Name() > cursor.After })
	end := min(start+limit, len(names))
	matcher := d.loadGitignore(respectGitignore)
	entries := make([]fsTreeEntry, 0, end-start)
	for _, entry := range names[start:end] {
		name := entry.Name()
		if matcher != nil && matcher.ignore(name, entry.IsDir()) {
			continue
		}
		stats, err := os.Lstat(filepath.Join(root, name))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return d.failed(request, "", "IO_ERROR", err.Error())
		}
		nodeType := "file"
		if stats.Mode()&os.ModeSymlink != 0 {
			nodeType = "symlink"
		} else if stats.IsDir() {
			nodeType = "dir"
		}
		entries = append(entries, fsTreeEntry{Name: name, Path: name, Type: nodeType, Size: stats.Size(), MtimeMs: stats.ModTime().UnixMilli()})
	}
	var next interface{}
	if end < len(names) {
		cursor.After = names[end-1].Name()
		data, _ := json.Marshal(cursor)
		next = base64.RawURLEncoding.EncodeToString(data)
	}
	return map[string]interface{}{"path": root, "entries": entries, "nextCursor": next, "truncated": false}
}
