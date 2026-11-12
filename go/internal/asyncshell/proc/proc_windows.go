//go:build windows

package proc

import (
	"os"
	"os/exec"
	"os/signal"
	"pijob/internal/asyncshell/aserr"
	"strings"
	"syscall"
)

// proc_windows.go: process control primitives for Windows.

func Kill(pid int, signal string) error {
	process, err := os.FindProcess(pid)
	if err != nil {
		return aserr.Coded(err, "ESRCH")
	}
	if signal == "" {
		return nil
	}
	if err := process.Kill(); err != nil {
		return aserr.Coded(err, "ESRCH")
	}
	return nil
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
