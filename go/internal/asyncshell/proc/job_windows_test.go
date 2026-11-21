//go:build windows

package proc

import (
	"errors"
	"os/exec"
	"strconv"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// job_windows_test.go pins the job-object properties the non-PTY backend relies
// on: no descendant may leave the tree, termination is observed by counting
// members of an open handle, and the last handle closing kills what is left.

// startMember starts one long-lived process and assigns it to job.
func startMember(t *testing.T, job *JobObject) int {
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
		t.Fatalf("open member: %v", err)
	}
	defer windows.CloseHandle(handle)
	if err := job.Assign(handle); err != nil {
		t.Fatalf("assign member: %v", err)
	}
	return pid
}

func requireActive(t *testing.T, job *JobObject, want uint32) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		active, err := job.ActiveProcesses()
		if err != nil {
			t.Fatalf("count processes: %v", err)
		}
		if active == want {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	active, _ := job.ActiveProcesses()
	t.Fatalf("active processes = %d, want %d", active, want)
}

func requireProcessGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if processHasExited(pid) {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("pid %d is still alive", pid)
}

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

func TestJobObjectFencesTheTreeAndProvesExit(t *testing.T) {
	name := "pijob-proc-test-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	job, err := CreateJobObject(name)
	if err != nil {
		t.Fatal(err)
	}
	pid := startMember(t, job)

	var limits windows.JOBOBJECT_BASIC_LIMIT_INFORMATION
	if err := windows.QueryInformationJobObject(job.handle, windows.JobObjectBasicLimitInformation,
		uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits)), nil); err != nil {
		t.Fatalf("read limits: %v", err)
	}
	if limits.LimitFlags&windows.JOB_OBJECT_LIMIT_BREAKAWAY_OK != 0 || limits.LimitFlags&windows.JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK != 0 {
		t.Fatalf("limit flags %#x allow a descendant to leave the job", limits.LimitFlags)
	}
	if limits.LimitFlags&windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE == 0 {
		t.Fatalf("limit flags %#x do not kill the tree when the last handle closes", limits.LimitFlags)
	}
	members, err := job.Members()
	if err != nil {
		t.Fatalf("read members: %v", err)
	}
	found := false
	for _, member := range members {
		if member == uint32(pid) {
			found = true
		}
	}
	if !found {
		t.Fatalf("members %v do not include %d", members, pid)
	}
	requireActive(t, job, 1)
	if err := job.Terminate(); err != nil {
		t.Fatalf("terminate: %v", err)
	}
	requireActive(t, job, 0)
	job.Close()
	if _, err := OpenJobObject(name); !errors.Is(err, ErrNoJobObject) {
		t.Fatalf("open an exited job: %v", err)
	}

	// The last handle closing is the orphan fence: a member that is still running
	// when every supervisor is gone must not survive.
	orphanName := name + "-orphan"
	orphanJob, err := CreateJobObject(orphanName)
	if err != nil {
		t.Fatal(err)
	}
	orphanPid := startMember(t, orphanJob)
	requireActive(t, orphanJob, 1)
	orphanJob.Close()
	requireProcessGone(t, orphanPid)
	if _, err := OpenJobObject(orphanName); !errors.Is(err, ErrNoJobObject) {
		t.Fatalf("open an orphaned job after its last handle closed: %v", err)
	}
}
