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
	"sync"
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
		dial, _, err := startVirtual(arg, logger)
		return dial, err
	default:
		return nil, fmt.Errorf("unknown display spec %q", spec)
	}
}

func x11Dialer(display, name string, logger *slog.Logger) Dialer {
	return screenDialer("x11", func() (Screen, error) { return openX11(display, name) }, logger)
}

// virtualAvailable offers virtual screens to headless machines only, so a
// desktop session keeps its DISPLAY.
func virtualAvailable() bool {
	_, err := exec.LookPath("Xvfb")
	return err == nil && os.Getenv("DISPLAY") == ""
}

func startVirtual(size string, logger *slog.Logger) (Dialer, func(), error) {
	if size == "" {
		size = defaultXvfbSize
	}
	if !xvfbSizePattern.MatchString(size) {
		return nil, nil, errorf(CodeInvalid, "virtual screen size must be WIDTHxHEIGHT, got %q", size)
	}
	server := &xvfb{size: size, logger: logger}
	if err := server.ensure(); err != nil {
		return nil, nil, errorf(CodeUnavailable, "%v", err)
	}
	previous, had := os.LookupEnv("DISPLAY")
	_ = os.Setenv("DISPLAY", server.display)
	dial := screenDialer("xvfb", func() (Screen, error) {
		if err := server.ensure(); err != nil {
			return nil, err
		}
		return openX11(server.display, "Virtual display")
	}, logger)
	stop := func() {
		server.stop()
		if os.Getenv("DISPLAY") != server.display {
			return
		}
		if had {
			_ = os.Setenv("DISPLAY", previous)
		} else {
			_ = os.Unsetenv("DISPLAY")
		}
	}
	return dial, stop, nil
}

type xvfb struct {
	size    string
	logger  *slog.Logger
	mu      sync.Mutex
	display string
	cmd     *exec.Cmd
	exited  chan struct{}
	stopped bool
}

func (x *xvfb) stop() {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.stopped = true
	if x.cmd != nil {
		_ = x.cmd.Process.Kill()
		<-x.exited
		x.logger.Info("virtual display stopped", slog.String("display", x.display))
	}
}

func (x *xvfb) ensure() error {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.stopped {
		return fmt.Errorf("the virtual display was stopped")
	}
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
	x.cmd, x.exited = cmd, exited
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
