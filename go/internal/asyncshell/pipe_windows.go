//go:build windows

package asyncshell

import (
	"crypto/rand"
	"errors"
	"os"

	"pijob/internal/asyncshell/aserr"
	"pijob/internal/asyncshell/proc"
)

const (
	// pipeKillWaitMs bounds the confirmation window after terminating the job.
	pipeKillWaitMs = 2_000
	// pipeHandleWaitMs bounds how long create waits for a supervisor to record
	// its job handle before the command may start.
	pipeHandleWaitMs = 5_000
)

// pipeSupported reports that this platform has a proven process-tree stop path.
func pipeSupported() bool { return true }

// startPipeTask creates the task's job object, records its name in the ownership
// sidecar before any runner exists, starts the detached runner, and waits until
// that runner proves it holds the job. The job kills its members when the last
// handle closes, so the recorded handoff is what lets create release its own
// handle without killing the task.
func startPipeTask(root string, dir string, paths TaskPaths, selfArgv []string) (pipeStart, error) {
	if len(selfArgv) == 0 {
		return pipeStart{}, aserr.New("start_failed", "The pipe runner has no executable.")
	}
	name, err := newPipeJobName(taskIDOfDirectory(dir))
	if err != nil {
		return pipeStart{}, aserr.New("start_failed", "Cannot derive the task job object name: "+messageOf(err))
	}
	job, err := proc.CreateJobObject(name)
	if err != nil {
		return pipeStart{}, aserr.New("start_failed", "Cannot create the task job object: "+messageOf(err))
	}
	defer job.Close()
	// The name is persisted while the bind is still unknown: a crash between this
	// reservation and the bound record leaves the task unproven, and release never
	// guesses at an unproven task.
	if err := recordPipeReservation(root, dir, name); err != nil {
		return pipeStart{}, err
	}
	// Git Bash and the other MSYS/Cygwin programs treat a stdout handle without
	// FILE_WRITE_DATA as unusable. Go maps O_APPEND on an existing file to
	// FILE_APPEND_DATA _without_ GENERIC_WRITE (syscall.Open drops GENERIC_WRITE
	// unless O_TRUNC is set), and bash then exits 1 having written no byte and no
	// diagnostic. The pipe backend has exactly one producer, raw.log is created
	// empty just before this call, and stdout and stderr share this handle (and
	// therefore its file pointer), so a plain write handle keeps the same bytes in
	// the same order.
	output, err := os.OpenFile(paths.Raw, os.O_WRONLY, 0o600)
	if err != nil {
		failPipeStart(root, dir, job)
		return pipeStart{}, err
	}
	defer output.Close()
	pid, err := proc.StartDetachedOutput(selfArgv[0], selfArgv[1:], nil, output)
	if err != nil || pid == nil {
		failPipeStart(root, dir, job)
		if err == nil {
			err = aserr.New("start_failed", "The pipe runner did not start.")
		}
		return pipeStart{}, err
	}
	if !waitPipeHolder(paths.JobRunner, paths, pipeHandleWaitMs) {
		failPipeStart(root, dir, job)
		return pipeStart{}, aserr.New("start_failed",
			"The pipe runner did not record its job handle, so the task tree cannot be fenced; no command was started.")
	}
	return pipeStart{Pid: *pid, Job: name}, nil
}

// failPipeStart stops whatever the failed start already put into the job and
// records the explicit no-bind outcome together with the exit proof it just
// observed. A runner that never joined the job is in no tree fence at all; it was
// never cleared to start a command, so it leaves when its capture wait expires.
func failPipeStart(root string, dir string, job *proc.JobObject) {
	_ = caught(func() {
		id := taskIDOfDirectory(dir)
		record, err := readOwnership(root, id)
		if err != nil {
			return
		}
		_ = job.Terminate()
		if waitJobEmpty(job, pipeKillWaitMs) {
			record.JobExited = true
		}
		record.Bind = bindNone
		_ = writeOwnership(root, *record)
	})
}

// supervisePipeRunner is the runner's containment gate: it joins the task's job
// before the command can start, proves the assignment, records the open handle so
// create may release its own, and holds that handle for the runner's whole life.
func supervisePipeRunner(root string, dir string, paths TaskPaths) (func(), error) {
	record, err := verifyTaskOwnership(root, dir)
	if err != nil {
		return nil, err
	}
	if record.Job == "" {
		return nil, aserr.New("session_failed", "The pipe task records no job object, so the command cannot be contained.")
	}
	job, err := proc.OpenJobObject(record.Job)
	if err != nil {
		return nil, aserr.New("session_failed", "The pipe runner cannot open the task job object: "+messageOf(err))
	}
	if err := job.AssignCurrentProcess(); err != nil {
		job.Close()
		return nil, aserr.New("session_failed", "The pipe runner cannot join the task job object: "+messageOf(err))
	}
	member, err := jobMember(job, os.Getpid())
	if err != nil {
		job.Close()
		return nil, aserr.New("session_failed", "Cannot read the task job members: "+messageOf(err))
	}
	if !member {
		job.Close()
		return nil, aserr.New("session_failed", "The pipe runner is not assigned to the task job object; the command cannot be contained.")
	}
	writePrivateFile(paths.JobRunner, []byte(record.Job+"\n"))
	return func() { job.Close() }, nil
}

// awaitMonitorHandoff is create's second handoff gate: the monitor's job handle
// must be recorded before capture-ok lets the command start. Without it a fast
// command could leave the job with no open handle before release queries it.
func awaitMonitorHandoff(paths TaskPaths) error {
	if waitPipeHolder(paths.JobMonitor, paths, pipeHandleWaitMs) {
		return nil
	}
	return aserr.New("start_failed",
		"The task monitor did not record its job handle, so the command was not started.")
}

