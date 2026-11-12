package asyncshell

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// tmux.go translates src/async-shell/tmux.ts: the shared async-shell task engine.
//
// Async/await mapping: every `await` in the source is consumed immediately, so the
// literal Go translation is a synchronous (blocking) call in the same order. The
// child_process event seams (OnceExit/OnceError + Wait) stay explicit in seams.go.
//
// throw -> panic(AsyncShellError); try/catch -> caught(func(){...}) (defer/recover).

// backend is tmux.ts's per-platform backend selection.
var backend ShellBackend = defaultBackend()

const (
	MonitorTickMs  = 60
	QuietFlushMs   = 150
	DrainQuietMs   = 200
	DrainLimitMs   = 5000
	CancelWaitMs   = 15000
	StartupWaitMs  = 5000
	DecisionWaitMs = 3000
	CaptureWaitMs  = 20000
)

// MaxSendBytes is TS MAX_SEND_BYTES: input is bounded at the stream boundary.
const MaxSendBytes = 64 * 1024

// ReadChunkBytes bounds each capture read; a pump still drains the backlog.
const ReadChunkBytes int64 = 64 * 1024

// CaptureMarker is announced by the runner; the filter strips it.
const CaptureMarker = "\x1b]5511;pi-async-capture\x07"

// TaskPaths is TS interface TaskPaths.
type TaskPaths struct {
	Dir        string
	Task       string
	State      string
	Raw        string
	Filtered   string
	CaptureOk  string
	Exit       string
	Cancel     string
	Closed     string
	Delivery   string
	PollCursor string
	MonitorPid string
	RunnerPid  string
	ChildPid   string
}

// CallbackTarget is TS interface CallbackTarget.
type CallbackTarget struct {
	Socket string
	Token  string
}

// taskFile is TS interface TaskFile. Field order matches the JSON.stringify order.
type taskFile struct {
	ID        string  `json:"id"`
	Argv      []string `json:"argv"`
	Cwd       string  `json:"cwd"`
	CreatedAt int64   `json:"createdAt"`
	WaitMs    int64   `json:"waitMs"`
	TimeoutMs *int64  `json:"timeoutMs"`
}

// taskState is TS interface TaskState.
type taskState struct {
	ID          string      `json:"id"`
	Status      ShellStatus `json:"status"`
	ExitCode    *int        `json:"exitCode"`
	CreatedAt   int64       `json:"createdAt"`
	FinalizedAt *int64      `json:"finalizedAt"`
}

// exitFile is TS interface ExitFile.
type exitFile struct {
	Code   *int    `json:"code"`
	Signal *string `json:"signal"`
	Error  *string `json:"error"`
}

// OutputChunk is TS interface OutputChunk.
type OutputChunk struct {
	Text      string
	Cursor    int64
	Truncated bool
}

// CreateTaskOptions is TS interface CreateTaskOptions.
type CreateTaskOptions struct {
	Argv      []string
	Cwd       string
	TimeoutMs *int64
	WaitMs    int64
	Callback  *CallbackTarget
}

// assertSupported is TS assertSupported.
func assertSupported() {
	backend.AssertAvailable()
}

// StateRoot is TS stateRoot.
func StateRoot() string {
	root := ProcessEnv()["PI_ASYNC_SHELL_ROOT"]
	if root == "" {
		root = PathJoin(OsTmpdir(), "pi-async-shell-"+formatInt(ProcessGetuid()))
	}
	return PathResolve(root)
}

// TaskDirectory is TS taskDirectory.
func TaskDirectory(id string, root string) string {
	if !IsTaskId(id) {
		panic(NewAsyncShellError("invalid_id", "Not an async-shell task id: "+id))
	}
	return PathJoin(root, id)
}

// checkedTaskDirectory is TS checkedTaskDirectory: only <root>/<id> is accepted.
func checkedTaskDirectory(dir string, root string) string {
	resolved := PathResolve(dir)
	if !SamePath(PathDirname(resolved), root) || !IsTaskId(PathBasename(resolved)) {
		panic(NewAsyncShellError("invalid_directory", "Not an async-shell task directory under "+root+": "+dir))
	}
	return resolved
}

