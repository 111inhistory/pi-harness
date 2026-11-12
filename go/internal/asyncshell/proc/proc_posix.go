//go:build !windows

package proc

import (
	"os"
	"os/exec"
	"os/signal"
	"pijob/internal/asyncshell/aserr"
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
