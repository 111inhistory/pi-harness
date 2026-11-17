//go:build !windows

package asyncshell

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

var cliTaskIDPattern = regexp.MustCompile(`job_[0-9a-f]{8}`)

func buildPiJob(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "pi-job")
	command := exec.Command("go", "build", "-o", binary, "./cmd/pi-job")
	command.Dir = "../.."
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("go build failed: %v\n%s", err, output)
	}
	return binary
}

func cliEnvironment(root string) []string {
	env := make([]string, 0, len(os.Environ())+1)
	for _, entry := range os.Environ() {
		key := strings.ToUpper(strings.SplitN(entry, "=", 2)[0])
		if key == "PI_AGENT_SOCKET" || key == "PI_ASYNC_SHELL_TOKEN" || key == "PI_ASYNC_SHELL_HOST_ERROR" || key == "PI_ASYNC_SHELL_ROOT" {
			continue
		}
		env = append(env, entry)
	}
	return append(env, "PI_ASYNC_SHELL_ROOT="+root)
}

func runPiJob(t *testing.T, binary string, root string, args ...string) (string, error) {
	t.Helper()
	command := exec.Command(binary, args...)
	command.Env = cliEnvironment(root)
	output, err := command.CombinedOutput()
	return string(output), err
}

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

func assertNoTaskSocket(t *testing.T, root string, id string) {
	t.Helper()
	if _, err := os.Lstat(filepath.Join(root, id, taskSocketName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("task %s retained a socket: %v", id, err)
	}
}

func taskIDFrom(t *testing.T, output string) string {
	t.Helper()
	id := cliTaskIDPattern.FindString(output)
	if id == "" {
		t.Fatalf("no task id in output: %s", output)
	}
	return id
}

func TestTerminalPathsReleaseOwnedSocket(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux is required for the POSIX terminal cleanup test")
	}
	if output, err := exec.Command("tmux", "-V").CombinedOutput(); err != nil {
		t.Skipf("tmux is not usable: %v %s", err, output)
	}
	binary := buildPiJob(t)
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		entries, _ := os.ReadDir(root)
		for _, entry := range entries {
			if !strings.HasPrefix(entry.Name(), "job_") {
				continue
			}
			socket := filepath.Join(root, entry.Name(), taskSocketName)
			_ = exec.Command("tmux", "-S", socket, "kill-server").Run()
		}
	})

	t.Run("normal completion", func(t *testing.T) {
		output, err := runPiJob(t, binary, root, "create", "--wait", "10s", "--", "true")
		if err != nil {
			t.Fatalf("create failed: %v\n%s", err, output)
		}
		id := taskIDFrom(t, output)
		waitTaskClosed(t, root, id)
		assertNoTaskSocket(t, root, id)
		state := readStateFile(taskPaths(filepath.Join(root, id)), safeReadTask(taskPaths(filepath.Join(root, id))))
		if state.Status != StatusCompleted {
			t.Fatalf("state = %s, want completed", state.Status)
		}
		if output, err := runPiJob(t, binary, root, "cancel", id); err != nil {
			t.Fatalf("closed cancel failed: %v\n%s", err, output)
		}
		assertNoTaskSocket(t, root, id)
	})

	t.Run("cancel running", func(t *testing.T) {
		output, err := runPiJob(t, binary, root, "create", "--wait", "0", "--", "sleep", "30")
		if err != nil {
			t.Fatalf("create failed: %v\n%s", err, output)
		}
		id := taskIDFrom(t, output)
		if output, err := runPiJob(t, binary, root, "cancel", id); err != nil {
			t.Fatalf("cancel failed: %v\n%s", err, output)
		}
		waitTaskClosed(t, root, id)
		assertNoTaskSocket(t, root, id)
	})

	t.Run("timeout", func(t *testing.T) {
		output, err := runPiJob(t, binary, root, "create", "--wait", "10s", "--timeout", "100ms", "--", "sleep", "5")
		if err != nil {
			t.Fatalf("create failed: %v\n%s", err, output)
		}
		id := taskIDFrom(t, output)
		waitTaskClosed(t, root, id)
		assertNoTaskSocket(t, root, id)
		state := readStateFile(taskPaths(filepath.Join(root, id)), safeReadTask(taskPaths(filepath.Join(root, id))))
		if state.Status != StatusTimedOut {
			t.Fatalf("state = %s, want timed_out", state.Status)
		}
	})

	t.Run("start failure", func(t *testing.T) {
		output, _ := runPiJob(t, binary, root, "create", "--wait", "10s", "--", "/definitely/not/a/command")
		id := taskIDFrom(t, output)
		waitTaskClosed(t, root, id)
		assertNoTaskSocket(t, root, id)
		state := readStateFile(taskPaths(filepath.Join(root, id)), safeReadTask(taskPaths(filepath.Join(root, id))))
		if state.Status != StatusFailed && state.Status != StatusInternalError {
			t.Fatalf("start failure state = %s, want failed/internal_error", state.Status)
		}
	})
}
