package process

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/google/uuid"
)

var envKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

var blockedInheritedEnvKeys = map[string]struct{}{
	"SANDBOX_REPORT_TOKEN":  {},
	"INTERNAL_API_BASE_URL": {},
	"POD_IP":                {},
	// Local mode: the user's access token must never leak into agent-started
	// processes (main.go also unsets it from the environment after reading).
	"COHUB_RELAY_TOKEN": {},
}

func sanitizeInheritedEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, e := range env {
		key, _, _ := strings.Cut(e, "=")
		if _, blocked := blockedInheritedEnvKeys[key]; blocked {
			continue
		}
		out = append(out, e)
	}
	return out
}

type ManagedProcess struct {
	ID            string
	OwnerIdentity string
	Cmd           *exec.Cmd
	Cancel        context.CancelFunc

	mu            sync.Mutex
	terminating   bool
	stopReason    string
	stopRequested bool
}

type ExitInfo struct {
	ExitCode        *int
	Reason          string
	TimeoutSecs     int
	OutputTruncated bool
}

const (
	processTerminationGrace = 2 * time.Second
	processWaitDelay        = processTerminationGrace + time.Second
)

type Stats struct {
	ActiveProcesses        int   `json:"activeProcesses"`
	StartedTotal           int64 `json:"startedTotal"`
	CompletedTotal         int64 `json:"completedTotal"`
	AbortedTotal           int64 `json:"abortedTotal"`
	TimedOutTotal          int64 `json:"timedOutTotal"`
	IdentityCleanupTotal   int64 `json:"identityCleanupTotal"`
	ForceKilledTotal       int64 `json:"forceKilledTotal"`
	TerminateFailuresTotal int64 `json:"terminateFailuresTotal"`
}

type Manager struct {
	mu        sync.Mutex
	processes map[string]*ManagedProcess
	logger    *slog.Logger

	startedTotal           atomic.Int64
	completedTotal         atomic.Int64
	abortedTotal           atomic.Int64
	timedOutTotal          atomic.Int64
	identityCleanupTotal   atomic.Int64
	forceKilledTotal       atomic.Int64
	terminateFailuresTotal atomic.Int64
}

func NewManager(logger *slog.Logger) *Manager {
	return &Manager{
		processes: make(map[string]*ManagedProcess),
		logger:    logger,
	}
}

type StartOptions struct {
	Command     string
	Argv        []string
	CWD         string
	TimeoutSecs int
	Env         map[string]string
}

func (m *Manager) Start(ownerIdentity string, command string, cwd string, timeoutSecs int, extraEnv map[string]string) (string, io.ReadCloser, io.ReadCloser, <-chan ExitInfo, error) {
	return m.StartWithOptions(ownerIdentity, StartOptions{Command: command, CWD: cwd, TimeoutSecs: timeoutSecs, Env: extraEnv})
}

