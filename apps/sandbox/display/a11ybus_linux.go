//go:build linux && !android

package display

import (
	"bufio"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

var a11yBusConfig = "/usr/share/defaults/at-spi2/accessibility.conf"

func startA11yBus(display string, logger *slog.Logger) (string, func(), error) {
	daemon, err := exec.LookPath("dbus-daemon")
	if err != nil {
		return "", nil, err
	}
	if _, err := os.Stat(a11yBusConfig); err != nil {
		return "", nil, err
	}
	// The registry the bus starts finds its bus by AT_SPI_BUS_ADDRESS, so
	// the address is chosen before the bus starts.
	dir, err := os.MkdirTemp("", "cohub-a11y-")
	if err != nil {
		return "", nil, err
	}
	socket := filepath.Join(dir, "bus")
	cmd := exec.Command(daemon, "--config-file="+a11yBusConfig, "--address=unix:path="+socket, "--nofork", "--print-address=1")
	cmd.Env = append(os.Environ(), "DISPLAY="+display, "AT_SPI_BUS_ADDRESS=unix:path="+socket)
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM}
	stdout, err := cmd.StdoutPipe()
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		_ = os.RemoveAll(dir)
		return "", nil, err
	}
	stop := func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		_ = os.RemoveAll(dir)
	}
	address := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(stdout).ReadString('\n')
		address <- strings.TrimSpace(line)
	}()
	select {
	case got := <-address:
		if got == "" {
			stop()
			return "", nil, fmt.Errorf("dbus-daemon printed no address")
		}
		logger.Info("accessibility bus started", slog.String("display", display))
		return got, stop, nil
	case <-time.After(5 * time.Second):
		stop()
		return "", nil, fmt.Errorf("dbus-daemon did not start")
	}
}

func exportEnv(vars map[string]string) func() {
	type saved struct {
		value string
		had   bool
	}
	previous := map[string]saved{}
	for key, value := range vars {
		old, had := os.LookupEnv(key)
		previous[key] = saved{old, had}
		_ = os.Setenv(key, value)
	}
	return func() {
		for key, value := range vars {
			if os.Getenv(key) != value {
				continue
			}
			if old := previous[key]; old.had {
				_ = os.Setenv(key, old.value)
			} else {
				_ = os.Unsetenv(key)
			}
		}
	}
}
