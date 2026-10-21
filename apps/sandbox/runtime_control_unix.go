//go:build !windows

package main

import (
	"io"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// The Runtime supervisor passes the control pipe as the fourth inherited descriptor.
// A JVM supervisor (Android) can only wire the standard streams, so it selects COHUB_RUNTIME_CONTROL_FD=2.
func openRuntimeControl() (io.WriteCloser, error) {
	fd := runtimeControlFD()
	// Children must not inherit the control pipe, or they keep it open after sandboxd exits.
	if fd > 2 {
		syscall.CloseOnExec(int(fd))
	}
	return os.NewFile(fd, "runtime-control"), nil
}

func runtimeControlFD() uintptr {
	if fd, err := strconv.Atoi(strings.TrimSpace(os.Getenv("COHUB_RUNTIME_CONTROL_FD"))); err == nil && fd >= 2 {
		return uintptr(fd)
	}
	return 3
}