func (m *Manager) StartWithOptions(ownerIdentity string, options StartOptions) (string, io.ReadCloser, io.ReadCloser, <-chan ExitInfo, error) {
	ctx := context.Background()
	var cancel context.CancelFunc
	if options.TimeoutSecs > 0 {
		ctx, cancel = context.WithTimeout(ctx, time.Duration(options.TimeoutSecs)*time.Second)
	} else {
		ctx, cancel = context.WithCancel(ctx)
	}

	var started bool
	defer func() {
		if !started {
			cancel()
		}
	}()

	var cmd *exec.Cmd
	if len(options.Argv) > 0 {
		cmd = exec.CommandContext(ctx, options.Argv[0], options.Argv[1:]...)
	} else {
		cmd = exec.CommandContext(ctx, commandShell(), "-c", options.Command)
	}
	// Context cancellation is handled below by terminating the whole process
	// group. Keep exec's cancellation hook from killing only the leader first.
	cmd.Cancel = func() error { return nil }
	cmd.Dir = options.CWD
	// The process may exit while a background descendant still owns an output
	// descriptor. Bound the post-exit drain so inherited descriptors cannot
	// keep the RPC pending forever; the descendant itself remains untouched
	// unless the process is explicitly aborted or times out.
	cmd.WaitDelay = processWaitDelay
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	inheritedEnv := sanitizeInheritedEnv(os.Environ())
	// User-provided env vars are appended only if the key doesn't already
	// exist in the sanitized pod environment. This prevents users from accidentally
	// overriding critical system vars (PATH, HOME, LANG, etc.) and is
	// consistent with the SYSTEM_ENV_KEYS allowlist at the API layer.
	if len(options.Env) > 0 {
		existingKeys := make(map[string]bool)
		for _, e := range inheritedEnv {
			key, _, _ := strings.Cut(e, "=")
			existingKeys[key] = true
		}
		var merged []string
		for key, value := range options.Env {
			if key == "" || existingKeys[key] {
				continue
			}
			if !envKeyPattern.MatchString(key) {
				m.logger.Warn("process: ignoring env with invalid key",
					slog.String("key", key),
					slog.String("ownerIdentity", ownerIdentity),
				)
				continue
			}
			merged = append(merged, fmt.Sprintf("%s=%s", key, value))
		}
		cmd.Env = append(inheritedEnv, merged...)
	} else {
		cmd.Env = inheritedEnv
	}

	// io.Pipe (instead of StdoutPipe/StderrPipe) keeps output consumption
	// under our control: Wait closes the StdoutPipe read end as soon as the
	// child exits, which races with outstanding readers and can silently
	// discard buffered output. With io.Pipe, exec's copiers are the only
	// writers and writes are synchronous, so no delivered byte is ever lost.
	stdoutReader, stdoutWriter := io.Pipe()
	stderrReader, stderrWriter := io.Pipe()
	cmd.Stdout = stdoutWriter
	cmd.Stderr = stderrWriter
	defer func() {
		if !started {
			_ = stdoutWriter.Close()
			_ = stderrWriter.Close()
			_ = stdoutReader.Close()
			_ = stderrReader.Close()
		}
	}()

	if err := cmd.Start(); err != nil {
		return "", nil, nil, nil, fmt.Errorf("start command: %w", err)
	}
	started = true

	m.startedTotal.Add(1)
	processID := uuid.NewString()
	managed := &ManagedProcess{ID: processID, OwnerIdentity: ownerIdentity, Cmd: cmd, Cancel: cancel}

	m.mu.Lock()
	m.processes[processID] = managed
	m.mu.Unlock()

	go func() {
		<-ctx.Done()
		reason, requested := managed.stopState()
		if !requested {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				reason = "timeout"
				requested = managed.requestStop(reason)
			} else {
				return
			}
		}
		if !requested {
			return
		}
		if err := m.terminateProcessGroup(managed, reason); err != nil {
			m.terminateFailuresTotal.Add(1)
			m.logger.Warn("process:terminate failed",
				slog.String("processId", processID),
				slog.String("ownerIdentity", ownerIdentity),
				slog.String("reason", reason),
				slog.String("error", err.Error()),
			)
		}
	}()

	// cmd.Stdout/cmd.Stderr are io.Pipe writers. exec pumps child output
	// through them with copier goroutines whose lifetime is bounded by Wait,
	// so once Wait returns no further writes happen; closing the writers here
	// unblocks our readers. The synchronous pipes preserve every chunk that
	// reaches the copiers, while WaitDelay bounds inherited descriptors.
	var outputTruncated bool
	exitCh := make(chan ExitInfo, 1)
	go func() {
		defer close(exitCh)
		err := cmd.Wait()
		_ = stdoutWriter.Close()
		_ = stderrWriter.Close()
		var exitCode *int
		if cmd.ProcessState != nil {
			code := cmd.ProcessState.ExitCode()
			exitCode = &code
		}
		if err != nil {
			var exitErr *exec.ExitError
			if errors.Is(err, exec.ErrWaitDelay) {
				outputTruncated = true
			} else if !errors.As(err, &exitErr) {
				m.logger.Warn("process:wait failed",
					slog.String("processId", processID),
					slog.String("ownerIdentity", ownerIdentity),
					slog.String("error", err.Error()),
				)
			}
		}

		m.mu.Lock()
		delete(m.processes, processID)
		m.mu.Unlock()
		m.completedTotal.Add(1)
		cancel()
		reason, stopped := managed.stopState()
		if !stopped || reason == "" {
			reason = "exited"
		}
		exitCh <- ExitInfo{ExitCode: exitCode, Reason: reason, TimeoutSecs: options.TimeoutSecs, OutputTruncated: outputTruncated}
	}()

	return processID, stdoutReader, stderrReader, exitCh, nil
}

func (m *Manager) Abort(processID string) error {
	m.mu.Lock()
	managed, ok := m.processes[processID]
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("process not found")
	}
	if !managed.requestStop("abort") {
		return nil
	}
	managed.Cancel()
	return nil
}

func (m *Manager) AbortByIdentity(identity string) {
	m.mu.Lock()
	processes := make([]*ManagedProcess, 0)
	for _, managed := range m.processes {
		if managed.OwnerIdentity == identity {
			processes = append(processes, managed)
		}
	}
	m.mu.Unlock()

	for _, managed := range processes {
		if !managed.requestStop("identity_disconnect") {
			continue
		}
		managed.Cancel()
	}
}

func (m *Manager) Stats() Stats {
	m.mu.Lock()
	active := len(m.processes)
	m.mu.Unlock()
	return Stats{
		ActiveProcesses:        active,
		StartedTotal:           m.startedTotal.Load(),
		CompletedTotal:         m.completedTotal.Load(),
		AbortedTotal:           m.abortedTotal.Load(),
		TimedOutTotal:          m.timedOutTotal.Load(),
		IdentityCleanupTotal:   m.identityCleanupTotal.Load(),
		ForceKilledTotal:       m.forceKilledTotal.Load(),
		TerminateFailuresTotal: m.terminateFailuresTotal.Load(),
	}
}

func (m *Manager) terminateProcessGroup(managed *ManagedProcess, reason string) error {
	managed.mu.Lock()
	if managed.terminating {
		managed.mu.Unlock()
		return nil
	}
	managed.terminating = true
	managed.mu.Unlock()

	switch reason {
	case "timeout":
		m.timedOutTotal.Add(1)
	case "identity_disconnect":
		m.identityCleanupTotal.Add(1)
	default:
		m.abortedTotal.Add(1)
	}

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

func (p *ManagedProcess) requestStop(reason string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stopRequested {
		return false
	}
	p.stopRequested = true
	p.stopReason = reason
	return true
}

func (p *ManagedProcess) stopState() (reason string, requested bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.stopReason, p.stopRequested
}