func taskPaths(dir string) TaskPaths {
	file := func(name string) string { return PathJoin(dir, name) }
	return TaskPaths{
		Dir: dir, Task: file("task.json"), State: file("state.json"), Raw: file("raw.log"),
		Filtered: file("output.log"), CaptureOk: file("capture-ok"), Exit: file("exit.json"),
		Cancel: file("cancel.requested"), Closed: file("closed"), Delivery: file("delivery.json"),
		PollCursor: file("poll.cursor"), MonitorPid: file("monitor.pid"), RunnerPid: file("runner.pid"),
		ChildPid: file("child.pid"),
	}
}

func errorCode(err interface{}) string {
	if err == nil {
		return ""
	}
	if e, ok := err.(*AsyncShellError); ok {
		return e.Code
	}
	if ce, ok := err.(interface{ ErrorCode() string }); ok {
		return ce.ErrorCode()
	}
	return ""
}

func messageOf(err interface{}) string {
	if e, ok := err.(error); ok {
		return e.Error()
	}
	return fmt.Sprint(err)
}

func readJson(file string) interface{} {
	var parsed interface{}
	r := caught(func() { parsed = mustParseJson(FsReadFileSync(file)) })
	if r != nil {
		return nil
	}
	return parsed
}

func mustParseJson(text string) interface{} {
	var value interface{}
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		panic(err)
	}
	return value
}

// record is TS `record`: a non-array object.
func record(value interface{}) (map[string]interface{}, bool) {
	m, ok := value.(map[string]interface{})
	return m, ok
}

// jsonStringify is the literal JSON.stringify call site.
// Known behavior-diff for the verification stage: Node does not escape HTML
// characters, while encoding/json does by default. Left explicit rather than
// silently patched during translation.
func jsonStringify(value interface{}) string {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(data)
}

func writeJsonAtomic(file string, value interface{}) {
	temporary := file + "." + formatInt(ProcessPid()) + ".tmp"
	FsWriteFileSync(temporary, []byte(jsonStringify(value)+"\n"), &FileOptions{Mode: uint32Ptr(0o600)})
	FsRenameSync(temporary, file)
}

func readTaskFile(paths TaskPaths) taskFile {
	value := readJson(paths.Task)
	m, ok := record(value)
	if !ok {
		panic(NewAsyncShellError("task_missing", "No async-shell task at "+paths.Dir+"."))
	}
	id, idOK := m["id"].(string)
	argvRaw, argvOK := m["argv"].([]interface{})
	cwd, cwdOK := m["cwd"].(string)
	createdAtRaw, createdOK := m["createdAt"].(float64)
	waitMsRaw, waitOK := m["waitMs"].(float64)
	argv := make([]string, 0, len(argvRaw))
	argvStrings := true
	for _, item := range argvRaw {
		text, ok := item.(string)
		if !ok {
			argvStrings = false
			break
		}
		argv = append(argv, text)
	}
	if !idOK || !argvOK || len(argvRaw) == 0 || !argvStrings || !cwdOK || !createdOK || !waitOK {
		panic(NewAsyncShellError("task_corrupt", "The task file at "+paths.Task+" is not readable."))
	}
	timeoutRaw, hasTimeout := m["timeoutMs"]
	if !hasTimeout {
		panic(NewAsyncShellError("task_corrupt", "The task file at "+paths.Task+" is not readable."))
	}
	var timeoutMs *int64
	if timeoutRaw != nil {
		number, ok := timeoutRaw.(float64)
		if !ok {
			panic(NewAsyncShellError("task_corrupt", "The task file at "+paths.Task+" is not readable."))
		}
		value := int64(number)
		timeoutMs = &value
	}
	return taskFile{ID: id, Argv: argv, Cwd: cwd, CreatedAt: int64(createdAtRaw), WaitMs: int64(waitMsRaw), TimeoutMs: timeoutMs}
}

