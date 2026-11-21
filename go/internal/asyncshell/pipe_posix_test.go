//go:build !windows

package asyncshell

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"testing"
	"time"
)

// hostResult runs `pi-job __host ...` and decodes the one JSON result line.
func hostResult(t *testing.T, binary string, root string, stdin string, extraEnv []string, args ...string) (ShellResult, string, error) {
	t.Helper()
	command := exec.Command(binary, append([]string{"__host"}, args...)...)
	command.Env = append(cliEnvironment(root), extraEnv...)
	if stdin != "" {
		command.Stdin = bytes.NewBufferString(stdin)
	}
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	var result ShellResult
	if err == nil {
		if decodeErr := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &result); decodeErr != nil {
			t.Fatalf("not one JSON result: %v\nstdout=%s\nstderr=%s", decodeErr, stdout.String(), stderr.String())
		}
	}
	return result, stderr.String(), err
}

func requireHostCreate(t *testing.T, binary string, root string, args ...string) ShellResult {
	t.Helper()
	result, stderr, err := hostResult(t, binary, root, "", nil, append([]string{"create"}, args...)...)
	if err != nil {
		t.Fatalf("__host create failed: %v\n%s", err, stderr)
	}
	return result
}

func taskDirFromResult(result ShellResult) string { return filepath.Dir(result.LogPath) }

func readPidFile(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		if err == nil {
			if pid, convErr := strconv.Atoi(string(bytes.TrimSpace(data))); convErr == nil && pid > 0 {
				return pid
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("pid file %s never appeared", path)
	return 0
}

func requireProcessGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("pid %d is still alive", pid)
}

func TestPipeTaskUsesNoTerminalAndGetsStdinEOF(t *testing.T) {
	binary := buildPiJob(t)
	root := taskRoot(t)
	result := requireHostCreate(t, binary, root, "--pipe", "--wait", "10s", "--", "sh", "-c",
		`cat; printf "out\n"; printf "err\n" >&2; exit 3`)
	if result.Status != StatusFailed || result.ExitCode == nil || *result.ExitCode != 3 {
		t.Fatalf("result = %#v, want failed exit 3", result)
	}
	if result.Output != "out\nerr\n" {
		t.Fatalf("output = %q, want merged stdout/stderr after EOF", result.Output)
	}
	dir := taskDirFromResult(result)
	paths := taskPaths(dir)
	if task := readTaskFile(paths); !task.Pipe {
		t.Fatal("task.json did not record pipe mode")
	}
	waitTaskClosed(t, root, result.ID)
	assertNoTaskSocket(t, root, result.ID)
	if record, err := readOwnership(root, result.ID); err != nil || !record.Cleaned || !record.Pipe {
		t.Fatalf("ownership = %#v, %v", record, err)
	}
}

func TestPipeTaskRefusesInputAndCancelsItsOwnTree(t *testing.T) {
	binary := buildPiJob(t)
	root := taskRoot(t)
	result := requireHostCreate(t, binary, root, "--wait", "0", "--pipe", "--cwd", root, "--", "sh", "-c",
		`echo $$ > shell.pid; sleep 30 & echo $! > sleep.pid; wait`)
	dir := taskDirFromResult(result)
	shellPid := readPidFile(t, filepath.Join(root, "shell.pid"))
	sleepPid := readPidFile(t, filepath.Join(root, "sleep.pid"))
	runnerPid := readPidFile(t, taskPaths(dir).RunnerPid)

	if _, stderr, err := hostResult(t, binary, root, "x", nil, "send", result.ID); err == nil {
		t.Fatalf("send to a pipe task succeeded: %s", stderr)
	} else if !bytes.Contains([]byte(stderr), []byte("does not accept send or key input")) {
		t.Fatalf("send refusal = %q", stderr)
	}
	if _, stderr, err := hostResult(t, binary, root, "", nil, "key", result.ID, "Enter"); err == nil {
		t.Fatalf("key to a pipe task succeeded: %s", stderr)
	} else if !bytes.Contains([]byte(stderr), []byte("does not accept send or key input")) {
		t.Fatalf("key refusal = %q", stderr)
	}

	cancelled, stderr, err := hostResult(t, binary, root, "", nil, "cancel", result.ID)
	if err != nil {
		t.Fatalf("cancel failed: %v\n%s", err, stderr)
	}
	if cancelled.Status != StatusCancelled {
		t.Fatalf("cancel result = %#v, want cancelled", cancelled)
	}
	waitTaskClosed(t, root, result.ID)
	requireProcessGone(t, shellPid)
	requireProcessGone(t, sleepPid)
	requireProcessGone(t, runnerPid)
	if err := syscall.Kill(-runnerPid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("runner process group %d still exists: %v", runnerPid, err)
	}
	state := readStateFile(taskPaths(dir), safeReadTask(taskPaths(dir)))
	if state.Status != StatusCancelled {
		t.Fatalf("state = %s, want cancelled", state.Status)
	}
	if record, err := readOwnership(root, result.ID); err != nil || !record.Cleaned {
		t.Fatalf("cancel did not mark ownership cleaned: %#v %v", record, err)
	}
	assertNoTaskSocket(t, root, result.ID)
}

func TestPipeTimeoutFinalizesAfterProvenExit(t *testing.T) {
	binary := buildPiJob(t)
	root := taskRoot(t)
	result := requireHostCreate(t, binary, root, "--pipe", "--wait", "10s", "--timeout", "200ms", "--", "sh", "-c",
		`echo start; sleep 5; echo end`)
	if result.Status != StatusTimedOut || result.ExitCode != nil {
		t.Fatalf("result = %#v, want timed_out with null exit", result)
	}
	if result.Output != "start\n" {
		t.Fatalf("output = %q, want only the pre-timeout line", result.Output)
	}
	dir := taskDirFromResult(result)
	waitTaskClosed(t, root, result.ID)
	runnerPid := readPidFile(t, taskPaths(dir).RunnerPid)
	requireProcessGone(t, runnerPid)
	if err := syscall.Kill(-runnerPid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("timed-out process group %d still exists: %v", runnerPid, err)
	}
}

func TestForegroundWaitsForTerminalState(t *testing.T) {
	binary := buildPiJob(t)
	root := taskRoot(t)
	result := requireHostCreate(t, binary, root, "--foreground", "--pipe", "--", "sh", "-c", `sleep 0.2; echo done`)
	if result.Status != StatusCompleted || result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatalf("result = %#v, want completed 0", result)
	}
	if result.Output != "done\n" {
		t.Fatalf("output = %q", result.Output)
	}
	if _, err := os.Stat(filepath.Join(taskDirFromResult(result), "closed")); err != nil {
		t.Fatalf("foreground returned before the task closed: %v", err)
	}
}

