//go:build windows

package rpc

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
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
