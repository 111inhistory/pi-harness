package asyncshell

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"pijob/internal/asyncshell/aserr"
	shellbackend "pijob/internal/asyncshell/backend"
	"pijob/internal/asyncshell/private"
	"pijob/internal/asyncshell/proc"
)

// tmux.go translates src/async-shell/tmux.ts: the shared async-shell task engine.
//
// Async/await mapping: every `await` in the source is consumed immediately, so the
// literal Go translation is a synchronous (blocking) call in the same order. The
// child_process event seams (OnceExit/OnceError + Wait) stay explicit in seams.go.
//
// throw -> panic(AsyncShellError); try/catch -> caught(func(){...}) (defer/recover).

// backend is tmux.ts's per-platform backend selection.
var backend shellbackend.ShellBackend = shellbackend.Default()

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
	ID        string   `json:"id"`
	Argv      []string `json:"argv"`
	Cwd       string   `json:"cwd"`
	CreatedAt int64    `json:"createdAt"`
	WaitMs    int64    `json:"waitMs"`
	TimeoutMs *int64   `json:"timeoutMs"`
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
	root := os.Getenv("PI_ASYNC_SHELL_ROOT")
	if root == "" {
		uid := os.Getuid()
		if uid < 0 {
			uid = 0
		}
		root = filepath.Join(os.TempDir(), "pi-async-shell-"+strconv.Itoa(uid))
	}
	resolved, err := filepath.Abs(root)
	if err != nil {
		panic(err)
	}
	return resolved
}

// TaskDirectory is TS taskDirectory.
func taskDirectory(id string, root string) string {
	if !IsTaskId(id) {
		panic(aserr.New("invalid_id", "Not an async-shell task id: "+id))
	}
	return filepath.Join(root, id)
}

// checkedTaskDirectory is TS checkedTaskDirectory: only <root>/<id> is accepted.
func checkedTaskDirectory(dir string, root string) string {
	resolved, err := filepath.Abs(dir)
	if err != nil {
		panic(err)
	}
	if !samePath(filepath.Dir(resolved), root) || !IsTaskId(filepath.Base(resolved)) {
		panic(aserr.New("invalid_directory", "Not an async-shell task directory under "+root+": "+dir))
	}
	return resolved
}

func taskPaths(dir string) TaskPaths {
	file := func(name string) string { return filepath.Join(dir, name) }
	return TaskPaths{
		Dir: dir, Task: file("task.json"), State: file("state.json"), Raw: file("raw.log"),
		Filtered: file("output.log"), CaptureOk: file("capture-ok"), Exit: file("exit.json"),
		Cancel: file("cancel.requested"), Closed: file("closed"), Delivery: file("delivery.json"),
		PollCursor: file("poll.cursor"), MonitorPid: file("monitor.pid"), RunnerPid: file("runner.pid"),
		ChildPid: file("child.pid"),
	}
}

func environ() map[string]string {
	env := make(map[string]string)
	for _, entry := range os.Environ() {
		if index := strings.IndexByte(entry, '='); index >= 0 {
			env[entry[:index]] = entry[index+1:]
		}
	}
	return env
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func writePrivateFile(path string, data []byte) {
	if err := os.WriteFile(path, data, 0o600); err != nil {
		panic(err)
	}
}

func appendPrivateFile(path string, data []byte) {
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		panic(err)
	}
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		panic(err)
	}
}

func messageOf(err interface{}) string {
	if e, ok := err.(error); ok {
		return e.Error()
	}
	return fmt.Sprint(err)
}

func readJson(file string) interface{} {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	var parsed interface{}
	if json.Unmarshal(data, &parsed) != nil {
		return nil
	}
	return parsed
}

// record is TS `record`: a non-array object.
func record(value interface{}) (map[string]interface{}, bool) {
	m, ok := value.(map[string]interface{})
	return m, ok
}

func writeJsonAtomic(file string, value interface{}) {
	temporary := file + "." + strconv.Itoa(os.Getpid()) + ".tmp"
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(temporary, append(data, '\n'), 0o600); err != nil {
		panic(err)
	}
	if err := os.Rename(temporary, file); err != nil {
		panic(err)
	}
}

