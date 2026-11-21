//go:build !windows

package asyncshell

import (
	"errors"
	"os"
	"syscall"

	"pijob/internal/asyncshell/aserr"
	"pijob/internal/asyncshell/proc"
)

const (
	pipeTermWaitMs         = 2_000
	pipeKillWaitMs         = 2_000
	pipeOwnershipTimeoutMs = 5_000
)

// pipeSupported reports that this platform has a proven process-tree stop path.
func pipeSupported() bool { return true }

// startPipeTask launches the detached runner with stdout and stderr already bound
// to raw.log. The runner's session is its own process group, which is the unit
// later verified and terminated; no separate handoff is needed because the group
// exists exactly as long as the runner does.
func startPipeTask(_ string, _ string, paths TaskPaths, selfArgv []string) (pipeStart, error) {
	if len(selfArgv) == 0 {
		return pipeStart{}, aserr.New("start_failed", "The pipe runner has no executable.")
	}
	output, err := os.OpenFile(paths.Raw, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return pipeStart{}, err
	}
	defer output.Close()
	pid, err := proc.StartDetachedOutput(selfArgv[0], selfArgv[1:], nil, output)
	if err != nil || pid == nil {
		if err == nil {
			err = aserr.New("start_failed", "The pipe runner did not start.")
		}
		return pipeStart{}, err
	}
	return pipeStart{Pid: *pid}, nil
}

// supervisePipeRunner needs nothing on POSIX: the runner's own process group is
// created with it, so the runner already owns the fence its command runs in.
func supervisePipeRunner(string, string, TaskPaths) (func(), error) { return func() {}, nil }

// awaitMonitorHandoff needs nothing on POSIX: the process group is not killed
// when a handle closes, so no supervisor has to hold one.
func awaitMonitorHandoff(TaskPaths) error { return nil }

// pipeSupervise gives the monitor the process-group liveness it drains against.
func pipeSupervise(paths TaskPaths) (alive func() bool, release func()) {
	return func() bool { return pipeTreeAlive(paths) }, func() {}
}

// pipeTreeGone is true only for an explicit ESRCH for the recorded process
// group. EPERM and other failures are not proof of exit.
func pipeTreeGone(record *ownershipRecord) bool {
	pid := record.RunnerPid
	if pid <= 0 {
		return true
	}
	err := syscall.Kill(-pid, 0)
	if err == nil {
		return false
	}
	return errors.Is(err, syscall.ESRCH)
}

// waitPipeTreeGone polls the process group without resetting its deadline.
func waitPipeTreeGone(record *ownershipRecord, timeoutMs int) bool {
	deadline := nowMs() + int64(timeoutMs)
	for nowMs() < deadline {
		if pipeTreeGone(record) {
			return true
		}
		sleep(25)
	}
	return pipeTreeGone(record)
}

func pipeTreeAlive(paths TaskPaths) bool {
	pid := readPid(paths.RunnerPid)
	if pid == nil {
		return !fileExists(paths.Exit)
	}
	return !pipeTreeGone(&ownershipRecord{RunnerPid: *pid})
}

// stopPipeTree terminates the runner's own process group after proving the
// leader is the runner recorded for this task dir. Both the TERM and the KILL
// stage are individually bounded and the KILL is re-authorized.
func stopPipeTree(_ string, dir string, record *ownershipRecord) error {
	pid := record.RunnerPid
	if pipeTreeGone(record) {
		return nil
	}
	if !alive(pid) {
		return aserr.New("process_unknown", "The task process group still has members after its runner exited; no unproven kill is attempted.")
	}
	if !pipeOwnsRunner(pid, dir) {
		return aserr.New("process_unknown", "The task runner ownership is not proven; no kill is attempted.")
	}
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	if waitPipeTreeGone(record, pipeTermWaitMs) {
		return nil
	}
	if !alive(pid) || !pipeOwnsRunner(pid, dir) {
		return aserr.New("process_unknown", "The task process tree did not exit and its ownership can no longer be proven.")
	}
	_ = syscall.Kill(-pid, syscall.SIGKILL)
	if waitPipeTreeGone(record, pipeKillWaitMs) {
		return nil
	}
	return aserr.New("process_unknown", "The task process tree did not exit after SIGKILL; the fence is retained.")
}

func pipeOwnsRunner(pid int, dir string) bool {
	owned := false
	if recovered := caught(func() {
		owned = proc.OwnsCommandWithin(pid, "__run", dir, pipeOwnershipTimeoutMs)
	}); recovered != nil {
		return false
	}
	return owned
}
