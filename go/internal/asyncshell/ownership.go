package asyncshell

import (
	"encoding/json"
	"os"
	"path/filepath"

	"pijob/internal/asyncshell/aserr"
)

// ownershipVersion is the persisted sidecar contract. A missing or different
// version is unknown ownership: cleanup must never guess.
const ownershipVersion = 1

// taskSocketName is reserved for this task's terminal backend.
const taskSocketName = "tmux.sock"

// ownershipID is the no-follow identity of one filesystem object captured when
// the task owns it (task directory at allocation, socket immediately after the
// backend binds it). A later observation must match these exact fields; merely
// looking at the current path does not establish ownership.
type ownershipID struct {
	Dev  uint64 `json:"dev"`
	Ino  uint64 `json:"ino"`
	Uid  uint32 `json:"uid"`
	Mode uint32 `json:"mode"`
}

// ownershipRecord lives outside the replaceable task directory. It ties the
// task id to the directory and socket inode captured at creation/bind, plus the
// tmux server pid and an idempotent cleaned marker.
type ownershipRecord struct {
	Version   int          `json:"version"`
	Task      string       `json:"task"`
	Directory ownershipID  `json:"directory"`
	Socket    *ownershipID `json:"socket,omitempty"`
	ServerPid int          `json:"serverPid,omitempty"`
	// Bind records the backend bind outcome: none (explicit no-bind), bound
	// (new-session or runner spawn succeeded), or unknown (outcome not proven).
	Bind string `json:"bind,omitempty"`
	// Pipe marks the non-PTY backend and RunnerPid is its detached runner
	// process, captured at spawn. Both are absent for PTY tasks.
	Pipe      bool `json:"pipe,omitempty"`
	RunnerPid int  `json:"runnerPid,omitempty"`
	// Job is the Windows job object that fences the pipe tree. It is recorded
	// before the runner exists and is the only authority any later kill may use.
	Job string `json:"job,omitempty"`
	// JobExited is the exit proof taken from an open job handle that reported a
	// zero assigned process count. It outlives the job object so a release can
	// finish without treating a missing job as proof of exit.
	JobExited bool `json:"jobExited,omitempty"`
	Cleaned   bool `json:"cleaned,omitempty"`
}

const (
	bindNone    = "none"
	bindBound   = "bound"
	bindUnknown = "unknown"
)

func ownersDirectory(root string) string { return filepath.Join(root, ".owners") }

func ownershipPath(root string, id string) string {
	return filepath.Join(ownersDirectory(root), id+".json")
}

func taskIDOfDirectory(dir string) string { return filepath.Base(dir) }

// ensureOwnersDirectory creates the root-level sidecar directory and verifies it
// is a private, non-symlink directory. It is intentionally separate from the
// task directory so replacing the task directory cannot replace its own identity.
func ensureOwnersDirectory(root string) (string, error) {
	if err := verifyRootDirectory(root); err != nil {
		return "", aserr.New("ownership_unknown", "The async-shell root is not private: "+messageOf(err))
	}
	owners := ownersDirectory(root)
	if err := os.MkdirAll(owners, 0o700); err != nil {
		return "", aserr.New("ownership_unavailable", "Cannot create the ownership sidecar directory: "+messageOf(err))
	}
	if err := verifySidecarDirectory(owners); err != nil {
		return "", err
	}
	return owners, nil
}

func readOwnership(root string, id string) (*ownershipRecord, error) {
	if err := verifyRootDirectory(root); err != nil {
		return nil, aserr.New("ownership_unknown", "The async-shell root is not private: "+messageOf(err))
	}
	if !IsTaskID(id) {
		return nil, aserr.New("ownership_unknown", "Not an async-shell task id: "+id)
	}
	if err := verifySidecarDirectory(ownersDirectory(root)); err != nil {
		return nil, err
	}
	path := ownershipPath(root, id)
	data, err := readSidecarFile(path)
	if err != nil {
		return nil, aserr.New("ownership_unknown", "Cannot read the ownership record for task "+id+": "+messageOf(err))
	}
	var record ownershipRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return nil, aserr.New("ownership_unknown", "The ownership record for task "+id+" is unreadable.")
	}
	if record.Version != ownershipVersion || record.Task != id {
		return nil, aserr.New("ownership_unknown", "The ownership record for task "+id+" has the wrong contract or identity.")
	}
	return &record, nil
}

