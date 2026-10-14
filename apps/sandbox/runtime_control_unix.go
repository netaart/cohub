//go:build !windows

package main

import (
	"io"
	"os"
	"strconv"
	"strings"
)

// The Runtime supervisor passes the control pipe as the fourth inherited descriptor.
// A JVM supervisor (Android) can only wire the standard streams, so it selects COHUB_RUNTIME_CONTROL_FD=2.
func openRuntimeControl() (io.WriteCloser, error) {
	return os.NewFile(runtimeControlFD(), "runtime-control"), nil
}

func runtimeControlFD() uintptr {
	if fd, err := strconv.Atoi(strings.TrimSpace(os.Getenv("COHUB_RUNTIME_CONTROL_FD"))); err == nil && fd >= 2 {
		return uintptr(fd)
	}
	return 3
}
