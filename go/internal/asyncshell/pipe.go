package asyncshell

import "pijob/internal/asyncshell/aserr"

// pipeStart is the platform's record of a started pipe backend: the detached
// runner pid and, on Windows, the job object that files the command's tree.
type pipeStart struct {
	Pid int
	Job string
}

// releasePipeTask proves that the pipe backend's process tree is gone. A tree
// whose exit was already proven records that proof and needs no live fence; a
// fence that was created before a runner could exist must still be proven empty.
func releasePipeTask(root string, dir string, record *ownershipRecord) error {
	if record.JobExited {
		return nil
	}
	if record.RunnerPid <= 0 {
		if record.Bind != bindNone {
			return aserr.New("process_unknown", "The pipe task is marked bound without a recorded runner; no cleanup is attempted.")
		}
		if record.Job == "" {
			return nil
		}
	}
	return stopPipeTree(root, dir, record)
}
