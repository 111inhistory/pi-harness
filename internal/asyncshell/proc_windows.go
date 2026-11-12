//go:build windows

package asyncshell

import (
	"os"
	"os/signal"
	"syscall"
)

// signalFor maps a Node signal name to the only signal Windows exposes.
func signalFor(name string) os.Signal { return os.Kill }

// detachedSysProcAttr starts the monitor detached (DETACHED_PROCESS).
func detachedSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: 0x00000008}
}

// exitSignal is not reported by the Windows ProcessState.
func exitSignal(state *os.ProcessState) *string { return nil }

// ProcessKill is process.kill(pid, signal); "" is the 0 liveness probe.
func ProcessKill(pid int, signal string) error {
	process, err := os.FindProcess(pid)
	if err != nil {
		return coded(err, "ESRCH")
	}
	if signal == "" {
		return nil
	}
	if err := process.Kill(); err != nil {
		return coded(err, "ESRCH")
	}
	return nil
}

// ProcessOnSignal is process.on(signal, handler); Windows only exposes interrupt.
func ProcessOnSignal(name string, handler func(signal string)) {
	channel := make(chan os.Signal, 1)
	signal.Notify(channel, os.Interrupt)
	go func() {
		for range channel {
			handler(name)
		}
	}()
}
