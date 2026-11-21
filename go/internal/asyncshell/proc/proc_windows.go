//go:build windows

package proc

import (
	"errors"
	"os"
	"os/exec"
	"os/signal"
	"pijob/internal/asyncshell/aserr"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// proc_windows.go: process control primitives for Windows.

// stillActive is STILL_ACTIVE: GetExitCodeProcess reports it while a process runs.
const stillActive = 259

// Kill stops one process. An empty signal is the liveness probe. Both paths open
// one handle and close it before returning: a retained handle would keep a dead
// process object addressable, so a later probe would answer for the process that
// already exited, and an exited process is never reported as running even while
// another handle keeps its object alive.
func Kill(pid int, signal string) error {
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return codedProcessError(err)
	}
	defer windows.CloseHandle(handle)
	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return codedProcessError(err)
	}
	if code != stillActive {
		return aserr.New("ESRCH", "process "+strconv.Itoa(pid)+" has exited")
	}
	if signal == "" {
		return nil
	}
	if err := windows.TerminateProcess(handle, 1); err != nil {
		return codedProcessError(err)
	}
	return nil
}

// codedProcessError keeps an unreadable process alive for the caller: only a
// failed lookup is proof that no such process exists.
func codedProcessError(err error) error {
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return aserr.Coded(err, "EPERM")
	}
	return aserr.Coded(err, "ESRCH")
}

func TerminateSignal() os.Signal { return os.Kill }

func InstallStopHandlers(handler func(signal string)) {
	channel := make(chan os.Signal, 1)
	signal.Notify(channel, os.Interrupt)
	go func() {
		for range channel {
			handler("SIGINT")
		}
	}()
}

func applyDetached(cmd *exec.Cmd) {
	// Node's detached spawn uses DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP.
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200}
}

func ApplyVerbatim(cmd *exec.Cmd, file string, args []string) {
	attr := ensureSysProcAttr(cmd)
	attr.CmdLine = strings.Join(append([]string{file}, args...), " ")
}

func applyHidden(cmd *exec.Cmd) {
	ensureSysProcAttr(cmd).HideWindow = true
}

func ensureSysProcAttr(cmd *exec.Cmd) *syscall.SysProcAttr {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	return cmd.SysProcAttr
}

func DescribeExit(state *os.ProcessState) (*int, *string) {
	code := state.ExitCode()
	if code >= 0 {
		return &code, nil
	}
	return nil, nil
}

// ownershipTimeoutMs bounds one CIM ownership query.
const ownershipTimeoutMs = 10_000

// shellForQueryWithin is TS shellForQuery: pwsh when present, else Windows PowerShell.
func shellForQueryWithin(timeoutMs int) []string {
	deadline := time.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
	for _, candidate := range []string{"pwsh", "powershell"} {
		remaining := int(time.Until(deadline).Milliseconds())
		if remaining <= 0 {
			break
		}
		timeout := remaining
		if timeout > 5000 {
			timeout = 5000
		}
		probe := Run(candidate, []string{"-NoProfile", "-NonInteractive", "-Command", "exit 0"}, Options{TimeoutMs: &timeout, Hide: true})
		if probe.Error == nil && probe.Code != nil && *probe.Code == 0 {
			return []string{candidate, "-NoProfile", "-NonInteractive", "-Command"}
		}
	}
	panic(aserr.New("process_inspection_failed",
		"Neither pwsh nor Windows PowerShell could be started to inspect process ownership; the task fence is kept."))
}

const ownershipScriptPrefix = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)"

// OwnsCommandWithin is the shared CIM command-line ownership probe.
func OwnsCommandWithin(pid int, marker string, dir string, timeoutMs int) bool {
	if timeoutMs <= 0 {
		panic(aserr.New("process_inspection_failed", "No time remains to inspect pid "+strconv.Itoa(pid)+"."))
	}
	deadline := time.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
	shell := shellForQueryWithin(timeoutMs)
	script := strings.Join([]string{
		ownershipScriptPrefix,
		`$p = Get-CimInstance Win32_Process -Filter "ProcessId=` + strconv.Itoa(pid) + `" -ErrorAction Stop`,
		`$answer = 'absent'`,
		`if ($p) { $answer = 'unreadable' }`,
		`if ($p -and -not [string]::IsNullOrEmpty($p.CommandLine)) { $answer = 'cmd:' + $p.CommandLine }`,
		"[Console]::Out.Write($answer)",
	}, "; ")
	args := append(append([]string{}, shell[1:]...), script)
	timeout := int(time.Until(deadline).Milliseconds())
	if timeout <= 0 {
		panic(aserr.New("process_inspection_failed", "No time remains to inspect pid "+strconv.Itoa(pid)+"."))
	}
	if timeout > ownershipTimeoutMs {
		timeout = ownershipTimeoutMs
	}
	probe := Run(shell[0], args, Options{TimeoutMs: &timeout, Hide: true})
	if probe.Error != nil {
		panic(aserr.New("process_inspection_failed", "Could not inspect pid "+strconv.Itoa(pid)+": "+probe.Error.Error()))
	}
	if probe.Code == nil || *probe.Code != 0 {
		statusText := "unknown"
		if probe.Code != nil {
			statusText = strconv.Itoa(*probe.Code)
		}
		panic(aserr.New("process_inspection_failed", "Could not inspect pid "+strconv.Itoa(pid)+": the process query exited "+statusText+" "+strings.TrimSpace(probe.Stderr)))
	}
	answer := strings.TrimSpace(probe.Stdout)
	if answer == "absent" {
		return false
	}
	if !strings.HasPrefix(answer, "cmd:") {
		panic(aserr.New("process_inspection_failed", "Could not read the command line of pid "+strconv.Itoa(pid)+"."))
	}
	command := strings.TrimPrefix(answer, "cmd:")
	return strings.Contains(command, marker) && strings.Contains(command, dir)
}

func OwnsCommand(pid int, marker string, dir string) bool {
	return OwnsCommandWithin(pid, marker, dir, 5_000)
}

// MonitorExited reports whether the monitor process is gone. A released handle
// makes TerminateProcess fail for an exited process.
func MonitorExited(pid int) bool {
	if pid <= 0 {
		return true
	}
	return Kill(pid, "") != nil
}

// ReapDetached is a no-op: Windows has no zombie process group member.
func ReapDetached(pid int) { _ = pid }