func TestForegroundReportsDeadMonitorWithoutReleasingOwnership(t *testing.T) {
	binary := buildPiJob(t)
	root := taskRoot(t)
	command := exec.Command(binary, "__host", "create", "--foreground", "--pipe", "--", "sleep", "30")
	command.Env = cliEnvironment(root)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	waited := make(chan error, 1)
	go func() { waited <- command.Wait() }()

	var dir string
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		entries, _ := os.ReadDir(root)
		for _, entry := range entries {
			if !entry.IsDir() || len(entry.Name()) < 4 || entry.Name()[:4] != "job_" {
				continue
			}
			candidate := filepath.Join(root, entry.Name())
			if _, err := os.Stat(taskPaths(candidate).Started); err == nil {
				dir = candidate
			}
		}
		if dir != "" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if dir == "" {
		_ = command.Process.Kill()
		t.Fatalf("task never started; stderr=%s", stderr.String())
	}
	monitorPid := readPidFile(t, taskPaths(dir).MonitorPid)
	if err := syscall.Kill(monitorPid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-waited:
		if err == nil {
			t.Fatalf("foreground create reported success after its monitor died; stdout=%s", stdout.String())
		}
	case <-time.After(10 * time.Second):
		_ = command.Process.Kill()
		t.Fatal("foreground create hung after its monitor died")
	}
	if !bytes.Contains(stderr.Bytes(), []byte("monitor exited before writing a terminal state")) {
		t.Fatalf("stderr = %q", stderr.String())
	}
	// The fence is retained: cancel is still able to prove and stop the tree.
	if _, cancelOut, cancelErr := hostResult(t, binary, root, "", nil, "cancel", filepath.Base(dir)); cancelErr != nil {
		t.Fatalf("cancel after dead monitor failed: %v\n%s", cancelErr, cancelOut)
	}
	waitTaskClosed(t, root, filepath.Base(dir))
	requireProcessGone(t, readPidFile(t, taskPaths(dir).RunnerPid))
}

type frameRecorder struct {
	mu     sync.Mutex
	frames []map[string]any
}

func (r *frameRecorder) add(frame map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.frames = append(r.frames, frame)
}

func (r *frameRecorder) snapshot() []map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]map[string]any(nil), r.frames...)
}

func startCallbackServer(t *testing.T, socket string) *frameRecorder {
	t.Helper()
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	recorder := &frameRecorder{}
	go func() {
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go func(connection net.Conn) {
				defer connection.Close()
				scanner := bufio.NewScanner(connection)
				for scanner.Scan() {
					var frame map[string]any
					if json.Unmarshal(scanner.Bytes(), &frame) == nil {
						recorder.add(frame)
					}
					_, _ = connection.Write([]byte("\n"))
				}
			}(connection)
		}
	}()
	return recorder
}

func TestHostCreateRegistersCallIDAndStripsItFromTheShell(t *testing.T) {
	binary := buildPiJob(t)
	root := taskRoot(t)
	socket := filepath.Join(root, "main.sock")
	recorder := startCallbackServer(t, socket)
	env := []string{
		"PI_AGENT_SOCKET=" + socket,
		"PI_ASYNC_SHELL_TOKEN=token-call",
		"PI_AGENT_ID=AsyncActor",
		"PI_ASYNC_SHELL_CALL_ID=call-123",
	}
	result, stderr, err := hostResult(t, binary, root, "", env, "create", "--pipe", "--wait", "10s", "--",
		"sh", "-c", `printf "env:%s\n" "$PI_ASYNC_SHELL_CALL_ID"`)
	if err != nil {
		t.Fatalf("create failed: %v\n%s", err, stderr)
	}
	if result.Output != "env:\n" {
		t.Fatalf("the launched shell saw callId: %q", result.Output)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		frames := recorder.snapshot()
		if len(frames) >= 2 {
			register := frames[0]
			if register["operation"] != "register" {
				t.Fatalf("first frame = %#v", register)
			}
			if register["callId"] != "call-123" {
				t.Fatalf("register callId = %#v", register["callId"])
			}
			if register["id"] != result.ID {
				t.Fatalf("register id = %#v, want %s", register["id"], result.ID)
			}
			complete := frames[1]
			if complete["operation"] != "complete" || complete["id"] != result.ID {
				t.Fatalf("complete frame = %#v", complete)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d frames arrived", len(frames))
		}
		time.Sleep(10 * time.Millisecond)
	}
}
