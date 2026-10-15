//go:build windows

package rpc

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

var errUnsupportedWindowsPath = errors.New("unsupported path: UNC, device, alternate data stream and names ending in a dot or space are not allowed")

// Rooted paths without a drive, such as the virtual /workspace, are sandbox
// absolute paths; filepath.IsAbs would treat them as relative on Windows.
func isAbsSandboxPath(path string) bool {
	return filepath.IsAbs(path) || (path != "" && os.IsPathSeparator(path[0]))
}

// Requested paths may only name local drive paths. UNC/device prefixes (\\server,
// \\?\, \\.\) bypass normalization, and a colon outside the drive names a stream.
func validateHostPathSyntax(path string) error {
	if len(path) >= 2 && os.IsPathSeparator(path[0]) && os.IsPathSeparator(path[1]) {
		return errUnsupportedWindowsPath
	}
	volume := filepath.VolumeName(path)
	// Drive-relative paths (C:foo) depend on per-drive cwd state and would join into a stream name.
	if volume != "" && !filepath.IsAbs(path) {
		return errUnsupportedWindowsPath
	}
	if strings.Contains(path[len(volume):], ":") {
		return errUnsupportedWindowsPath
	}
	// Win32 strips trailing dots and spaces from names, so "a." opens "a" and the
	// fence's lexical view would differ from the file actually opened.
	for _, name := range strings.FieldsFunc(path[len(volume):], func(r rune) bool { return r < 128 && os.IsPathSeparator(uint8(r)) }) {
		if name != "." && name != ".." && strings.TrimRight(name, ". ") != name {
			return errUnsupportedWindowsPath
		}
	}
	return nil
}

// NTFS paths are case-insensitive, so the fence must compare them that way.
func pathWithin(root, path string) bool {
	if len(path) < len(root) || !strings.EqualFold(path[:len(root)], root) {
		return false
	}
	// A clean drive root (C:\) already ends with its separator.
	return len(path) == len(root) || os.IsPathSeparator(path[len(root)]) || strings.HasSuffix(root, string(filepath.Separator))
}

func samePath(a, b string) bool {
	return strings.EqualFold(a, b)
}

func canonicalExistingPath(path string) (string, error) {
	name := filepath.Clean(path)
	if filepath.IsAbs(name) && !strings.HasPrefix(name, `\\?\`) {
		if strings.HasPrefix(name, `\\`) {
			name = `\\?\UNC\` + name[2:]
		} else {
			name = `\\?\` + name
		}
	}
	pointer, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return "", err
	}
	// Metadata-only shared handles work while the root watcher keeps its handle open.
	handle, err := windows.CreateFile(pointer, 0,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", &os.PathError{Op: "realpath", Path: path, Err: err}
	}
	defer windows.CloseHandle(handle)
	buffer := make([]uint16, 512)
	for {
		n, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 0)
		if err != nil {
			return "", &os.PathError{Op: "realpath", Path: path, Err: err}
		}
		if n >= uint32(len(buffer)) {
			buffer = make([]uint16, n+1)
			continue
		}
		resolved := windows.UTF16ToString(buffer[:n])
		if strings.HasPrefix(resolved, `\\?\UNC\`) {
			return `\\` + resolved[len(`\\?\UNC\`):], nil
		}
		return strings.TrimPrefix(resolved, `\\?\`), nil
	}
}
