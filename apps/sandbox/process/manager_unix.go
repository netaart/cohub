//go:build !windows

package process

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"syscall"
	"time"
)

type processTree struct{}

func (processTree) release() error { return nil }

func envKey(key string) string {
	return key
}

func platformEnv(env []string) []string {
	return env
}

func shellCommand(ctx context.Context, command string) (*exec.Cmd, error) {
	return exec.CommandContext(ctx, commandShell(), "-c", command), nil
}

func processTreeAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

func attachProcessTree(*exec.Cmd) (processTree, error) {
	return processTree{}, nil
}

func (m *Manager) terminateTree(managed *ManagedProcess, reason string) error {
	proc := managed.Cmd.Process
	if proc == nil {
		return nil
	}

	pgid, err := syscall.Getpgid(proc.Pid)
	if err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return fmt.Errorf("getpgid: %w", err)
	}

	m.logger.Info("process:terminate",
		slog.String("processId", managed.ID),
		slog.String("ownerIdentity", managed.OwnerIdentity),
		slog.Int("pid", proc.Pid),
		slog.Int("pgid", pgid),
		slog.String("reason", reason),
	)

	if err := syscall.Kill(-pgid, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("sigterm process group %d: %w", pgid, err)
	}

	time.Sleep(processTerminationGrace)

	if err := syscall.Kill(-pgid, 0); err == nil {
		m.forceKilledTotal.Add(1)
		if err := syscall.Kill(-pgid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
			return fmt.Errorf("sigkill process group %d: %w", pgid, err)
		}
	}

	return nil
}
