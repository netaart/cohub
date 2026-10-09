package filewatch

import (
	"fmt"
	"log/slog"
	"os"
	"strings"
)

const filewatchBackendEnv = "COHUB_FILEWATCH_BACKEND"

type backendEvent struct {
	path     string
	kind     string
	nodeType string
	resync   bool
	healthy  bool
	failed   bool
	reason   string
}

type eventBackend interface {
	events() <-chan backendEvent
	errors() <-chan error
	close() error
	name() string
}

// startPlatformBackend selects a low-resource backend when the current target
// provides one. Returning nil delegates to the existing fsnotify path.
func startPlatformBackend(root string, logger *slog.Logger, ignored []string) (eventBackend, error) {
	mode := strings.ToLower(strings.TrimSpace(os.Getenv(filewatchBackendEnv)))
	if mode == "" {
		mode = "auto"
	}
	switch mode {
	case "auto", "fsevents", "fsnotify", "scan":
	default:
		return nil, fmt.Errorf("unsupported %s value %q (want auto, fsevents, fsnotify, or scan)", filewatchBackendEnv, mode)
	}

	if mode == "fsnotify" {
		return nil, nil
	}
	if mode == "scan" {
		return newScannerBackend(root, logger, ignored)
	}

	backend, supported, err := newFSEventsBackend(root, logger)
	if !supported {
		if mode == "fsevents" {
			return nil, fmt.Errorf("fsevents is not supported on this platform")
		}
		return nil, nil
	}
	if err == nil {
		return backend, nil
	}
	if mode == "fsevents" {
		return nil, err
	}

	logger.Warn("fsevents unavailable; falling back to metadata scanner", slog.String("error", err.Error()))
	return newScannerBackend(root, logger, ignored)
}

// Staged uploads and copies are reported only at their installed path.
const stagingPrefix = ".cohub-upload."

func isIgnoredPath(rel string, ignored []string) bool {
	rel = strings.Trim(rel, "/")
	if rel == "" {
		return false
	}
	segments := strings.Split(rel, "/")
	for _, segment := range segments {
		if strings.HasPrefix(segment, stagingPrefix) {
			return true
		}
	}
	for _, item := range ignored {
		item = strings.Trim(item, "/")
		if item == "" {
			continue
		}
		if strings.Contains(item, "/") {
			if rel == item || strings.HasPrefix(rel, item+"/") {
				return true
			}
			continue
		}
		for _, segment := range segments {
			if segment == item {
				return true
			}
		}
	}
	return false
}

// isWatchableNode reports whether a node belongs in the change stream: regular
// files, directories and symlinks. Sockets, FIFOs and device nodes cannot be
// watched reliably (macOS rejects them with EOPNOTSUPP) and are ignored while
// present; an unknown disappearance is reported conservatively as a delete.
func isWatchableNode(mode os.FileMode) bool {
	return mode.IsRegular() || mode.IsDir() || mode&os.ModeSymlink != 0
}

// nodeTypeFor classifies a watchable node, mirroring the wire protocol's
// nodeType values.
func nodeTypeFor(info os.FileInfo) string {
	switch {
	case info.IsDir():
		return "dir"
	case info.Mode()&os.ModeSymlink != 0:
		return "unknown"
	default:
		return "file"
	}
}
