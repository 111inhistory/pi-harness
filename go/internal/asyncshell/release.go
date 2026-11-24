package asyncshell

import (
	"path/filepath"
	"time"

	"pijob/internal/asyncshell/aserr"
	shellbackend "pijob/internal/asyncshell/backend"
)

// CancelControlTimeoutMs bounds one cancel-scoped backend control. Normal
// backend controls keep their larger timeout; the cancel total is the finite
// stage sum documented beside CancelBudgetMs.
const CancelControlTimeoutMs = 5_000

// PostKillWaitMs bounds the cumulative confirmation window after kill-server.
// POSIX probes a Unix socket in-process (2s); Windows spawns psmux.exe (5s).
const PostKillWaitMs = postKillWaitMs

// CancelBudgetMs is the static upper bound for cancel: startup gate <= 15s
// (mutually exclusive with a live monitor), monitor wait 15s, monitor
// ownership 5s, SIGKILL wait 2s, and release (POSIX PTY <= 13s; Windows PTY <=
// 20s including one 5s probe begun just before the 5s post-kill deadline; pipe
// <= 4s). All stages are individually bounded; there is no wall-clock watchdog
// or retry authority.
const CancelBudgetMs = 45_000

type processState int

const (
	processRunning processState = iota
	processExited
	processUnknown
)

func serverProcessState(pid int, dir string) (state processState) {
	defer func() {
		if recover() != nil {
			state = processUnknown
		}
	}()
	if pid <= 0 {
		return processUnknown
	}
	if !alive(pid) {
		return processExited
	}
	if !backend.OwnsProcessWithin(pid, "tmux", dir, CancelControlTimeoutMs) {
		return processUnknown
	}
	return processRunning
}

