//go:build windows

package asyncshell

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"pijob/internal/asyncshell/proc"
)

// pipe_windows_test.go exercises the real job-object backend: a live command, a
// live descendant, cancellation and timeout of both, and the ownership fences
// that decide whether a kill is authorized at all.

func waitTaskClosed(t *testing.T, root string, id string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Lstat(filepath.Join(root, id, "closed")); err == nil {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("task %s did not close", id)
}

func waitPidFile(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if pid := readPid(path); pid != nil {
			return *pid
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("pid file %s never appeared", path)
	return 0
}

// stillActive is STILL_ACTIVE: GetExitCodeProcess reports it while a process runs.
const stillActive = 259

// processHasExited reads the process exit state; a bare OpenProcess success proves
// nothing because an exited process object survives while any handle is open.
func processHasExited(pid int) bool {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return true
	}
	defer windows.CloseHandle(handle)
	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return false
	}
	return code != stillActive
}

// terminateProcess stops one process and closes the handle it used, so no dead
// process object stays open and later liveness checks answer for the real state.
func terminateProcess(pid int) error {
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	return windows.TerminateProcess(handle, 1)
}

// requireProcessGoneNow waits for both halves of "gone": the recorded exit code
// and the closed process object. Production liveness answers through the handle,
// so a lingering object would answer for a dead process.
func requireProcessGoneNow(t *testing.T, label string, pid int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if processHasExited(pid) && !alive(pid) {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("%s pid %d is still alive", label, pid)
}

func requireProcessAlive(t *testing.T, label string, pid int) {
	t.Helper()
	if processHasExited(pid) {
		t.Fatalf("%s pid %d exited although the fence was retained", label, pid)
	}
}

// requireJobEmpty proves the task's tree holds no process: either through the live
// job object or through the exit proof recorded while a handle was open.
func requireJobEmpty(t *testing.T, root string, id string) {
	t.Helper()
	record, err := readOwnership(root, id)
	if err != nil {
		t.Fatalf("ownership record: %v", err)
	}
	if record.Job == "" {
		t.Fatal("the pipe task recorded no job object")
	}
	job, err := proc.OpenJobObject(record.Job)
	if err != nil {
		if !errors.Is(err, proc.ErrNoJobObject) {
			t.Fatalf("open job %s: %v", record.Job, err)
		}
		if !record.JobExited {
			t.Fatalf("job %s is gone without a recorded exit proof", record.Job)
		}
		return
	}
	defer job.Close()
	active, err := job.ActiveProcesses()
	if err != nil {
		t.Fatalf("count job %s: %v", record.Job, err)
	}
	if active != 0 {
		t.Fatalf("job %s still holds %d processes", record.Job, active)
	}
}

// spawnScript writes a PowerShell script whose process starts one descendant of
// its own and records that descendant's pid, so a stop has to end both.
func spawnScript(t *testing.T, root string) string {
	t.Helper()
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }
	script := strings.Join([]string{
		"$ErrorActionPreference = 'Stop'",
		"$ping = Join-Path $env:SystemRoot 'System32\\PING.EXE'",
		"$child = Start-Process -FilePath $ping -ArgumentList '-n','300','127.0.0.1' -PassThru -WindowStyle Hidden",
		"Set-Content -Path " + quote(filepath.Join(root, "grandchild.pid")) + " -Value $child.Id",
		"Start-Sleep -Seconds 300",
	}, "\r\n")
	path := filepath.Join(root, "spawn.ps1")
	if err := os.WriteFile(path, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// startForeignMember assigns one live process to a job this test created, which
// stands in for another task's tree.
func startForeignMember(t *testing.T, job *proc.JobObject) int {
	t.Helper()
	command := exec.Command("ping.exe", "-n", "600", "127.0.0.1")
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	pid := command.Process.Pid
	t.Cleanup(func() {
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
	})
	handle, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION,
		false, uint32(pid))
	if err != nil {
		t.Fatalf("open foreign member: %v", err)
	}
	defer windows.CloseHandle(handle)
	if err := job.Assign(handle); err != nil {
		t.Fatalf("assign foreign member: %v", err)
	}
	return pid
}

func TestPipeTaskGetsStdinEOFAndReportsExit(t *testing.T) {
	root := taskRoot(t)
	timeoutMs := int64(20_000)
	// `more` reads stdin: only a null device lets the pipeline continue, so the
	// later lines prove the command never saw a terminal or an open pipe.
	result, err := CreateTask(CreateTaskOptions{
		Argv:      []string{"cmd.exe", "/d", "/s", "/c", `more & echo eof-ok & echo out & echo err 1>&2 & exit /b 3`},
		Cwd:       root,
		WaitMs:    20_000,
		TimeoutMs: &timeoutMs,
		Pipe:      true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != StatusFailed || result.ExitCode == nil || *result.ExitCode != 3 {
		t.Fatalf("result = %#v, want failed exit 3", result)
	}
	for _, wanted := range []string{"eof-ok", "out", "err"} {
		if !strings.Contains(result.Output, wanted) {
			t.Fatalf("output = %q, want %q", result.Output, wanted)
		}
	}
	dir := taskDirOf(result)
	waitTaskClosed(t, root, result.ID)
	if record, err := readOwnership(root, result.ID); err != nil || !record.Cleaned || !record.Pipe {
		t.Fatalf("ownership = %#v, %v", record, err)
	} else {
		if !strings.HasPrefix(record.Job, "pijob-"+result.ID) {
			t.Fatalf("job name = %q, want it tied to %s", record.Job, result.ID)
		}
		if !record.JobExited {
			t.Fatalf("task recorded no exit proof: %#v", record)
		}
	}
	requireJobEmpty(t, root, result.ID)
	if state := readStateFile(taskPaths(dir), safeReadTask(taskPaths(dir))); state.Status != StatusFailed {
		t.Fatalf("state = %s, want failed", state.Status)
	}
}

// TestPipeTaskRunsGitBashScript pins raw.log's handle access against MSYS/Cygwin
// stdio: those runtimes refuse a stdout handle that carries only FILE_APPEND_DATA
// and exit 1 without output, which is what an O_APPEND raw.log handed them.
func TestPipeTaskRunsGitBashScript(t *testing.T) {
	bash := `C:\Program Files\Git\bin\bash.exe`
	if _, err := os.Stat(bash); err != nil {
		t.Skip("Git Bash is not installed at the expected path")
	}
	root := taskRoot(t)
	script := "export HARNESS_FIXTURE_PREFIX=\"${HARNESS_FIXTURE_PREFIX:-}once\"\n" +
		"printf \"%s\\n\" \"$HARNESS_FIXTURE_PREFIX\"\n" +
		"printf 'git-bash-stderr\\n' >&2"
	result, err := CreateTask(CreateTaskOptions{Argv: []string{bash, "-c", script}, Cwd: root, WaitMs: 20_000, Pipe: true})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != StatusCompleted || result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatalf("result = %#v, want completed 0", result)
	}
	if result.Output != "once\ngit-bash-stderr\n" {
		t.Fatalf("output = %q, want both streams in write order through one handle", result.Output)
	}
	waitTaskClosed(t, root, result.ID)
	record, err := readOwnership(root, result.ID)
	if err != nil || !record.Cleaned || !record.JobExited {
		t.Fatalf("ownership = %#v, %v", record, err)
	}
	requireJobEmpty(t, root, result.ID)
}

// TestPipeFastCommandAlwaysProvesExit pins the startup handoff order: a command
// may only start once both supervisors hold the job, so even a command that ends
// immediately still has an open handle to prove its exit.
func TestPipeFastCommandAlwaysProvesExit(t *testing.T) {
	root := taskRoot(t)
	for attempt := 0; attempt < 5; attempt++ {
		result, err := CreateTask(CreateTaskOptions{
			Argv:   []string{"cmd.exe", "/d", "/s", "/c", "echo fast-" + strconv.Itoa(attempt)},
			Cwd:    root,
			WaitMs: 20_000,
			Pipe:   true,
		})
		if err != nil {
			t.Fatalf("attempt %d: %v", attempt, err)
		}
		if result.Status != StatusCompleted || result.ExitCode == nil || *result.ExitCode != 0 {
			t.Fatalf("attempt %d result = %#v, want completed 0", attempt, result)
		}
		if !strings.Contains(result.Output, "fast-"+strconv.Itoa(attempt)) {
			t.Fatalf("attempt %d output = %q", attempt, result.Output)
		}
		waitTaskClosed(t, root, result.ID)
		record, err := readOwnership(root, result.ID)
		if err != nil || !record.Cleaned || !record.JobExited {
			t.Fatalf("attempt %d ownership = %#v, %v", attempt, record, err)
		}
		requireJobEmpty(t, root, result.ID)
	}
}

func TestPipeCancelStopsChildAndDescendant(t *testing.T) {
	root := taskRoot(t)
	script := spawnScript(t, root)
	result, err := CreateTask(CreateTaskOptions{
		Argv:   []string{"powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script},
		Cwd:    root,
		WaitMs: 0,
		Pipe:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	dir := taskDirOf(result)
	t.Cleanup(func() { _ = CancelTask(dir, root) })

	paths := taskPaths(dir)
	runnerPid := waitPidFile(t, paths.RunnerPid)
	childPid := waitPidFile(t, paths.ChildPid)
	grandchildPid := waitPidFile(t, filepath.Join(root, "grandchild.pid"))
	if childPid == grandchildPid || childPid == runnerPid {
		t.Fatalf("unexpected pids: runner=%d child=%d grandchild=%d", runnerPid, childPid, grandchildPid)
	}
	if err := CancelTask(dir, root); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	requireProcessGoneNow(t, "runner", runnerPid)
	requireProcessGoneNow(t, "child", childPid)
	requireProcessGoneNow(t, "descendant", grandchildPid)
	requireJobEmpty(t, root, result.ID)
	waitTaskClosed(t, root, result.ID)
	state := readStateFile(paths, safeReadTask(paths))
	if state.Status != StatusCancelled {
		t.Fatalf("state = %s, want cancelled", state.Status)
	}
	if record, err := readOwnership(root, result.ID); err != nil || !record.Cleaned {
		t.Fatalf("cancel did not mark ownership cleaned: %#v %v", record, err)
	}
}

func TestPipeTimeoutStopsChildAndDescendant(t *testing.T) {
	root := taskRoot(t)
	script := spawnScript(t, root)
	timeoutMs := int64(1_500)
	result, err := CreateTask(CreateTaskOptions{
		Argv:      []string{"powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script},
		Cwd:       root,
		WaitMs:    20_000,
		TimeoutMs: &timeoutMs,
		Pipe:      true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != StatusTimedOut || result.ExitCode != nil {
		t.Fatalf("result = %#v, want timed_out with no exit code", result)
	}
	dir := taskDirOf(result)
	paths := taskPaths(dir)
	requireProcessGoneNow(t, "runner", waitPidFile(t, paths.RunnerPid))
	requireProcessGoneNow(t, "child", waitPidFile(t, paths.ChildPid))
	requireProcessGoneNow(t, "descendant", waitPidFile(t, filepath.Join(root, "grandchild.pid")))
	requireJobEmpty(t, root, result.ID)
	waitTaskClosed(t, root, result.ID)
	if record, err := readOwnership(root, result.ID); err != nil || !record.Cleaned {
		t.Fatalf("timeout did not mark ownership cleaned: %#v %v", record, err)
	}
}

// TestPipeTaskDiesWhenEverySupervisorIsGone pins the orphan fence: the job kills
// its members when the last supervisor handle closes, so losing the runner and the
// monitor cannot leave a command running with nobody able to prove or stop it.
func TestPipeTaskDiesWhenEverySupervisorIsGone(t *testing.T) {
	root := taskRoot(t)
	script := spawnScript(t, root)
	result, err := CreateTask(CreateTaskOptions{
		Argv:   []string{"powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script},
		Cwd:    root,
		WaitMs: 0,
		Pipe:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	paths := taskPaths(taskDirOf(result))
	runnerPid := waitPidFile(t, paths.RunnerPid)
	childPid := waitPidFile(t, paths.ChildPid)
	grandchildPid := waitPidFile(t, filepath.Join(root, "grandchild.pid"))
	monitorPid := waitPidFile(t, paths.MonitorPid)

	if err := terminateProcess(monitorPid); err != nil {
		t.Fatalf("stop the monitor: %v", err)
	}
	if err := terminateProcess(runnerPid); err != nil {
		t.Fatalf("stop the runner: %v", err)
	}
	requireProcessGoneNow(t, "child", childPid)
	requireProcessGoneNow(t, "descendant", grandchildPid)

	record, err := readOwnership(root, result.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := proc.OpenJobObject(record.Job); !errors.Is(err, proc.ErrNoJobObject) {
		t.Fatalf("the job object survived every handle: %v", err)
	}
	if record.Cleaned {
		t.Fatal("a crashed task claimed cleanup")
	}
}

// TestPipeReleaseRefusesSubstitutedJobName keeps the fence when the recorded job
// name is not the tree this task started: neither a missing job nor another live
// job may authorize a kill.
func TestPipeReleaseRefusesSubstitutedJobName(t *testing.T) {
	root := taskRoot(t)
	script := spawnScript(t, root)
	result, err := CreateTask(CreateTaskOptions{
		Argv:   []string{"powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script},
		Cwd:    root,
		WaitMs: 0,
		Pipe:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	dir := taskDirOf(result)
	paths := taskPaths(dir)
	t.Cleanup(func() {
		if record, readErr := readOwnership(root, result.ID); readErr == nil && record.Cleaned {
			return
		}
		_ = CancelTask(dir, root)
		for _, pidFile := range []string{paths.RunnerPid, paths.ChildPid, filepath.Join(root, "grandchild.pid")} {
			if pid := readPid(pidFile); pid != nil {
				_ = terminateProcess(*pid)
			}
		}
	})

	runnerPid := waitPidFile(t, paths.RunnerPid)
	childPid := waitPidFile(t, paths.ChildPid)
	grandchildPid := waitPidFile(t, filepath.Join(root, "grandchild.pid"))
	monitorPid := waitPidFile(t, paths.MonitorPid)
	if err := terminateProcess(monitorPid); err != nil {
		t.Fatalf("stop the monitor: %v", err)
	}
	requireProcessGoneNow(t, "monitor", monitorPid)
	record, err := readOwnership(root, result.ID)
	if err != nil {
		t.Fatal(err)
	}
	started := *record

	// A name that never existed cannot prove anything.
	record.Job = "pijob-" + result.ID + "-0000000000000000"
	record.JobExited = false
	if err := writeOwnership(root, *record); err != nil {
		t.Fatal(err)
	}
	if err := CancelTask(dir, root); err == nil {
		t.Fatal("cancel accepted a job name that never existed")
	} else if !strings.Contains(err.Error(), "gone without a recorded exit proof") {
		t.Fatalf("cancel error = %v", err)
	}
	if _, statErr := os.Lstat(paths.Closed); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("cancel certified cleanup without an exit proof: %v", statErr)
	}

	// Another live job's name must not authorize terminating that job either.
	foreign, err := proc.CreateJobObject("pijob-foreign-" + strconv.FormatInt(time.Now().UnixNano(), 36))
	if err != nil {
		t.Fatal(err)
	}
	defer foreign.Close()
	foreignPid := startForeignMember(t, foreign)
	record.Job = foreign.Name
	if err := writeOwnership(root, *record); err != nil {
		t.Fatal(err)
	}
	if err := CancelTask(dir, root); err == nil {
		t.Fatal("cancel accepted another job's name")
	} else if !strings.Contains(err.Error(), "not a member of the recorded job object") {
		t.Fatalf("cancel error = %v", err)
	}
	requireProcessAlive(t, "foreign member", foreignPid)
	requireProcessAlive(t, "runner", runnerPid)
	requireProcessAlive(t, "child", childPid)
	requireProcessAlive(t, "descendant", grandchildPid)

	// Restoring the recorded name lets the same fence stop the real tree.
	started.JobExited = false
	if err := writeOwnership(root, started); err != nil {
		t.Fatal(err)
	}
	if err := CancelTask(dir, root); err != nil {
		t.Fatalf("cancel with the restored job name: %v", err)
	}
	requireProcessGoneNow(t, "runner", runnerPid)
	requireProcessGoneNow(t, "child", childPid)
	requireProcessGoneNow(t, "descendant", grandchildPid)
	requireJobEmpty(t, root, result.ID)
	waitTaskClosed(t, root, result.ID)
	if processHasExited(foreignPid) {
		t.Fatal("the unrelated job lost its member")
	}
}