func readTaskFile(paths TaskPaths) taskFile {
	value := readJson(paths.Task)
	m, ok := record(value)
	if !ok {
		panic(aserr.New("task_missing", "No async-shell task at "+paths.Dir+"."))
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
		panic(aserr.New("task_corrupt", "The task file at "+paths.Task+" is not readable."))
	}
	timeoutRaw, hasTimeout := m["timeoutMs"]
	if !hasTimeout {
		panic(aserr.New("task_corrupt", "The task file at "+paths.Task+" is not readable."))
	}
	var timeoutMs *int64
	if timeoutRaw != nil {
		number, ok := timeoutRaw.(float64)
		if !ok {
			panic(aserr.New("task_corrupt", "The task file at "+paths.Task+" is not readable."))
		}
		value := int64(number)
		timeoutMs = &value
	}
	return taskFile{ID: id, Argv: argv, Cwd: cwd, CreatedAt: int64(createdAtRaw), WaitMs: int64(waitMsRaw), TimeoutMs: timeoutMs}
}

func safeReadTask(paths TaskPaths) taskFile {
	var task taskFile
	_ = caught(func() { task = readTaskFile(paths) })
	if task.ID == "" {
		task.ID = filepath.Base(paths.Dir)
	}
	if task.CreatedAt == 0 {
		task.CreatedAt = nowMs()
	}
	return task
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
	handle, err := os.Open(file)
	if err != nil {
		if os.IsNotExist(err) {
			return OutputChunk{Text: "", Cursor: maxInt64(0, cursor), Truncated: false}
		}
		panic(err)
	}
	defer handle.Close()
	info, err := handle.Stat()
	if err != nil {
		panic(err)
	}
	size := info.Size()
	start := minInt64(maxInt64(0, cursor), size)
	if start >= size {
		return OutputChunk{Text: "", Cursor: start, Truncated: false}
	}
	want := minInt64(MaxResultBytes, size-start)
	buffer := make([]byte, int(want))
	read, _ := handle.ReadAt(buffer, start)
	length := utf8Boundary(buffer, read)
	next := start + int64(length)
	return OutputChunk{Text: string(buffer[:length]), Cursor: next, Truncated: next < size}
}

func readCursor(paths TaskPaths) int64 {
	data, err := os.ReadFile(paths.PollCursor)
	if err != nil {
		return 0
	}
	value, ok := parseIntPrefix(strings.TrimSpace(string(data)))
	if ok && value >= 0 {
		return value
	}
	return 0
}

func hasMore(file string, cursor int64) bool {
	info, err := os.Stat(file)
	if err != nil {
		return false
	}
	return info.Size() > cursor
}

func resultOf(paths TaskPaths, state taskState, cursor int64) ShellResult {
	chunk := readOutput(paths.Filtered, cursor)
	return ShellResult{ID: state.ID, Status: state.Status, ExitCode: state.ExitCode, Output: chunk.Text, Cursor: chunk.Cursor, LogPath: paths.Filtered, Truncated: chunk.Truncated}
}

func consumeOutput(paths TaskPaths, state taskState) ShellResult {
	result := resultOf(paths, state, readCursor(paths))
	writePrivateFile(paths.PollCursor, []byte(strconv.FormatInt(result.Cursor, 10)+"\n"))
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
	err := proc.Kill(pid, "")
	if err == nil {
		return true
	}
	return aserr.Code(err) == "EPERM"
}

func readPid(file string) *int {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	value, ok := parseIntPrefix(strings.TrimSpace(string(data)))
	if ok && value > 0 {
		pid := int(value)
		return &pid
	}
	return nil
}

