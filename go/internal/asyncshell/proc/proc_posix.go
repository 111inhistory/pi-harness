//go:build !windows

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
)

// proc_posix.go: process control primitives for POSIX.

func Kill(pid int, signal string) error {
	number := syscall.Signal(0)
	switch signal {
	case "":
		number = 0
	case "SIGKILL":
		number = syscall.SIGKILL
	case "SIGHUP":
		number = syscall.SIGHUP
	case "SIGINT":
		number = syscall.SIGINT
	default:
		number = syscall.SIGTERM
	}
	if err := syscall.Kill(pid, number); err != nil {
		return aserr.Coded(err, "ESRCH")
	}
	return nil
}

func TerminateSignal() os.Signal { return syscall.SIGTERM }

func InstallStopHandlers(handler func(signal string)) {
	channel := make(chan os.Signal, 1)
	signal.Notify(channel, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGINT)
	go func() {
		for received := range channel {
			name := "SIGTERM"
			switch received {
			case syscall.SIGHUP:
				name = "SIGHUP"
			case syscall.SIGINT:
				name = "SIGINT"
			}
			handler(name)
		}
	}()
}

func applyDetached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

func ApplyVerbatim(cmd *exec.Cmd, file string, args []string) {}

func applyHidden(cmd *exec.Cmd) {}

func DescribeExit(state *os.ProcessState) (*int, *string) {
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		name := status.Signal().String()
		return nil, &name
	}
	code := state.ExitCode()
	if code >= 0 {
		return &code, nil
	}
	return nil, nil
}

// OwnsCommandWithin proves pid's command line carries both the marker and the
// task directory. An absent pid is false; an unreadable one is an inspection
// failure, never an ownership grant.
func OwnsCommandWithin(pid int, marker string, dir string, timeoutMs int) bool {
	if timeoutMs <= 0 {
		panic(aserr.New("process_inspection_failed", "No time remains to inspect pid "+strconv.Itoa(pid)+"."))
	}
	timeout := timeoutMs
	probe := Run("ps", []string{"-o", "command=", "-p", strconv.Itoa(pid)}, Options{TimeoutMs: &timeout})
	if probe.Error != nil {
		panic(aserr.New("process_inspection_failed", "Could not inspect pid "+strconv.Itoa(pid)+": "+probe.Error.Error()))
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
		panic(aserr.New("process_inspection_failed", "Could not inspect pid "+strconv.Itoa(pid)+": ps exited "+statusText+" "+strings.TrimSpace(probe.Stderr)))
	}
	if command == "" {
		panic(aserr.New("process_inspection_failed", "Could not read the command line of pid "+strconv.Itoa(pid)+"."))
	}
	return strings.Contains(command, marker) && strings.Contains(command, dir)
}

func OwnsCommand(pid int, marker string, dir string) bool {
	return OwnsCommandWithin(pid, marker, dir, 5_000)
}

// MonitorExited reports whether this create process's detached monitor has
// exited. Wait4 reaps it when it is our child, so a killed monitor does not
// linger as a zombie and stall a foreground wait.
func MonitorExited(pid int) bool {
	if pid <= 0 {
		return true
	}
	for {
		var status syscall.WaitStatus
		reaped, err := syscall.Wait4(pid, &status, syscall.WNOHANG, nil)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if err == nil {
			return reaped == pid
		}
		return syscall.Kill(pid, 0) != nil
	}
}

// ReapDetached reaps a detached child that was started with Release, so it
// never lingers as a zombie in its process group while this process is alive.
// It does not wait before returning; another reaper (init) takes over after
// this process exits.
func ReapDetached(pid int) {
	if pid <= 0 {
		return
	}
	go func() {
		for {
			var status syscall.WaitStatus
			if _, err := syscall.Wait4(pid, &status, 0, nil); !errors.Is(err, syscall.EINTR) {
				return
			}
		}
	}()
}