func readStateFile(paths TaskPaths, task taskFile) taskState {
	value := readJson(paths.State)
	m, ok := record(value)
	if !ok {
		return taskState{ID: task.ID, Status: StatusRunning, ExitCode: nil, CreatedAt: task.CreatedAt, FinalizedAt: nil}
	}
	statusRaw := ""
	if s, ok := m["status"].(string); ok {
		statusRaw = s
	}
	known := statusRaw == "running" || statusRaw == "completed" || statusRaw == "failed" || statusRaw == "cancelled" || statusRaw == "timed_out"
	status := StatusRunning
	if known {
		status = ShellStatus(statusRaw)
	}
	var exitCode *int
	if number, ok := m["exitCode"].(float64); ok {
		v := int(number)
		exitCode = &v
	}
	createdAt := task.CreatedAt
	if number, ok := m["createdAt"].(float64); ok {
		createdAt = int64(number)
	}
	var finalizedAt *int64
	if number, ok := m["finalizedAt"].(float64); ok {
		v := int64(number)
		finalizedAt = &v
	}
	return taskState{ID: task.ID, Status: status, ExitCode: exitCode, CreatedAt: createdAt, FinalizedAt: finalizedAt}
}

func writeState(paths TaskPaths, state taskState) {
	writeJsonAtomic(paths.State, state)
}

// utf8Boundary is TS utf8Boundary: the last complete UTF-8 boundary at or before length.
func utf8Boundary(buffer []byte, length int) int {
	if length <= 0 {
		return 0
	}
	for back := 1; back <= 4 && length-back >= 0; back++ {
		b := buffer[length-back]
		if b < 0x80 {
			return length
		}
		if b >= 0xc0 {
			needed := 2
			if b >= 0xf0 {
				needed = 4
			} else if b >= 0xe0 {
				needed = 3
			}
			if back >= needed {
				return length
			}
			return length - back
		}
	}
	return length
}

func readOutput(file string, cursor int64) OutputChunk {
	handle := 0
	r := caught(func() { handle = FsOpenSync(file, "r") })
	if r != nil {
		if errorCode(r) == "ENOENT" {
			return OutputChunk{Text: "", Cursor: maxInt64(0, cursor), Truncated: false}
		}
		panic(r)
	}
	defer FsCloseSync(handle)
	size := FsFstatSync(handle).Size
	start := minInt64(maxInt64(0, cursor), size)
	if start >= size {
		return OutputChunk{Text: "", Cursor: start, Truncated: false}
	}
	want := minInt64(MaxResultBytes, size-start)
	buffer := make([]byte, int(want))
	read := FsReadSync(handle, buffer, 0, int(want), start)
	length := utf8Boundary(buffer, read)
	next := start + int64(length)
	return OutputChunk{Text: string(buffer[:length]), Cursor: next, Truncated: next < size}
}

func readCursor(paths TaskPaths) int64 {
	var cursor int64
	r := caught(func() {
		value, ok := parseIntPrefix(strings.TrimSpace(FsReadFileSync(paths.PollCursor)))
		if ok && value >= 0 {
			cursor = value
		} else {
			cursor = 0
		}
	})
	if r != nil {
		return 0
	}
	return cursor
}

func hasMore(file string, cursor int64) bool {
	more := false
	r := caught(func() { more = FsStatSync(file).Size > cursor })
	if r != nil {
		return false
	}
	return more
}

func resultOf(paths TaskPaths, state taskState, cursor int64) ShellResult {
	chunk := readOutput(paths.Filtered, cursor)
	return ShellResult{ID: state.ID, Status: state.Status, ExitCode: state.ExitCode, Output: chunk.Text, Cursor: chunk.Cursor, LogPath: paths.Filtered, Truncated: chunk.Truncated}
}

func consumeOutput(paths TaskPaths, state taskState) ShellResult {
	result := resultOf(paths, state, readCursor(paths))
	FsWriteFileSync(paths.PollCursor, []byte(strconv.FormatInt(result.Cursor, 10)+"\n"), &FileOptions{Mode: uint32Ptr(0o600)})
	return result
}

func statusResult(paths TaskPaths, state taskState) ShellResult {
	cursor := readCursor(paths)
	return ShellResult{ID: state.ID, Status: state.Status, ExitCode: state.ExitCode, Output: "", Cursor: cursor, LogPath: paths.Filtered, Truncated: hasMore(paths.Filtered, cursor)}
}

func sleep(ms int) {
	time.Sleep(time.Duration(ms) * time.Millisecond)
}