// releaseTaskBackend is the single terminal release path. It verifies persisted
// creation/bind identity before any kill or unlink, proves the backend stopped,
// removes only the recorded socket inode (PTY) or terminates only the recorded
// runner's process tree (pipe), and writes the cleaned sidecar fact last.
// Unknown always propagates: the caller must not write closed.
func releaseTaskBackend(dir string) error {
	root := StateRoot()
	record, err := verifyTaskOwnership(root, dir)
	if err != nil {
		return err
	}
	if record.Cleaned {
		// A pipe task owns no filesystem socket; idempotence is only the cleaned
		// fact. For PTY, a replacement entry is left in place and reported; only
		// a verified absent entry is idempotent.
		if record.Pipe {
			return nil
		}
		if socketEntryExists(dir) {
			return aserr.New("socket_unknown", "The task is marked cleaned but a socket entry is present; it is left in place.")
		}
		return nil
	}
	if record.Bind == bindUnknown {
		return aserr.New("socket_unknown", "The backend bind outcome is unknown; no kill or unlink is attempted.")
	}
	if record.Pipe {
		if err := releasePipeTask(root, dir, record); err != nil {
			return err
		}
		if err := markOwnershipCleaned(root, *record); err != nil {
			return aserr.New("ownership_unknown", "The task backend stopped but the cleaned fact could not be recorded: "+messageOf(err))
		}
		return nil
	}
	if record.Bind == bindNone {
		if socketEntryExists(dir) {
			return aserr.New("socket_unknown", "The task recorded no bind but a socket entry is present; it is left in place.")
		}
		return markOwnershipCleaned(root, *record)
	}
	if usesFilesystemSocket && record.Socket == nil {
		return aserr.New("socket_unknown", "The backend bound without a captured socket identity; no kill or unlink is attempted.")
	}

	state, stateErr := backend.ServerState(dir, serverProbeTimeoutMs)
	if stateErr != nil {
		return aserr.New("socket_unknown", "Cannot determine the terminal server state: "+messageOf(stateErr))
	}
	serverExited := false
	needKill := false
	switch state {
	case shellbackend.ServerRunning:
		needKill = true
	case shellbackend.ServerStopped:
		serverExited = true
	case shellbackend.ServerSuspect:
		switch serverProcessState(record.ServerPid, dir) {
		case processExited:
			serverExited = true
		case processRunning:
			needKill = true
		default:
			return aserr.New("socket_unknown", "The terminal server process exit is not proven; no kill or unlink is attempted.")
		}
	case shellbackend.ServerMissing:
		// The recorded socket can disappear between a verified stop and the
		// cleaned write. Resume only when the captured socket identity and pid
		// prove that same server exited; a live, reused, or uninspectable pid
		// remains unknown.
		if record.Bind != bindBound || record.Socket == nil || record.ServerPid <= 0 {
			return aserr.New("socket_unknown", "The recorded terminal socket disappeared without a captured server pid.")
		}
		if serverProcessState(record.ServerPid, dir) != processExited {
			return aserr.New("socket_unknown", "The recorded terminal socket disappeared but its server process is not proven exited.")
		}
		// No unlink for an absent entry. Recheck once more: a replacement that
		// appeared in the meantime is verified but never deleted here.
		if socketEntryExists(dir) {
			if verifyErr := verifySocketIdentity(filepath.Join(dir, taskSocketName), *record.Socket); verifyErr != nil {
				return aserr.New("socket_unknown", "The recorded socket reappeared with a different identity: "+messageOf(verifyErr))
			}
			return aserr.New("socket_unknown", "The recorded socket reappeared during release; it is left in place.")
		}
		if err := markOwnershipCleaned(root, *record); err != nil {
			return aserr.New("ownership_unknown", "The task backend stopped but the cleaned fact could not be recorded: "+messageOf(err))
		}
		return nil
	default:
		return aserr.New("socket_unknown", "The terminal server state is unknown; no kill or unlink is attempted.")
	}

	if needKill {
		// Re-verify immediately before the destructive control; the earlier checks
		// are not a substitute for this no-follow identity gate.
		if _, verifyErr := verifyTaskOwnership(root, dir); verifyErr != nil {
			return verifyErr
		}
		// The kill is attempted only after identity verification. Its exit code is
		// not proof; the bounded probe below decides.
		_ = backend.KillServerWithin(dir, CancelControlTimeoutMs)
		deadline := time.Now().Add(time.Duration(PostKillWaitMs) * time.Millisecond)
		for {
			if time.Until(deadline) <= 0 {
				return aserr.New("socket_unknown", "The terminal server did not stop within the bounded wait; its socket is left in place.")
			}
			// Give every probe started before the deadline its full
			// serverProbeTimeoutMs budget. Clamping a probe down to a tiny
			// remaining slice causes subprocess probes (Windows psmux.exe) to
			// time out even after the server has already stopped.
			probe, probeErr := backend.ServerState(dir, serverProbeTimeoutMs)
			if probeErr != nil {
				return aserr.New("socket_unknown", "Cannot confirm terminal server stop: "+messageOf(probeErr))
			}
			switch probe {
			case shellbackend.ServerStopped:
				serverExited = true
			case shellbackend.ServerRunning:
				waitProbe(postKillPollDelayMs, deadline)
				continue
			case shellbackend.ServerSuspect:
				// The recorded pid was verified before the kill. After it, only a
				// cheap liveness check fits the bounded confirmation window; a reused
				// pid keeps the release unknown rather than extending the budget.
				if record.ServerPid <= 0 {
					return aserr.New("socket_unknown", "The terminal server process exit is not proven after kill.")
				}
				if !alive(record.ServerPid) {
					serverExited = true
				} else {
					waitProbe(postKillPollDelayMs, deadline)
					continue
				}
			case shellbackend.ServerMissing:
				return aserr.New("socket_unknown", "The recorded terminal socket disappeared after kill; the release is unknown.")
			default:
				return aserr.New("socket_unknown", "The terminal server state is unknown after kill.")
			}
			if serverExited {
				break
			}
		}
	}

	if usesFilesystemSocket {
		if err := unlinkOwnedSocket(dir, *record, serverExited); err != nil {
			return err
		}
	}
	if err := markOwnershipCleaned(root, *record); err != nil {
		return aserr.New("ownership_unknown", "The task backend stopped but the cleaned fact could not be recorded: "+messageOf(err))
	}
	return nil
}

// waitProbe waits at most the smaller of the requested delay and the remaining
// absolute deadline, so the post-kill confirmation window never resets.
func waitProbe(delayMs int, deadline time.Time) {
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return
	}
	wait := time.Duration(delayMs) * time.Millisecond
	if wait > remaining {
		wait = remaining
	}
	time.Sleep(wait)
}
