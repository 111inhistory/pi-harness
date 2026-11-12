//go:build !windows

package asyncshell

import (
	"os"
	"os/signal"
	"syscall"
)

// signalFor maps a Node signal name to its POSIX signal.
func signalFor(name string) os.Signal {
	switch name {
	case "SIGKILL":
		return syscall.SIGKILL
	case "SIGHUP":
		return syscall.SIGHUP
	case "SIGINT":
		return syscall.SIGINT
	default:
		return syscall.SIGTERM
	}
}

// detachedSysProcAttr starts the monitor in its own session.
func detachedSysProcAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }

// exitSignal is the terminating signal reported by ProcessState, if any.
func exitSignal(state *os.ProcessState) *string {
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		name := status.Signal().String()
		return &name
	}
	return nil
}

// ProcessKill is process.kill(pid, signal); "" is the 0 liveness probe.
func ProcessKill(pid int, signal string) error {
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
		return coded(err, "ESRCH")
	}
	return nil
}

// ProcessOnSignal is process.on(signal, handler).
func ProcessOnSignal(name string, handler func(signal string)) {
	channel := make(chan os.Signal, 1)
	var target os.Signal
	switch name {
	case "SIGHUP":
		target = syscall.SIGHUP
	case "SIGINT":
		target = syscall.SIGINT
	default:
		target = syscall.SIGTERM
	}
	signal.Notify(channel, target)
	go func() {
		for range channel {
			handler(name)
		}
	}()
}