func alive(pid int) bool {
	err := ProcessKill(pid, "")
	if err == nil {
		return true
	}
	return errorCode(err) == "EPERM"
}

func readPid(file string) *int {
	var pid *int
	r := caught(func() {
		value, ok := parseIntPrefix(strings.TrimSpace(FsReadFileSync(file)))
		if ok && value > 0 {
			v := int(value)
			pid = &v
		}
	})
	if r != nil {
		return nil
	}
	return pid
}

func exists(file string) bool {
	return FsExistsSync(file)
}

func readDelivery(paths TaskPaths, timeoutMs int) string {
	deadline := nowMs() + int64(timeoutMs)
	for {
		value := readJson(paths.Delivery)
		if m, ok := record(value); ok {
			if mode, ok := m["mode"].(string); ok {
				if mode == "sync" {
					return "sync"
				}
				if mode == "async" {
					return "async"
				}
			}
		}
		if nowMs() >= deadline {
			return "async"
		}
		sleep(25)
	}
}

func sendFrame(target CallbackTarget, frame interface{}) {
	if err := WriteSocket(target.Socket, frame); err != nil {
		code := "callback_failed"
		if errorCode(err) == "registration_rejected" {
			code = "registration_rejected"
		}
		panic(NewAsyncShellError(code, "The async-shell host did not accept a frame: "+messageOf(err)))
	}
}

// CallbackFromEnv is TS callbackFromEnv: null keeps the CLI standalone.
func CallbackFromEnv(env map[string]string) *CallbackTarget {
	if unavailable := env["PI_ASYNC_SHELL_HOST_ERROR"]; unavailable != "" {
		panic(NewAsyncShellError("host_unavailable", "The async-shell callback host is unavailable: "+unavailable))
	}
	socket := env["PI_AGENT_SOCKET"]
	token := env["PI_ASYNC_SHELL_TOKEN"]
	if socket == "" || token == "" {
		return nil
	}
	return &CallbackTarget{Socket: socket, Token: token}
}

