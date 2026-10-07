//go:build linux && !android

package display

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"syscall"
	"time"
)

const defaultXvfbSize = "1280x800"

var xvfbSizePattern = regexp.MustCompile(`^\d{3,4}x\d{3,4}$`)

func platformDialer(spec string, logger *slog.Logger) (Dialer, error) {
	kind, arg, _ := strings.Cut(spec, ":")
	switch kind {
	case "auto":
		if os.Getenv("WAYLAND_DISPLAY") != "" && os.Getenv("DISPLAY") == "" {
			return nil, fmt.Errorf("Wayland sessions are not supported yet; log in with an X11 session")
		}
		if os.Getenv("DISPLAY") == "" {
			return nil, fmt.Errorf("no X11 display: DISPLAY is not set")
		}
		return x11Dialer("", hostName(), logger), nil
	case "x11":
		return x11Dialer(arg, hostName(), logger), nil
	case "xvfb":
		size := arg
		if size == "" {
			size = defaultXvfbSize
		}
		if !xvfbSizePattern.MatchString(size) {
			return nil, fmt.Errorf("xvfb size must be WIDTHxHEIGHT, got %q", size)
		}
		server := &xvfb{size: size, logger: logger}
		if err := server.ensure(); err != nil {
			return nil, err
		}
		_ = os.Setenv("DISPLAY", server.display)
		return screenDialer("xvfb", func() (Screen, error) {
			if err := server.ensure(); err != nil {
				return nil, err
			}
			return openX11(server.display, "Virtual display")
		}, logger), nil
	default:
		return nil, fmt.Errorf("unknown display spec %q", spec)
	}
}

func x11Dialer(display, name string, logger *slog.Logger) Dialer {
	return screenDialer("x11", func() (Screen, error) { return openX11(display, name) }, logger)
}

type xvfb struct {
	size    string
	logger  *slog.Logger
	display string
	exited  chan struct{}
}

func (x *xvfb) ensure() error {
	if x.exited != nil {
		select {
		case <-x.exited:
		default:
			return nil
		}
	}
	binary, err := exec.LookPath("Xvfb")
	if err != nil {
		return fmt.Errorf("Xvfb is not installed")
	}
	if x.display == "" {
		number := 99
		for ; number < 199 && (fileExists(xSocket(number)) || fileExists(xLock(number))); number++ {
		}
		x.display = fmt.Sprintf(":%d", number)
	} else {
		_ = os.Remove(xSocket(strings.TrimPrefix(x.display, ":")))
	}
	cmd := exec.Command(binary, x.display, "-screen", "0", x.size+"x24", "-nolisten", "tcp", "-dpi", "96")
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start Xvfb: %w", err)
	}
	exited := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(exited)
	}()
	socket := xSocket(strings.TrimPrefix(x.display, ":"))
	deadline := time.After(10 * time.Second)
	for !fileExists(socket) {
		select {
		case <-exited:
			return fmt.Errorf("Xvfb exited on %s", x.display)
		case <-deadline:
			_ = cmd.Process.Kill()
			return fmt.Errorf("Xvfb did not start on %s", x.display)
		case <-time.After(50 * time.Millisecond):
		}
	}
	x.exited = exited
	x.logger.Info("virtual display started", slog.String("display", x.display), slog.String("size", x.size))
	return nil
}

func xSocket[T int | string](number T) string {
	return fmt.Sprintf("/tmp/.X11-unix/X%v", number)
}

func xLock(number int) string {
	return fmt.Sprintf("/tmp/.X%d-lock", number)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