// pipeSupervise gives the monitor its view of the pipe tree: a held job handle,
// a liveness answer for draining, and the release of that handle. Any failure
// keeps the monitor conservative: the tree is reported alive, and release later
// reports the missing exit proof as unknown instead of assuming exit.
func pipeSupervise(paths TaskPaths) (alive func() bool, release func()) {
	unknown := func() bool { return true }
	nothing := func() {}
	record, err := verifyTaskOwnership(StateRoot(), paths.Dir)
	if err != nil || record.Job == "" {
		return unknown, nothing
	}
	job, err := proc.OpenJobObject(record.Job)
	if err != nil {
		return unknown, nothing
	}
	writePrivateFile(paths.JobMonitor, []byte(record.Job+"\n"))
	return func() bool {
		active, err := job.ActiveProcesses()
		if err != nil {
			return true
		}
		return active > 0
	}, func() { job.Close() }
}

// stopPipeTree terminates every process assigned to the task's job object and
// requires a queried zero count before it records the exit proof. Ownership comes
// from the sidecar job name plus the task directory identity the caller already
// verified; while the recorded runner is alive it must also be a member, so a
// substituted name can never authorize a kill.
func stopPipeTree(root string, _ string, record *ownershipRecord) error {
	if record.Job == "" {
		return aserr.New("process_unknown", "The pipe task records no job object; no kill is attempted.")
	}
	job, err := proc.OpenJobObject(record.Job)
	if err != nil {
		if errors.Is(err, proc.ErrNoJobObject) {
			// No handle, so no count: a task whose tree was already proven stopped
			// carries that proof, and anything else stays unknown rather than
			// reading absence as exit.
			return aserr.New("process_unknown",
				"The task job object is gone without a recorded exit proof; no kill is attempted.")
		}
		return aserr.New("process_unknown", "The task job object cannot be opened: "+messageOf(err))
	}
	defer job.Close()
	active, err := job.ActiveProcesses()
	if err != nil {
		return aserr.New("process_unknown", "Cannot count the task job processes: "+messageOf(err))
	}
	if active == 0 {
		return markJobExited(root, record)
	}
	// A kill needs a live owner: the recorded runner must still exist and must be
	// assigned to this job. Without both, the members could belong to a job whose
	// name replaced the recorded one, so the fence is kept instead.
	if record.RunnerPid <= 0 || !alive(record.RunnerPid) {
		return aserr.New("process_unknown",
			"The task job object still holds processes after its runner exited; no unproven kill is attempted.")
	}
	member, err := jobMember(job, record.RunnerPid)
	if err != nil {
		return aserr.New("process_unknown", "Cannot read the task job members: "+messageOf(err))
	}
	if !member {
		return aserr.New("process_unknown",
			"The running task runner is not a member of the recorded job object; no kill is attempted.")
	}
	if err := job.Terminate(); err != nil {
		return aserr.New("process_unknown", "The task job object could not be terminated: "+messageOf(err))
	}
	if !waitJobEmpty(job, pipeKillWaitMs) {
		return aserr.New("process_unknown", "The task job object still holds processes after termination; the fence is retained.")
	}
	return markJobExited(root, record)
}

// jobMember reports whether one recorded pid is assigned to the job.
func jobMember(job *proc.JobObject, pid int) (bool, error) {
	members, err := job.Members()
	if err != nil {
		return false, err
	}
	for _, member := range members {
		if member == uint32(pid) {
			return true, nil
		}
	}
	return false, nil
}

// waitJobEmpty polls the assigned process count of a handle it already holds.
func waitJobEmpty(job *proc.JobObject, timeoutMs int) bool {
	deadline := nowMs() + int64(timeoutMs)
	for {
		active, err := job.ActiveProcesses()
		if err == nil && active == 0 {
			return true
		}
		if nowMs() >= deadline {
			return err == nil && active == 0
		}
		sleep(25)
	}
}

// waitPipeHolder waits until a supervising process records its job handle.
func waitPipeHolder(marker string, paths TaskPaths, timeoutMs int) bool {
	deadline := nowMs() + int64(timeoutMs)
	for {
		if fileExists(marker) {
			return true
		}
		if nowMs() >= deadline || fileExists(paths.Exit) || fileExists(paths.Closed) {
			return false
		}
		sleep(10)
	}
}

// recordPipeReservation records the pipe backend and its tree fence before the
// runner exists. The bind stays unknown until the runner proves it holds the
// fence, so a crash in between leaves an unproven task that release never
// guesses at.
func recordPipeReservation(root string, dir string, job string) error {
	id := taskIDOfDirectory(dir)
	record, err := readOwnership(root, id)
	if err != nil {
		return err
	}
	record.Pipe = true
	record.Job = job
	record.Socket = nil
	record.Bind = bindUnknown
	return writeOwnership(root, *record)
}

// markJobExited persists a zero process count observed through an open job
// handle. The record it updates is the caller's, so the release that requested
// the proof publishes the proof and the cleaned fact together.
func markJobExited(root string, record *ownershipRecord) error {
	record.JobExited = true
	return writeOwnership(root, *record)
}

// newPipeJobName returns this launch's job object name. Per-launch entropy keeps
// a later task with a recycled task id from meeting an older job.
func newPipeJobName(taskID string) (string, error) {
	entropy := make([]byte, 8)
	if _, err := rand.Read(entropy); err != nil {
		return "", err
	}
	return "pijob-" + taskID + "-" + hexEncode(entropy), nil
}