func writeOwnership(root string, record ownershipRecord) error {
	if _, err := ensureOwnersDirectory(root); err != nil {
		return err
	}
	if record.Version != ownershipVersion || !IsTaskID(record.Task) {
		return aserr.New("ownership_unknown", "Refusing to write an invalid ownership record.")
	}
	path := ownershipPath(root, record.Task)
	writeJSONAtomic(path, record)
	return nil
}

// recordDirectoryOwnership writes the fd-derived directory identity captured
// at allocation, before registration or backend start.
func recordDirectoryOwnership(root string, dir string, identity ownershipID) error {
	id := taskIDOfDirectory(dir)
	return writeOwnership(root, ownershipRecord{
		Version: ownershipVersion, Task: id, Directory: identity, Bind: bindNone,
	})
}

// markBindUnknown is written before new-session: an unknown outcome is not an
// ownership grant, so a later observed socket is never adopted.
func markBindUnknown(root string, id string) error {
	record, err := readOwnership(root, id)
	if err != nil {
		return err
	}
	record.Bind = bindUnknown
	return writeOwnership(root, *record)
}

// markBindNone records an explicit no-bind failure.
func markBindNone(root string, id string) error {
	record, err := readOwnership(root, id)
	if err != nil {
		return err
	}
	record.Bind = bindNone
	return writeOwnership(root, *record)
}

// recordBoundOwnership captures the bind-time socket identity and server pid
// immediately after a successful new-session, before pipe-pane and monitor
// startup. On Windows the backend uses a named pipe, so no filesystem socket is
// recorded; the psmux state remains the only backend state.
func recordBoundOwnership(root string, dir string) error {
	id := taskIDOfDirectory(dir)
	record, err := readOwnership(root, id)
	if err != nil {
		return err
	}
	identity, socketErr := socketIdentity(filepath.Join(dir, taskSocketName))
	switch {
	case socketErr == nil:
		record.Socket = &identity
	case isNoFilesystemSocket(socketErr):
		record.Socket = nil
	default:
		return aserr.New("ownership_unknown", "Cannot capture the task socket identity after bind: "+messageOf(socketErr))
	}
	pid, pidErr := backend.ServerPid(dir)
	if pidErr == nil {
		record.ServerPid = pid
	}
	record.Bind = bindBound
	return writeOwnership(root, *record)
}

// recordBoundPipeOwnership records the pipe runner as the task's bound backend.
// There is no filesystem socket; the runner pid, the tree fence name plus the
// persisted task directory identity are what authorize later termination.
func recordBoundPipeOwnership(root string, dir string, started pipeStart) error {
	id := taskIDOfDirectory(dir)
	record, err := readOwnership(root, id)
	if err != nil {
		return err
	}
	record.Pipe = true
	record.RunnerPid = started.Pid
	record.Job = started.Job
	record.Socket = nil
	record.Bind = bindBound
	return writeOwnership(root, *record)
}

// verifyTaskOwnership re-reads the sidecar and proves the current task directory
// and socket are the objects captured at creation/bind. It follows no symlinks.
func verifyTaskOwnership(root string, dir string) (*ownershipRecord, error) {
	if err := verifyRootDirectory(root); err != nil {
		return nil, aserr.New("ownership_unknown", "The async-shell root is not private: "+messageOf(err))
	}
	id := taskIDOfDirectory(dir)
	record, err := readOwnership(root, id)
	if err != nil {
		return nil, err
	}
	if err := verifyDirectoryIdentity(dir, record.Directory); err != nil {
		return nil, aserr.New("ownership_unknown", "The task directory identity cannot be proven: "+messageOf(err))
	}
	if record.Socket != nil {
		// Absence is allowed here so release can decide using the captured server
		// pid; absence alone never authorizes deletion. Any current entry is still
		// verified against the recorded identity.
		if socketEntryExists(dir) {
			if err := verifySocketIdentity(filepath.Join(dir, taskSocketName), *record.Socket); err != nil {
				return nil, aserr.New("socket_unknown", "The task socket identity cannot be proven: "+messageOf(err))
			}
		}
	}
	return record, nil
}

// markOwnershipCleaned is written only after a verified backend release.
func markOwnershipCleaned(root string, record ownershipRecord) error {
	record.Cleaned = true
	return writeOwnership(root, record)
}
