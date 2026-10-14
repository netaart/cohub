//go:build windows

package rpc

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

var errUnsupportedWindowsPath = errors.New("unsupported path: UNC, device and alternate data stream paths are not allowed")

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
	return nil
}

// NTFS paths are case-insensitive, so the fence must compare them that way.
func pathWithin(root, path string) bool {
	if len(path) < len(root) || !strings.EqualFold(path[:len(root)], root) {
		return false
	}
	return len(path) == len(root) || os.IsPathSeparator(path[len(root)])
}
