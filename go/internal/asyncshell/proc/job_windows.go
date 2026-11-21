//go:build windows

package proc

import (
	"errors"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// job_windows.go owns the Job Object primitive the non-PTY backend uses as its
// process-tree fence. Assignment is transitive, a descendant can leave the job
// only through a breakaway limit (never set here), and the job reports how many
// processes are still assigned. Tree exit is therefore decided by counting
// members of a queried handle, never by enumerating processes or command lines.

var procOpenJobObject = windows.NewLazySystemDLL("kernel32.dll").NewProc("OpenJobObjectW")

const (
	// The async shell counts the job's processes, joins them and stops them.
	jobObjectAssignProcess = 0x0001
	jobObjectQuery         = 0x0004
	jobObjectTerminate     = 0x0008
	// jobProcessListCapacity bounds one membership read; the async shell only
	// asks whether a single recorded pid is still assigned.
	jobProcessListCapacity = 64
)

// ErrNoJobObject reports that no job object carries the requested name. A named
// job keeps its name while any handle is open or any process is still assigned,
// so the error describes the whole tree rather than one member. Callers must not
// read it as proof that the tree exited.
var ErrNoJobObject = errors.New("no job object with that name")

// jobObjectBasicAccountingInformation is JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.
type jobObjectBasicAccountingInformation struct {
	TotalUserTime             int64
	TotalKernelTime           int64
	ThisPeriodTotalUserTime   int64
	ThisPeriodTotalKernelTime int64
	TotalPageFaultCount       uint32
	TotalProcesses            uint32
	ActiveProcesses           uint32
	TotalTerminatedProcesses  uint32
}

// JobObject is an open handle to a named job object. The name is one run's
// fence: it is generated per launch and persisted with the task ownership
// record before any process joins it.
type JobObject struct {
	Name   string
	handle windows.Handle
}

// CreateJobObject creates and configures a named job object. The job kills its
// remaining processes when the last handle closes, so a crash of every
// supervisor cannot orphan a command. Neither breakaway limit is set, so no
// descendant can leave the tree.
func CreateJobObject(name string) (*JobObject, error) {
	pointer, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateJobObject(nil, pointer)
	if err != nil {
		return nil, err
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(handle, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		windows.CloseHandle(handle)
		return nil, err
	}
	return &JobObject{Name: name, handle: handle}, nil
}

// OpenJobObject opens an existing named job object for counting and termination.
func OpenJobObject(name string) (*JobObject, error) {
	pointer, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, err
	}
	handle, _, callErr := syscall.SyscallN(procOpenJobObject.Addr(),
		uintptr(jobObjectAssignProcess|jobObjectQuery|jobObjectTerminate), 0, uintptr(unsafe.Pointer(pointer)))
	if handle == 0 {
		if errors.Is(callErr, windows.ERROR_FILE_NOT_FOUND) {
			return nil, ErrNoJobObject
		}
		if callErr == 0 {
			callErr = windows.ERROR_INVALID_HANDLE
		}
		return nil, callErr
	}
	return &JobObject{Name: name, handle: windows.Handle(handle)}, nil
}

// Assign assigns one process to the job. A caller assigning itself does so
// before it can start any child, so the whole tree it later creates is fenced.
func (job *JobObject) Assign(process windows.Handle) error {
	return windows.AssignProcessToJobObject(job.handle, process)
}

// AssignCurrentProcess assigns this process to the job.
func (job *JobObject) AssignCurrentProcess() error {
	process, err := windows.GetCurrentProcess()
	if err != nil {
		return err
	}
	return job.Assign(process)
}

// ActiveProcesses reports how many processes are assigned right now.
func (job *JobObject) ActiveProcesses() (uint32, error) {
	var accounting jobObjectBasicAccountingInformation
	if err := windows.QueryInformationJobObject(job.handle, windows.JobObjectBasicAccountingInformation,
		uintptr(unsafe.Pointer(&accounting)), uint32(unsafe.Sizeof(accounting)), nil); err != nil {
		return 0, err
	}
	return accounting.ActiveProcesses, nil
}

// Members reports the process ids currently assigned to the job.
func (job *JobObject) Members() ([]uint32, error) {
	// JOBOBJECT_BASIC_PROCESS_ID_LIST is a two-word header followed by the ids.
	const headerBytes = 8
	pointerSize := int(unsafe.Sizeof(uintptr(0)))
	buffer := make([]byte, headerBytes+jobProcessListCapacity*pointerSize)
	if err := windows.QueryInformationJobObject(job.handle, windows.JobObjectBasicProcessIdList,
		uintptr(unsafe.Pointer(&buffer[0])), uint32(len(buffer)), nil); err != nil {
		return nil, err
	}
	assigned := *(*uint32)(unsafe.Pointer(&buffer[0]))
	if assigned > jobProcessListCapacity {
		assigned = jobProcessListCapacity
	}
	listed := *(*uint32)(unsafe.Pointer(&buffer[4]))
	if listed > assigned {
		listed = assigned
	}
	values := unsafe.Slice((*uintptr)(unsafe.Pointer(&buffer[headerBytes])), int(listed))
	members := make([]uint32, 0, len(values))
	for _, value := range values {
		members = append(members, uint32(value))
	}
	return members, nil
}

// Terminate stops every process assigned to the job. The caller still has to
// observe a zero process count before it may claim the tree exited.
func (job *JobObject) Terminate() error {
	return windows.TerminateJobObject(job.handle, 1)
}

// Close releases this handle. Another supervisor handle keeps the job, and with
// it the command it contains, alive.
func (job *JobObject) Close() {
	if job == nil || job.handle == 0 {
		return
	}
	windows.CloseHandle(job.handle)
	job.handle = 0
}