// CreateTask is TS createTask.
func CreateTask(options CreateTaskOptions) ShellResult {
	assertSupported()
	if len(options.Argv) == 0 {
		panic(NewAsyncShellError("invalid_command_args", "create requires a command."))
	}
	root := StateRoot()
	if err := EnsurePrivateDirectory(root); err != nil {
		panic(err)
	}
	var id string
	var dir string
	for {
		id = "job_" + hexEncode(RandomBytes(4))
		dir = TaskDirectory(id, root)
		r := caught(func() { FsMkdirSync(dir, &MkdirOptions{Mode: uint32Ptr(0o700)}) })
		if r == nil {
			break
		}
		if errorCode(r) != "EEXIST" {
			panic(r)
		}
	}
	if err := EnsurePrivateDirectory(dir); err != nil {
		panic(err)
	}
	paths := taskPaths(dir)
	createdAt := nowMs()
	task := taskFile{ID: id, Argv: options.Argv, Cwd: options.Cwd, CreatedAt: createdAt, WaitMs: options.WaitMs, TimeoutMs: options.TimeoutMs}
	writeJsonAtomic(paths.Task, task)
	FsWriteFileSync(paths.Raw, []byte{}, &FileOptions{Mode: uint32Ptr(0o600)})
	FsWriteFileSync(paths.Filtered, []byte{}, &FileOptions{Mode: uint32Ptr(0o600)})

	if options.Callback != nil {
		r := caught(func() {
			sendFrame(*options.Callback, AsyncShellRegisterFrame{Kind: AsyncShellKind, Token: options.Callback.Token, Operation: "register", ID: id, Directory: dir, PID: ProcessPid()})
		})
		if r != nil {
			state := taskState{ID: id, Status: StatusFailed, ExitCode: nil, CreatedAt: createdAt, FinalizedAt: int64Ptr(nowMs())}
			FsAppendFileSync(paths.Filtered, []byte("async-shell: "+messageOf(r)+"\n"), &FileOptions{Mode: uint32Ptr(0o600)})
			writeState(paths, state)
			FsWriteFileSync(paths.Closed, []byte{}, &FileOptions{Mode: uint32Ptr(0o600)})
			if errorCode(r) != "registration_rejected" {
				_ = caught(func() {
					sendFrame(*options.Callback, AsyncShellCompleteFrame{Kind: AsyncShellKind, Token: options.Callback.Token, Operation: "complete", ID: id, Notify: false, Result: consumeOutput(paths, state)})
				})
			}
			panic(NewAsyncShellError("register_failed", "The async-shell host did not accept the registration of task "+id+": "+messageOf(r)+". The task directory "+dir+" was kept and released; re-running create starts a new task."))
		}
	}

	failed := func(message string) ShellResult {
		backend.KillServer(dir)
		state := taskState{ID: id, Status: StatusFailed, ExitCode: nil, CreatedAt: createdAt, FinalizedAt: int64Ptr(nowMs())}
		FsAppendFileSync(paths.Filtered, []byte("async-shell: "+message+"\n"), &FileOptions{Mode: uint32Ptr(0o600)})
		writeState(paths, state)
		return consumeOutput(paths, state)
	}

	r := caught(func() {
		backend.Start(dir, SelfArgv(dir, "__run"), paths.Raw)
		script := ""
		if argv := ProcessArgv(); len(argv) > 1 {
			script = PathResolve(argv[1])
		}
		monitorArgs := []string{}
		monitorArgs = append(monitorArgs, ProcessExecArgv()...)
		monitorArgs = append(monitorArgs, script, "__monitor", dir)
		monitor := SpawnDetached(ProcessExecPath(), monitorArgs, SpawnDetachedOptions{Detached: true, StdioIgnore: true, Env: ProcessEnv()})
		monitor.Unref()
		if monitor.Pid != nil {
			FsWriteFileSync(paths.MonitorPid, []byte(formatInt(*monitor.Pid)+"\n"), &FileOptions{Mode: uint32Ptr(0o600)})
		}
	})
	if r != nil {
		result := failed(messageOf(r))
		if options.Callback != nil {
			sendFrame(*options.Callback, AsyncShellCompleteFrame{Kind: AsyncShellKind, Token: options.Callback.Token, Operation: "complete", ID: id, Notify: false, Result: result})
		}
		panic(NewAsyncShellError("start_failed", messageOf(r)))
	}

	decide := func(mode string, state taskState) ShellResult {
		result := consumeOutput(paths, state)
		FsWriteFileSync(paths.Delivery, []byte(jsonStringify(map[string]string{"mode": mode})+"\n"), &FileOptions{Mode: uint32Ptr(0o600)})
		return result
	}
	waitDeadline := task.CreatedAt + task.WaitMs
	if task.WaitMs == 0 {
		waitDeadline = task.CreatedAt + StartupWaitMs
	}
	for {
		state := readStateFile(paths, task)
		if state.FinalizedAt != nil {
			return decide("sync", state)
		}
		if task.WaitMs == 0 && exists(paths.ChildPid) {
			return decide("async", state)
		}
		if nowMs() >= waitDeadline {
			return decide("async", state)
		}
		sleep(MonitorTickMs / 2)
	}
}

// PollTask is TS pollTask.
func PollTask(dir string, cursor *int64) ShellResult {
	paths := taskPaths(dir)
	task := readTaskFile(paths)
	state := readStateFile(paths, task)
	if cursor != nil {
		explicit := resultOf(paths, state, *cursor)
		FsWriteFileSync(paths.PollCursor, []byte(strconv.FormatInt(explicit.Cursor, 10)+"\n"), &FileOptions{Mode: uint32Ptr(0o600)})
		return explicit
	}
	return consumeOutput(paths, state)
}

// ReadTask is TS readTask: a replay from cursor (default the beginning); never consumes.
func ReadTask(dir string, cursor *int64) ShellResult {
	paths := taskPaths(dir)
	task := readTaskFile(paths)
	from := int64(0)
	if cursor != nil {
		from = *cursor
	}
	return resultOf(paths, readStateFile(paths, task), from)
}

func requireRunning(paths TaskPaths) taskFile {
	task := readTaskFile(paths)
	if readStateFile(paths, task).Status != StatusRunning {
		panic(NewAsyncShellError("task_finished", "Task "+task.ID+" is no longer running."))
	}
	return task
}

