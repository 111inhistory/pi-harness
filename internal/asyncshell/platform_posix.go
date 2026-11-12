//go:build !windows

package asyncshell

import (
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
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

func (PosixBackend) Run(dir string, args []string, stdin *string) CommandResult {
	full := append([]string{"-S", socketOf(dir)}, args...)
	timeout := ControlTimeoutMs
	result := runCommand("tmux", full, commandOptions{TimeoutMs: &timeout, Input: stdin})
	if result.Error != nil {
		panic(NewAsyncShellError("tmux_unavailable", describePosix(result.Error)))
	}
	return CommandResult{Code: result.Code, Stdout: result.Stdout, Stderr: result.Stderr}
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
		panic(NewAsyncShellError(code, "tmux "+first+" failed: "+detail))
	}
	return result
}

func (PosixBackend) AssertAvailable() {
	if runtime.GOOS == "win32" {
		panic(NewAsyncShellError("unsupported_platform", "The POSIX tmux backend is not available on Windows."))
	}
	timeout := ControlTimeoutMs
	probe := runCommand("tmux", []string{"-V"}, commandOptions{TimeoutMs: &timeout})
	if probe.Error != nil || probe.Code == nil || *probe.Code != 0 {
		panic(NewAsyncShellError("tmux_unavailable", "tmux is required for async shell tasks and was not found."))
	}
}

func (PosixBackend) KillServer(dir string) {
	PosixBackend{}.Run(dir, []string{"kill-server"}, nil)
}

func (PosixBackend) ServerRunning(dir string) bool {
	result := PosixBackend{}.Run(dir, []string{"list-sessions"}, nil)
	return result.Code != nil && *result.Code == 0
}

func (PosixBackend) Start(dir string, selfArgv []string, rawPath string) {
	quoted := make([]string, 0, len(selfArgv))
	for _, value := range selfArgv {
		quoted = append(quoted, shellQuote(value))
	}
	PosixBackend{}.RunOk(dir, []string{"new-session", "-d", "-s", Session, "-x", "200", "-y", "50", strings.Join(quoted, " ")}, "session_failed", nil)
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

func (PosixBackend) OwnsProcess(pid int, marker string, dir string) bool {
	timeout := ControlTimeoutMs
	probe := runCommand("ps", []string{"-o", "command=", "-p", strconv.Itoa(pid)}, commandOptions{TimeoutMs: &timeout})
	if probe.Error != nil {
		panic(NewAsyncShellError("process_inspection_failed", "Could not inspect pid "+strconv.Itoa(pid)+": "+describePosix(probe.Error)))
	}
	command := strings.TrimSpace(probe.Stdout)
	if probe.Code == nil || *probe.Code != 0 {
		// POSIX ps exits 1 with no output for a pid that does not exist.
		if probe.Code != nil && *probe.Code == 1 && command == "" && strings.TrimSpace(probe.Stderr) == "" {
			return false
		}
		statusText := "unknown"
		if probe.Code != nil {
			statusText = strconv.Itoa(*probe.Code)
		}
		panic(NewAsyncShellError("process_inspection_failed", "Could not inspect pid "+strconv.Itoa(pid)+": ps exited "+statusText+" "+strings.TrimSpace(probe.Stderr)))
	}
	if command == "" {
		panic(NewAsyncShellError("process_inspection_failed", "Could not read the command line of pid "+strconv.Itoa(pid)+"."))
	}
	return strings.Contains(command, marker) && strings.Contains(command, dir)
}

func codeOrUnknown(code *int) string {
	if code == nil {
		return "unknown"
	}
	return strconv.Itoa(*code)
}

// defaultBackend is tmux.ts's `backend` selection for POSIX builds.
func defaultBackend() ShellBackend { return PosixBackend{} }
