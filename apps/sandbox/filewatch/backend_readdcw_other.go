//go:build !windows

package filewatch

import "log/slog"

func newReadDirectoryChangesBackend(string, *slog.Logger) (eventBackend, bool, error) {
	return nil, false, nil
}
