//go:build !windows

package backend

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"pijob/internal/asyncshell/aserr"
	"pijob/internal/asyncshell/proc"
)

// platform_posix.go translates src/async-shell/platform-posix.ts (+ the POSIX half
// of platform.ts). Control commands and process probes use os/exec.

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

func socketOf(dir string) string {
	return filepath.Join(dir, "tmux.sock")
}

func describePosix(err error) string {
	if err != nil {
		return err.Error()
	}
	return ""
}

// PosixBackend is the POSIX ShellBackend (TS: posixBackend object).
type PosixBackend struct{}

func (PosixBackend) Kind() string { return "posix" }

func (PosixBackend) runWithTimeout(dir string, args []string, timeoutMs int, stdin *string) CommandResult {
	full := append([]string{"-S", socketOf(dir)}, args...)
	timeout := timeoutMs
	result := proc.Run("tmux", full, proc.Options{TimeoutMs: &timeout, Input: stdin})
	if result.Error != nil {
		panic(aserr.New("tmux_unavailable", describePosix(result.Error)))
	}
	return CommandResult{Code: result.Code, Stdout: result.Stdout, Stderr: result.Stderr}
}

func (PosixBackend) Run(dir string, args []string, stdin *string) CommandResult {
	return PosixBackend{}.runWithTimeout(dir, args, ControlTimeoutMs, stdin)
}

func (PosixBackend) RunOk(dir string, args []string, code string, stdin *string) CommandResult {
	result := PosixBackend{}.Run(dir, args, stdin)
	if result.Code == nil || *result.Code != 0 {
		first := ""
		if len(args) > 0 {
			first = args[0]
		}
		detail := strings.TrimSpace(result.Stderr)
		if detail == "" {
			detail = "exit " + codeOrUnknown(result.Code)
		}
		panic(aserr.New(code, "tmux "+first+" failed: "+detail))
	}
	return result
}

func (PosixBackend) AssertAvailable() {
	timeout := ControlTimeoutMs
	probe := proc.Run("tmux", []string{"-V"}, proc.Options{TimeoutMs: &timeout})
	if probe.Error != nil || probe.Code == nil || *probe.Code != 0 {
		panic(aserr.New("tmux_unavailable", "tmux is required for async shell tasks and was not found."))
	}
}

func (PosixBackend) KillServerWithin(dir string, timeoutMs int) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = aserr.AsError(recovered)
		}
	}()
	result := PosixBackend{}.runWithTimeout(dir, []string{"kill-server"}, timeoutMs, nil)
	if result.Code == nil || *result.Code != 0 {
		return fmt.Errorf("tmux kill-server failed: %s", strings.TrimSpace(result.Stderr))
	}
	return nil
}

func (PosixBackend) KillServer(dir string) error {
	return PosixBackend{}.KillServerWithin(dir, ControlTimeoutMs)
}

// ServerState uses a Unix-socket connection, not a tmux command: a live server
// accepts it; ECONNREFUSED is only a suspect answer; ENOENT means the captured
// path is absent; timeouts and all other failures are unknown.
func (PosixBackend) ServerState(dir string, timeoutMs int) (ServerState, error) {
	if timeoutMs <= 0 {
		return ServerUnknown, nil
	}
	connection, err := net.DialTimeout("unix", socketOf(dir), time.Duration(timeoutMs)*time.Millisecond)
	if err == nil {
		_ = connection.Close()
		return ServerRunning, nil
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return ServerSuspect, nil
	}
	if errors.Is(err, syscall.ENOENT) {
		return ServerMissing, nil
	}
	return ServerUnknown, fmt.Errorf("cannot determine the terminal server state: %w", err)
}

func (PosixBackend) ServerPid(dir string) (int, error) {
	result := PosixBackend{}.runWithTimeout(dir, []string{"display-message", "-p", "#{pid}"}, ControlTimeoutMs, nil)
	if result.Code == nil || *result.Code != 0 {
		return 0, fmt.Errorf("tmux display-message failed: %s", strings.TrimSpace(result.Stderr))
	}
	pid, err := strconv.Atoi(strings.TrimSpace(result.Stdout))
	if err != nil || pid <= 0 {
		return 0, fmt.Errorf("tmux returned an invalid server pid: %q", strings.TrimSpace(result.Stdout))
	}
	return pid, nil
}

func (PosixBackend) Start(dir string, selfArgv []string, rawPath string, afterBind func() error) {
	quoted := make([]string, 0, len(selfArgv))
	for _, value := range selfArgv {
		quoted = append(quoted, shellQuote(value))
	}
	PosixBackend{}.RunOk(dir, []string{"new-session", "-d", "-s", Session, "-x", "200", "-y", "50", strings.Join(quoted, " ")}, "session_failed", nil)
	// Bind identity is captured while the server exists and before pipe-pane or
	// any monitor step can fail. A callback failure is an unknown ownership state.
	if err := afterBind(); err != nil {
		panic(err)
	}
	PosixBackend{}.RunOk(dir, []string{"pipe-pane", "-t", Session, "-o", "cat >> " + shellQuote(rawPath)}, "capture_failed", nil)
}

func (PosixBackend) SendInput(dir string, input string) {
	if input == "" {
		return
	}
	PasteLiteral(PosixBackend{}, dir, input, Session)
}

func (PosixBackend) SendKey(dir string, key string) {
	PosixBackend{}.RunOk(dir, []string{"send-keys", "-t", Session, key}, "send_failed", nil)
}

func (PosixBackend) PaneGone(dir string) bool {
	result := PosixBackend{}.Run(dir, []string{"display-message", "-p", "-t", Session, "#{pane_dead}"}, nil)
	return result.Code == nil || *result.Code != 0 || strings.TrimSpace(result.Stdout) != "0"
}

func (PosixBackend) OwnsProcessWithin(pid int, marker string, dir string, timeoutMs int) bool {
	return proc.OwnsCommandWithin(pid, marker, dir, timeoutMs)
}

func (PosixBackend) OwnsProcess(pid int, marker string, dir string) bool {
	return proc.OwnsCommand(pid, marker, dir)
}

func codeOrUnknown(code *int) string {
	if code == nil {
		return "unknown"
	}
	return strconv.Itoa(*code)
}

// Default is tmux.ts's `backend` selection for POSIX builds.
func Default() ShellBackend { return PosixBackend{} }

var _ = os.Getpid