// SendInput is TS sendInput.
func SendInput(dir string, input string, enter bool) {
	paths := taskPaths(dir)
	requireRunning(paths)
	if BufferByteLength(input, "utf8") > MaxSendBytes {
		panic(NewAsyncShellError("input_too_large", "Input must not exceed "+formatInt(MaxSendBytes)+" bytes."))
	}
	backend.SendInput(dir, input)
	if enter {
		backend.SendKey(dir, "Enter")
	}
}

var keyPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,32}$`)

// SendKey is TS sendKey.
func SendKey(dir string, key string) {
	paths := taskPaths(dir)
	requireRunning(paths)
	if !keyPattern.MatchString(key) {
		panic(NewAsyncShellError("invalid_key", "Not a tmux key name: "+key))
	}
	backend.SendKey(dir, key)
}

// CancelTask is TS cancelTask; root defaults to stateRoot().
func CancelTask(dir string, rootArg ...string) {
	root := ""
	if len(rootArg) > 0 {
		root = rootArg[0]
	} else {
		root = StateRoot()
	}
	paths := taskPaths(checkedTaskDirectory(dir, root))
	if exists(paths.Closed) {
		return
	}
	task := readTaskFile(paths)
	FsWriteFileSync(paths.Cancel, []byte{}, &FileOptions{Mode: uint32Ptr(0o600)})
	backend.KillServer(paths.Dir)
	if waitForClose(paths, 400) {
		return
	}
	if backend.ServerRunning(paths.Dir) {
		panic(NewAsyncShellError("cancel_incomplete", "The multiplexer server of task "+task.ID+" did not stop."))
	}

	// The monitor is the only finalizer; only signal a pid that proves it is ours.
	monitorPid := readPid(paths.MonitorPid)
	ours := monitorPid != nil && alive(*monitorPid) && backend.OwnsProcess(*monitorPid, "__monitor", paths.Dir)
	if ours && waitForClose(paths, CancelWaitMs) {
		return
	}
	if ours && monitorPid != nil {
		_ = caught(func() { _ = ProcessKill(*monitorPid, "SIGKILL") })
		if waitForClose(paths, 2000) {
			return
		}
	}
	if waitForClose(paths, 200) {
		return
	}

	if backend.ServerRunning(paths.Dir) {
		panic(NewAsyncShellError("cancel_incomplete", "The multiplexer server of task "+task.ID+" is still running."))
	}
	if monitorPid != nil && alive(*monitorPid) && backend.OwnsProcess(*monitorPid, "__monitor", paths.Dir) {
		panic(NewAsyncShellError("cancel_incomplete", "The monitor of task "+task.ID+" did not report cleanup."))
	}

	state := readStateFile(paths, task)
	if state.Status == StatusRunning {
		writeState(paths, taskState{ID: task.ID, Status: StatusCancelled, ExitCode: nil, CreatedAt: task.CreatedAt, FinalizedAt: int64Ptr(nowMs())})
	}
	FsWriteFileSync(paths.Closed, []byte{}, &FileOptions{Mode: uint32Ptr(0o600)})
}

func waitForClose(paths TaskPaths, timeoutMs int) bool {
	deadline := nowMs() + int64(timeoutMs)
	for nowMs() < deadline {
		if exists(paths.Closed) {
			return true
		}
		sleep(MonitorTickMs)
	}
	return exists(paths.Closed)
}

func writeExit(paths TaskPaths, exit exitFile) {
	_ = caught(func() { writeJsonAtomic(paths.Exit, exit) })
}

// RunnerMain is TS runnerMain: the pane process that waits for capture, then runs.
func RunnerMain(dir string) int {
	paths := taskPaths(dir)
	task := readTaskFile(paths)
	FsWriteFileSync(paths.RunnerPid, []byte(formatInt(ProcessPid())+"\n"), &FileOptions{Mode: uint32Ptr(0o600)})

	captureDeadline := nowMs() + CaptureWaitMs
	for !exists(paths.CaptureOk) {
		if nowMs() > captureDeadline {
			writeExit(paths, exitFile{Code: nil, Signal: nil, Error: strPtr("capture did not start")})
			return 1
		}
		ProcessStdoutWrite(CaptureMarker)
		sleep(40)
	}

	var child ChildProcess
	r := caught(func() {
		command := ChildCommandFor(task.Argv, ProcessPlatform(), ProcessEnv(), task.Cwd)
		child = SpawnInherit(command.File, command.Args, SpawnInheritOptions{Cwd: task.Cwd, Env: ProcessEnv(), StdioInherit: true, WindowsVerbatimArguments: command.Verbatim})
	})
	if r != nil {
		writeExit(paths, exitFile{Code: nil, Signal: nil, Error: strPtr(messageOf(r))})
		return 1
	}
	if child.Pid != nil {
		FsWriteFileSync(paths.ChildPid, []byte(formatInt(*child.Pid)+"\n"), &FileOptions{Mode: uint32Ptr(0o600)})
	}

	stopped := func(signal string) {
		if child.Pid != nil {
			_ = caught(func() { child.Kill("SIGTERM") })
		}
		writeExit(paths, exitFile{Code: nil, Signal: &signal, Error: nil})
		sleep(150)
		ProcessExit(0)
	}
	ProcessOnSignal("SIGTERM", stopped)
	ProcessOnSignal("SIGHUP", stopped)
	ProcessOnSignal("SIGINT", stopped)

	child.OnceExit(func(code *int, signal *string) { writeExit(paths, exitFile{Code: code, Signal: signal, Error: nil}) })
	child.OnceError(func(err error) { writeExit(paths, exitFile{Code: nil, Signal: nil, Error: strPtr(messageOf(err))}) })
	return child.Wait()
}

// MonitorMain is TS monitorMain: the detached per-task monitor.
func MonitorMain(dir string) {
	paths := taskPaths(dir)
	if exists(paths.Closed) {
		return
	}
	task := readTaskFile(paths)
	writeState(paths, taskState{ID: task.ID, Status: StatusRunning, ExitCode: nil, CreatedAt: task.CreatedAt, FinalizedAt: nil})

	filter := NewOutputFilter()
	var rawOffset int64
	probe := ""
	captureOk := false
	lastGrowth := nowMs()
	lastFlush := nowMs()
	cancelled := false
	timedOut := false
	closing := false

	pump := func() bool {
		handle := 0
		r := caught(func() { handle = FsOpenSync(paths.Raw, "r") })
		if r != nil {
			return false
		}
		defer FsCloseSync(handle)
		grew := false
		size := FsFstatSync(handle).Size
		for {
			if rawOffset >= size {
				break
			}
			want := minInt64(ReadChunkBytes, size-rawOffset)
			buffer := make([]byte, int(want))
			read := FsReadSync(handle, buffer, 0, int(want), rawOffset)
			if read <= 0 {
				break
			}
			rawOffset += int64(read)
			grew = true
			chunk := buffer[:read]
			probe = lastN(probe+string(chunk), 256)
			if !captureOk && strings.Contains(probe, CaptureMarker) {
				captureOk = true
				FsWriteFileSync(paths.CaptureOk, []byte{}, &FileOptions{Mode: uint32Ptr(0o600)})
			}
			text := filter.Write(chunk)
			if text != "" {
				FsAppendFileSync(paths.Filtered, []byte(text), &FileOptions{Mode: uint32Ptr(0o600)})
			}
		}
		return grew
	}

	flushPending := func(force bool) {
		if !force && (nowMs()-lastGrowth < QuietFlushMs || nowMs()-lastFlush < QuietFlushMs) {
			return
		}
		text := filter.Flush()
		if text != "" {
			FsAppendFileSync(paths.Filtered, []byte(text), &FileOptions{Mode: uint32Ptr(0o600)})
		}
		lastFlush = nowMs()
	}

	paneAlive := func() bool { return !backend.PaneGone(dir) }

	finish := func() {
		startedAt := nowMs()
		quietSince := nowMs()
		nextProbe := int64(0)
		for {
			if pump() {
				quietSince = nowMs()
			}
			if nowMs()-quietSince >= DrainQuietMs {
				busy := false
				if nowMs() >= nextProbe {
					nextProbe = nowMs() + 200
					busy = paneAlive()
				}
				if !busy {
					break
				}
			}
			if nowMs()-startedAt > DrainLimitMs {
				break
			}
			sleep(25)
		}
		pump()
		flushPending(true)

		status := StatusFailed
		var exitCode *int
		if cancelled {
			status = StatusCancelled
		} else if timedOut {
			status = StatusTimedOut
		} else if exit := asExitFile(readJson(paths.Exit)); exit != nil {
			if exit.Code != nil {
				exitCode = exit.Code
			}
			if exit.Error == nil && exitCode != nil && *exitCode == 0 && exit.Signal == nil {
				status = StatusCompleted
			} else {
				status = StatusFailed
			}
			if exit.Error != nil {
				FsAppendFileSync(paths.Filtered, []byte("async-shell: "+*exit.Error+"\n"), &FileOptions{Mode: uint32Ptr(0o600)})
			}
			if exit.Signal != nil {
				FsAppendFileSync(paths.Filtered, []byte("async-shell: terminated by "+*exit.Signal+"\n"), &FileOptions{Mode: uint32Ptr(0o600)})
			}
		} else {
			FsAppendFileSync(paths.Filtered, []byte("async-shell: the task exited without reporting a status\n"), &FileOptions{Mode: uint32Ptr(0o600)})
		}

		finalizedAt := nowMs()
		state := taskState{ID: task.ID, Status: status, ExitCode: exitCode, CreatedAt: task.CreatedAt, FinalizedAt: int64Ptr(finalizedAt)}
		writeState(paths, state)
		backend.KillServer(dir)

		callback := CallbackFromEnv(ProcessEnv())
		if callback != nil {
			decision := readDelivery(paths, DecisionWaitMs)
			result := statusResult(paths, state)
			if decision == "async" {
				result = consumeOutput(paths, state)
			}
			_ = caught(func() {
				sendFrame(*callback, AsyncShellCompleteFrame{Kind: AsyncShellKind, Token: callback.Token, Operation: "complete", ID: task.ID, Notify: decision == "async", Result: result})
			})
		}
		FsWriteFileSync(paths.Closed, []byte{}, &FileOptions{Mode: uint32Ptr(0o600)})
	}

	for {
		if pump() {
			lastGrowth = nowMs()
		} else {
			flushPending(false)
		}

		if exists(paths.Cancel) {
			cancelled = true
		}
		if !cancelled && task.TimeoutMs != nil && nowMs() >= task.CreatedAt+*task.TimeoutMs {
			timedOut = true
		}
		if (cancelled || timedOut) && !closing {
			closing = true
			backend.KillServer(dir)
		}

		if !closing {
			exitValue := readJson(paths.Exit)
			reported := false
			if m, ok := record(exitValue); ok {
				_, reported = m["code"]
			}
			runnerPid := readPid(paths.RunnerPid)
			runnerGone := runnerPid != nil && !alive(*runnerPid) && !reported
			if reported || runnerGone {
				closing = true
			}
		}
		if closing {
			finish()
			return
		}
		sleep(MonitorTickMs)
	}
}

func asExitFile(value interface{}) *exitFile {
	m, ok := record(value)
	if !ok {
		return nil
	}
	if _, has := m["code"]; !has {
		return nil
	}
	exit := exitFile{}
	if number, ok := m["code"].(float64); ok {
		v := int(number)
		exit.Code = &v
	}
	if signal, ok := m["signal"].(string); ok {
		exit.Signal = &signal
	}
	if message, ok := m["error"].(string); ok {
		exit.Error = &message
	}
	return &exit
}

// ---- local helpers (direct language mappings) ----

func caught(fn func()) (recovered interface{}) {
	defer func() { recovered = recover() }()
	fn()
	return nil
}

func nowMs() int64 { return time.Now().UnixMilli() }

func minInt64(left int64, right int64) int64 {
	if left < right {
		return left
	}
	return right
}

func maxInt64(left int64, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

func lastN(value string, count int) string {
	if len(value) <= count {
		return value
	}
	return value[len(value)-count:]
}

func uint32Ptr(value uint32) *uint32 { return &value }

func strPtr(value string) *string { return &value }
