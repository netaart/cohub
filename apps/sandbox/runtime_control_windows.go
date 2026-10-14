//go:build windows

package main

import (
	"errors"
	"io"
	"os"
	"strings"
)

// Node cannot pass extra stdio handles that Go can open on Windows, so the
// Runtime supervisor listens on a private named pipe and passes its name.
func openRuntimeControl() (io.WriteCloser, error) {
	name := strings.TrimSpace(os.Getenv("COHUB_RUNTIME_CONTROL_PIPE"))
	if !strings.HasPrefix(name, `\\.\pipe\`) {
		return nil, errors.New("COHUB_RUNTIME_CONTROL_PIPE must name a local named pipe")
	}
	return os.OpenFile(name, os.O_WRONLY, 0)
}