func exists(file string) bool {
	return fileExists(file)
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

func sendFrame(target CallbackTarget, frame interface{}) error {
	if err := writeSocket(target.Socket, frame); err != nil {
		code := "callback_failed"
		if aserr.Code(err) == "registration_rejected" {
			code = "registration_rejected"
		}
		return aserr.New(code, "The async-shell host did not accept a frame: "+messageOf(err))
	}
	return nil
}

// CallbackFromEnv is TS callbackFromEnv: null keeps the CLI standalone.
func CallbackFromEnv() *CallbackTarget {
	if unavailable := os.Getenv("PI_ASYNC_SHELL_HOST_ERROR"); unavailable != "" {
		panic(aserr.New("host_unavailable", "The async-shell callback host is unavailable: "+unavailable))
	}
	socket := os.Getenv("PI_AGENT_SOCKET")
	token := os.Getenv("PI_ASYNC_SHELL_TOKEN")
	if socket == "" || token == "" {
		return nil
	}
	return &CallbackTarget{Socket: socket, Token: token}
}

// CreateTask is TS createTask.
func createTask(options CreateTaskOptions) ShellResult {
	assertSupported()
	if len(options.Argv) == 0 {
		panic(aserr.New("invalid_command_args", "create requires a command."))
	}
	root := StateRoot()
	if err := private.EnsureDirectory(root); err != nil {
		panic(err)
	}
	var id string
	var dir string
	for {
		entropy := make([]byte, 4)
		if _, err := rand.Read(entropy); err != nil {
			panic(err)
		}
		id = "job_" + hexEncode(entropy)
		dir = taskDirectory(id, root)
		err := os.Mkdir(dir, 0o700)
		if err == nil {
			break
		}
		if !os.IsExist(err) {
			panic(err)
		}
	}
	if err := private.EnsureDirectory(dir); err != nil {
		panic(err)
	}
	paths := taskPaths(dir)
	createdAt := nowMs()
	task := taskFile{ID: id, Argv: options.Argv, Cwd: options.Cwd, CreatedAt: createdAt, WaitMs: options.WaitMs, TimeoutMs: options.TimeoutMs}
	writeJsonAtomic(paths.Task, task)
	writePrivateFile(paths.Raw, nil)
	writePrivateFile(paths.Filtered, nil)

	if options.Callback != nil {
		r := sendFrame(*options.Callback, AsyncShellRegisterFrame{Kind: AsyncShellKind, Token: options.Callback.Token, Operation: "register", ID: id, Directory: dir, PID: os.Getpid()})
		if r != nil {
			state := taskState{ID: id, Status: StatusFailed, ExitCode: nil, CreatedAt: createdAt, FinalizedAt: int64Ptr(nowMs())}
			appendPrivateFile(paths.Filtered, []byte("async-shell: "+messageOf(r)+"\n"))
			writeState(paths, state)
			writePrivateFile(paths.Closed, nil)
			if aserr.Code(r) != "registration_rejected" {
				_ = sendFrame(*options.Callback, AsyncShellCompleteFrame{Kind: AsyncShellKind, Token: options.Callback.Token, Operation: "complete", ID: id, Notify: false, Result: consumeOutput(paths, state)})
			}
			panic(aserr.New("register_failed", "The async-shell host did not accept the registration of task "+id+": "+messageOf(r)+". The task directory "+dir+" was kept and released; re-running create starts a new task."))
		}
	}

	failed := func(message string) ShellResult {
		backend.KillServer(dir)
		state := taskState{ID: id, Status: StatusFailed, ExitCode: nil, CreatedAt: createdAt, FinalizedAt: int64Ptr(nowMs())}
		appendPrivateFile(paths.Filtered, []byte("async-shell: "+message+"\n"))
		writeState(paths, state)
		return consumeOutput(paths, state)
	}

	r := caught(func() {
		selfArgv, selfErr := SelfArgv(dir, "__run")
		if selfErr != nil {
			panic(selfErr)
		}
		backend.Start(dir, selfArgv, paths.Raw)
		// Go equivalent of node execPath + execArgv + script: the binary re-runs
		// itself with the internal mode and the task directory.
		monitorArgs := []string{"__monitor", dir}
		executable, err := os.Executable()
		if err != nil {
			panic(err)
		}
		monitorPid, startErr := proc.StartDetached(executable, monitorArgs, nil)
		if startErr != nil {
			panic(startErr)
		}
		if monitorPid != nil {
			writePrivateFile(paths.MonitorPid, []byte(strconv.Itoa(*monitorPid)+"\n"))
		}
	})
	if r != nil {
		result := failed(messageOf(r))
		if options.Callback != nil {
			if sendErr := sendFrame(*options.Callback, AsyncShellCompleteFrame{Kind: AsyncShellKind, Token: options.Callback.Token, Operation: "complete", ID: id, Notify: false, Result: result}); sendErr != nil {
				panic(sendErr)
			}
		}
		panic(aserr.New("start_failed", messageOf(r)))
	}

	decide := func(mode string, state taskState) ShellResult {
		result := consumeOutput(paths, state)
		delivery, err := json.Marshal(map[string]string{"mode": mode})
		if err != nil {
			panic(err)
		}
		writePrivateFile(paths.Delivery, append(delivery, '\n'))
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
func pollTask(dir string, cursor *int64) ShellResult {
	paths := taskPaths(dir)
	task := readTaskFile(paths)
	state := readStateFile(paths, task)
	if cursor != nil {
		explicit := resultOf(paths, state, *cursor)
		writePrivateFile(paths.PollCursor, []byte(strconv.FormatInt(explicit.Cursor, 10)+"\n"))
		return explicit
	}
	return consumeOutput(paths, state)
}

// ReadTask is TS readTask: a replay from cursor (default the beginning); never consumes.
func readTask(dir string, cursor *int64) ShellResult {
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
		panic(aserr.New("task_finished", "Task "+task.ID+" is no longer running."))
	}
	return task
}

// SendInput is TS sendInput.
func sendInput(dir string, input string, enter bool) {
	paths := taskPaths(dir)
	requireRunning(paths)
	if len([]byte(input)) > MaxSendBytes {
		panic(aserr.New("input_too_large", "Input must not exceed "+formatInt(MaxSendBytes)+" bytes."))
	}
	backend.SendInput(dir, input)
	if enter {
		backend.SendKey(dir, "Enter")
	}
}

var keyPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,32}$`)

// SendKey is TS sendKey.
func sendKey(dir string, key string) {
	paths := taskPaths(dir)
	requireRunning(paths)
	if !keyPattern.MatchString(key) {
		panic(aserr.New("invalid_key", "Not a tmux key name: "+key))
	}
	backend.SendKey(dir, key)
}

// CancelTask is TS cancelTask; root defaults to stateRoot().
func cancelTask(dir string, rootArg ...string) {
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
	writePrivateFile(paths.Cancel, nil)
	backend.KillServer(paths.Dir)
	if waitForClose(paths, 400) {
		return
	}
	if backend.ServerRunning(paths.Dir) {
		panic(aserr.New("cancel_incomplete", "The multiplexer server of task "+task.ID+" did not stop."))
	}

	// The monitor is the only finalizer; only signal a pid that proves it is ours.
	monitorPid := readPid(paths.MonitorPid)
	ours := monitorPid != nil && alive(*monitorPid) && backend.OwnsProcess(*monitorPid, "__monitor", paths.Dir)
	if ours && waitForClose(paths, CancelWaitMs) {
		return
	}
	if ours && monitorPid != nil {
		_ = caught(func() { _ = proc.Kill(*monitorPid, "SIGKILL") })
		if waitForClose(paths, 2000) {
			return
		}
	}
	if waitForClose(paths, 200) {
		return
	}

	if backend.ServerRunning(paths.Dir) {
		panic(aserr.New("cancel_incomplete", "The multiplexer server of task "+task.ID+" is still running."))
	}
	if monitorPid != nil && alive(*monitorPid) && backend.OwnsProcess(*monitorPid, "__monitor", paths.Dir) {
		panic(aserr.New("cancel_incomplete", "The monitor of task "+task.ID+" did not report cleanup."))
	}

	state := readStateFile(paths, task)
	if state.Status == StatusRunning {
		writeState(paths, taskState{ID: task.ID, Status: StatusCancelled, ExitCode: nil, CreatedAt: task.CreatedAt, FinalizedAt: int64Ptr(nowMs())})
	}
	writePrivateFile(paths.Closed, nil)
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
// A panic here would otherwise kill the command with no status; the boundary
// reports it through exit.json so the monitor can finalize a failure.
func RunnerMain(dir string) (exit int) {
	paths := taskPaths(dir)
	defer func() {
		if recovered := recover(); recovered != nil {
			message := "internal error: " + messageOf(recovered)
			_ = caught(func() { writeExit(paths, exitFile{Code: nil, Signal: nil, Error: strPtr(message)}) })
			os.Stderr.WriteString("pi-job: " + message + "\n")
			exit = 1
		}
	}()
	task := readTaskFile(paths)
	writePrivateFile(paths.RunnerPid, []byte(strconv.Itoa(os.Getpid())+"\n"))

	captureDeadline := nowMs() + CaptureWaitMs
	for !exists(paths.CaptureOk) {
		if nowMs() > captureDeadline {
			writeExit(paths, exitFile{Code: nil, Signal: nil, Error: strPtr("capture did not start")})
			return 1
		}
		os.Stdout.WriteString(CaptureMarker)
		sleep(40)
	}

	var child *exec.Cmd
	r := caught(func() {
		command, commandErr := proc.ChildCommandFor(task.Argv, environ(), task.Cwd)
		if commandErr != nil {
			panic(commandErr)
		}
		child = exec.Command(command.File, command.Args...)
		child.Stdin = os.Stdin
		child.Stdout = os.Stdout
		child.Stderr = os.Stderr
		child.Dir = task.Cwd
		if command.Verbatim {
			proc.ApplyVerbatim(child, command.File, command.Args)
		}
		if err := child.Start(); err != nil {
			panic(err)
		}
	})
	if r != nil {
		writeExit(paths, exitFile{Code: nil, Signal: nil, Error: strPtr(messageOf(r))})
		return 1
	}
	if child.Process != nil {
		writePrivateFile(paths.ChildPid, []byte(strconv.Itoa(child.Process.Pid)+"\n"))
	}

	stopped := func(signal string) {
		if child.Process != nil {
			_ = caught(func() { _ = child.Process.Signal(proc.TerminateSignal()) })
		}
		writeExit(paths, exitFile{Code: nil, Signal: &signal, Error: nil})
		sleep(150)
		os.Exit(0)
	}
	proc.InstallStopHandlers(stopped)

	waitErr := child.Wait()
	state := child.ProcessState
	if state == nil {
		writeExit(paths, exitFile{Code: nil, Signal: nil, Error: strPtr(messageOf(waitErr))})
		return 1
	}
	code, signal := proc.DescribeExit(state)
	writeExit(paths, exitFile{Code: code, Signal: signal, Error: nil})
	return 0
}

// MonitorMain is TS monitorMain: the detached per-task monitor. A panic is
// reported as a failed completion frame (never silent): the boundary records the
// failure on disk and attempts one `complete` with notify=true, unless a frame
// was already attempted (unknown delivery is never replayed).
func MonitorMain(dir string) {
	paths := taskPaths(dir)
	frameAttempted := false
	closedWritten := false
	var task taskFile
	defer func() {
		if recovered := recover(); recovered != nil {
			safe := safeReadTask(paths)
			message := "internal error: " + messageOf(recovered)
			_ = caught(func() {
				appendPrivateFile(paths.Filtered, []byte("async-shell: "+message+"\n"))
			})
			state := taskState{ID: safe.ID, Status: StatusFailed, ExitCode: nil, CreatedAt: safe.CreatedAt, FinalizedAt: int64Ptr(nowMs())}
			_ = caught(func() {
				current := readStateFile(paths, safe)
				if current.Status == StatusRunning || current.FinalizedAt == nil {
					writeState(paths, state)
				} else {
					state = current
				}
			})
			_ = caught(func() { backend.KillServer(dir) })
			// TODO(harness-protocol): the TypeScript reference had no
			// monitor-internal-error category, and ShellResult carries no
			// error/reason field. A panic is therefore reported as
			// status=failed with the detail only in output.log; it is not
			// structurally distinguishable from a command failure. Coordinate
			// with the Harness protocol/host (validateAsyncShellFrame /
			// AsyncShellHost) before adding a structured failure reason or a
			// distinct status.
			if !frameAttempted {
				var callback *CallbackTarget
				_ = caught(func() { callback = CallbackFromEnv() })
				if callback != nil {
					frameAttempted = true
					var result ShellResult
					_ = caught(func() { result = statusResult(paths, state) })
					_ = sendFrame(*callback, AsyncShellCompleteFrame{Kind: AsyncShellKind, Token: callback.Token, Operation: "complete", ID: state.ID, Notify: true, Result: result})
				}
			}
			if !closedWritten {
				closedWritten = true
				_ = caught(func() { writePrivateFile(paths.Closed, nil) })
			}
		}
	}()
	if exists(paths.Closed) {
		return
	}
	task = readTaskFile(paths)
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
		handle, err := os.Open(paths.Raw)
		if err != nil {
			return false
		}
		defer handle.Close()
		grew := false
		info, err := handle.Stat()
		if err != nil {
			return false
		}
		size := info.Size()
		for {
			if rawOffset >= size {
				break
			}
			want := minInt64(ReadChunkBytes, size-rawOffset)
			buffer := make([]byte, int(want))
			read, _ := handle.ReadAt(buffer, rawOffset)
			if read <= 0 {
				break
			}
			rawOffset += int64(read)
			grew = true
			chunk := buffer[:read]
			probe = lastN(probe+string(chunk), 256)
			if !captureOk && strings.Contains(probe, CaptureMarker) {
				captureOk = true
				writePrivateFile(paths.CaptureOk, nil)
			}
			text := filter.Write(chunk)
			if text != "" {
				appendPrivateFile(paths.Filtered, []byte(text))
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
			appendPrivateFile(paths.Filtered, []byte(text))
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
				appendPrivateFile(paths.Filtered, []byte("async-shell: "+*exit.Error+"\n"))
			}
			if exit.Signal != nil {
				appendPrivateFile(paths.Filtered, []byte("async-shell: terminated by "+*exit.Signal+"\n"))
			}
		} else {
			appendPrivateFile(paths.Filtered, []byte("async-shell: the task exited without reporting a status\n"))
		}

		finalizedAt := nowMs()
		state := taskState{ID: task.ID, Status: status, ExitCode: exitCode, CreatedAt: task.CreatedAt, FinalizedAt: int64Ptr(finalizedAt)}
		writeState(paths, state)
		backend.KillServer(dir)

		callback := CallbackFromEnv()
		if callback != nil {
			decision := readDelivery(paths, DecisionWaitMs)
			result := statusResult(paths, state)
			if decision == "async" {
				result = consumeOutput(paths, state)
			}
			frameAttempted = true
			_ = sendFrame(*callback, AsyncShellCompleteFrame{Kind: AsyncShellKind, Token: callback.Token, Operation: "complete", ID: task.ID, Notify: decision == "async", Result: result})
		}
		writePrivateFile(paths.Closed, nil)
		closedWritten = true
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

func strPtr(value string) *string { return &value }

// Public entry points return errors. They are the only bridge that converts a
// remaining engine panic into an error; the CLI formats it at Main.
func TaskDirectory(id string, root string) (directory string, err error) {
	defer aserr.Recover(&err)
	directory = taskDirectory(id, root)
	return directory, nil
}

func CreateTask(options CreateTaskOptions) (result ShellResult, err error) {
	defer aserr.Recover(&err)
	result = createTask(options)
	return result, nil
}

func PollTask(dir string, cursor *int64) (result ShellResult, err error) {
	defer aserr.Recover(&err)
	result = pollTask(dir, cursor)
	return result, nil
}

func ReadTask(dir string, cursor *int64) (result ShellResult, err error) {
	defer aserr.Recover(&err)
	result = readTask(dir, cursor)
	return result, nil
}

func SendInput(dir string, input string, enter bool) (err error) {
	defer aserr.Recover(&err)
	sendInput(dir, input, enter)
	return nil
}

func SendKey(dir string, key string) (err error) {
	defer aserr.Recover(&err)
	sendKey(dir, key)
	return nil
}

func CancelTask(dir string, rootArg ...string) (err error) {
	defer aserr.Recover(&err)
	cancelTask(dir, rootArg...)
	return nil
}
