//go:build windows

package process

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procNtResumeProcess = windows.NewLazySystemDLL("ntdll.dll").NewProc("NtResumeProcess")

// processTree owns the Job Object that contains a command and its descendants.
// It mirrors the Unix process group: abort/timeout terminate the whole tree,
// while a normal exit releases the job so background descendants keep running.
type processTree = *jobTree

type jobTree struct {
	mu     sync.Mutex
	job    windows.Handle
	closed bool
}

// Windows environment names are case-insensitive: Path and PATH are the same variable.
func envKey(key string) string {
	return strings.ToUpper(key)
}

// Git Bash tools default to the ANSI code page without a locale; output is
// transported as UTF-8. Native Windows programs may still use their own code page.
func platformEnv(env []string) []string {
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		if envKey(key) == "LANG" || envKey(key) == "LC_ALL" {
			return env
		}
	}
	return append(env, "LANG=C.UTF-8")
}

// shellCommand runs commands through Git Bash. `bash` is never looked up on PATH:
// it commonly resolves to the WSL launcher, which has different filesystem semantics.
func shellCommand(ctx context.Context, command string) (*exec.Cmd, error) {
	bash, err := gitBashPath()
	if err != nil {
		return nil, err
	}
	return exec.CommandContext(ctx, bash, "-c", command), nil
}

func gitBashPath() (string, error) {
	if configured := os.Getenv("COHUB_BASH"); configured != "" {
		if !filepath.IsAbs(configured) || !isFile(configured) {
			return "", fmt.Errorf("COHUB_BASH must be an absolute path to bash.exe: %s", configured)
		}
		return configured, nil
	}
	var candidates []string
	if git, err := exec.LookPath("git"); err == nil {
		// git.exe lives in <Git>\cmd, <Git>\bin or <Git>\mingw64\bin.
		dir := filepath.Dir(git)
		candidates = append(candidates,
			filepath.Join(filepath.Dir(dir), "bin", "bash.exe"),
			filepath.Join(filepath.Dir(filepath.Dir(dir)), "bin", "bash.exe"),
		)
	}
	for _, root := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")} {
		if root != "" {
			candidates = append(candidates, filepath.Join(root, "Git", "bin", "bash.exe"))
		}
	}
	if local := os.Getenv("LOCALAPPDATA"); local != "" {
		candidates = append(candidates, filepath.Join(local, "Programs", "Git", "bin", "bash.exe"))
	}
	for _, candidate := range candidates {
		if isFile(candidate) {
			return candidate, nil
		}
	}
	return "", errors.New("Git Bash not found: install Git for Windows or set COHUB_BASH to bash.exe")
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// The child starts suspended so it cannot create descendants before joining the job.
func processTreeAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: windows.CREATE_SUSPENDED | windows.CREATE_NO_WINDOW}
}

func attachProcessTree(cmd *exec.Cmd) (processTree, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("create job object: %w", err)
	}
	// BREAKAWAY_OK mirrors Unix, where a command may setsid out of its process group;
	// without it, programs that ask for CREATE_BREAKAWAY_FROM_JOB fail to start.
	if err := setJobLimits(job, windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|windows.JOB_OBJECT_LIMIT_BREAKAWAY_OK); err != nil {
		_ = windows.CloseHandle(job)
		return nil, err
	}
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.PROCESS_SUSPEND_RESUME, false, uint32(cmd.Process.Pid))
	if err != nil {
		_ = windows.CloseHandle(job)
		return nil, fmt.Errorf("open process: %w", err)
	}
	defer windows.CloseHandle(process)
	if err := windows.AssignProcessToJobObject(job, process); err != nil {
		_ = windows.CloseHandle(job)
		return nil, fmt.Errorf("assign process to job object: %w", err)
	}
	if status, _, _ := procNtResumeProcess.Call(uintptr(process)); int32(status) < 0 {
		_ = windows.CloseHandle(job)
		return nil, fmt.Errorf("resume process: NTSTATUS 0x%x", status)
	}
	return &jobTree{job: job}, nil
}

func setJobLimits(job windows.Handle, flags uint32) error {
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = flags
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		return fmt.Errorf("configure job object: %w", err)
	}
	return nil
}

// release keeps descendants alive after the command exits, matching Unix where
// they stay in the process group untouched. A later terminate becomes a no-op.
// If kill-on-close cannot be cleared the handle is kept open rather than killing them.
func (t *jobTree) release() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil
	}
	t.closed = true
	if err := setJobLimits(t.job, windows.JOB_OBJECT_LIMIT_BREAKAWAY_OK); err != nil {
		return err
	}
	return windows.CloseHandle(t.job)
}

// Windows has no SIGTERM for console-less processes, so the tree is terminated directly.
func (m *Manager) terminateTree(managed *ManagedProcess, reason string) error {
	tree := managed.tree
	tree.mu.Lock()
	defer tree.mu.Unlock()
	if tree.closed {
		return nil
	}

	m.logger.Info("process:terminate",
		slog.String("processId", managed.ID),
		slog.String("ownerIdentity", managed.OwnerIdentity),
		slog.Int("pid", managed.Cmd.Process.Pid),
		slog.String("reason", reason),
	)

	// No graceful step exists to escalate from, so forceKilledTotal (SIGKILL after SIGTERM on Unix) is not counted.
	if err := windows.TerminateJobObject(tree.job, 1); err != nil {
		return fmt.Errorf("terminate job object: %w", err)
	}
	return nil
}
