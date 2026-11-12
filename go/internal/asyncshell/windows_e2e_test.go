//go:build windows

package asyncshell

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	shellbackend "pijob/internal/asyncshell/backend"
)

func requirePsmux(t *testing.T) {
	t.Helper()
	ready := false
	func() {
		defer func() { _ = recover() }()
		shellbackend.Default().AssertAvailable()
		ready = true
	}()
	if !ready {
		t.Skip("psmux 3.4.0 or newer is required")
	}
}

func taskRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	t.Setenv("PI_ASYNC_SHELL_ROOT", root)
	return root
}

func taskDirOf(result ShellResult) string {
	return filepath.Dir(result.LogPath)
}

func waitForOutput(t *testing.T, dir string, wanted string) ShellResult {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		result, err := ReadTask(dir, nil)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(result.Output, wanted) {
			return result
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %q; status=%q output=%q", wanted, result.Status, result.Output)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func TestWindowsInteractiveCommand(t *testing.T) {
	requirePsmux(t)
	root := taskRoot(t)
	result, err := CreateTask(CreateTaskOptions{Argv: []string{"cmd.exe"}, Cwd: root, WaitMs: 0})
	if err != nil {
		t.Fatal(err)
	}
	dir := taskDirOf(result)
	t.Cleanup(func() {
		_ = CancelTask(dir, root)
		_ = os.RemoveAll(dir)
	})

	waitForOutput(t, dir, ">")
	if err := SendInput(dir, "echo automated-hello", true); err != nil {
		t.Fatal(err)
	}
	read := waitForOutput(t, dir, "automated-hello")
	if !strings.Contains(read.Output, "automated-hello") {
		t.Fatalf("output = %q", read.Output)
	}
	if err := CancelTask(dir, root); err != nil {
		t.Fatal(err)
	}
	final, err := ReadTask(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if final.Status != "cancelled" {
		t.Fatalf("status = %q, want cancelled", final.Status)
	}
}

func TestWindowsExitAndTimeout(t *testing.T) {
	t.Run("nonzero-exit", func(t *testing.T) {
		requirePsmux(t)
		root := taskRoot(t)
		result, err := CreateTask(CreateTaskOptions{Argv: []string{"cmd.exe", "/c", "exit", "7"}, Cwd: root, WaitMs: 5000})
		if err != nil {
			t.Fatal(err)
		}
		dir := taskDirOf(result)
		t.Cleanup(func() {
			_ = CancelTask(dir, root)
			_ = os.RemoveAll(dir)
		})
		if result.Status != "failed" || result.ExitCode == nil || *result.ExitCode != 7 {
			t.Fatalf("result = %#v, want failed exit 7", result)
		}
	})

	t.Run("timeout", func(t *testing.T) {
		requirePsmux(t)
		root := taskRoot(t)
		timeoutMs := int64(1000)
		result, err := CreateTask(CreateTaskOptions{
			Argv: []string{"cmd.exe", "/c", "ping", "-n", "31", "127.0.0.1"}, Cwd: root, WaitMs: 10000, TimeoutMs: &timeoutMs,
		})
		if err != nil {
			t.Fatal(err)
		}
		dir := taskDirOf(result)
		t.Cleanup(func() {
			_ = CancelTask(dir, root)
			_ = os.RemoveAll(dir)
		})
		if result.Status != "timed_out" {
			t.Fatalf("result = %#v, want timed_out", result)
		}
	})
}
