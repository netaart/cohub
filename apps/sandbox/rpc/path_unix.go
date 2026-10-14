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

func pathWithin(root, path string) bool {
	return path == root || strings.HasPrefix(path, root+string(filepath.Separator))
}
