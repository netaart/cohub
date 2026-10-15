//go:build !windows

package rpc

import (
	"path/filepath"
	"strings"
)

func isAbsSandboxPath(path string) bool {
	return filepath.IsAbs(path)
}

func validateHostPathSyntax(string) error {
	return nil
}

// A clean root keeps a trailing separator only when it is "/".
func pathWithin(root, path string) bool {
	return path == root || strings.HasPrefix(path, strings.TrimSuffix(root, string(filepath.Separator))+string(filepath.Separator))
}

func samePath(a, b string) bool {
	return a == b
}

func canonicalExistingPath(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
