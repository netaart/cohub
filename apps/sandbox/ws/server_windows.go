//go:build windows

package ws

import (
	"log/slog"
	"os"
)

// Windows cannot deliver SIGTERM to itself, so self-heal exits directly.
func (s *Server) selfTerminate(reason string) {
	s.logger.Error("sandbox self-heal shutdown", slog.String("reason", reason))
	os.Exit(1)
}

// Windows hosts lack rm/mv; deletes and moves use native fs RPCs.
const nativeFSMutations = true
