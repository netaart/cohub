//go:build !windows

package ws

import (
	"log/slog"
	"os"
	"syscall"
)

func (s *Server) selfTerminate(reason string) {
	if err := syscall.Kill(syscall.Getpid(), syscall.SIGTERM); err != nil {
		s.logger.Error("failed to signal sandbox for self-heal shutdown", slog.String("reason", reason), slog.String("error", err.Error()))
		os.Exit(1)
	}
}

// Unix hosts keep the coreutils argv fallback for deletes and moves.
const nativeFSMutations = false
