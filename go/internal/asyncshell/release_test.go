package asyncshell

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	shellbackend "pijob/internal/asyncshell/backend"
)

type probeRecordingBackend struct {
	timeouts   []int
	killCalls  int
	runningFor int
}

func (p *probeRecordingBackend) Kind() string     { return "probe-recording" }
func (p *probeRecordingBackend) AssertAvailable() {}
func (p *probeRecordingBackend) Run(string, []string, *string) shellbackend.CommandResult {
	return shellbackend.CommandResult{}
}
func (p *probeRecordingBackend) RunOk(string, []string, string, *string) shellbackend.CommandResult {
	return shellbackend.CommandResult{}
}
func (p *probeRecordingBackend) KillServer(string) error {
	p.killCalls++
	return nil
}
func (p *probeRecordingBackend) KillServerWithin(string, int) error {
	p.killCalls++
	return nil
}
func (p *probeRecordingBackend) ServerState(_ string, timeoutMs int) (shellbackend.ServerState, error) {
	p.timeouts = append(p.timeouts, timeoutMs)
	if len(p.timeouts) <= p.runningFor {
		return shellbackend.ServerRunning, nil
	}
	return shellbackend.ServerStopped, nil
}
func (p *probeRecordingBackend) ServerPid(string) (int, error)                { return 1 << 30, nil }
func (p *probeRecordingBackend) Start(string, []string, string, func() error) {}
func (p *probeRecordingBackend) SendInput(string, string)                     {}
func (p *probeRecordingBackend) SendKey(string, string)                       {}
func (p *probeRecordingBackend) PaneGone(string) bool                         { return true }
func (p *probeRecordingBackend) OwnsProcess(int, string, string) bool         { return false }
func (p *probeRecordingBackend) OwnsProcessWithin(int, string, string, int) bool {
	return false
}

func TestReleaseProbesKeepFullTimeoutBudget(t *testing.T) {
	root, err := os.MkdirTemp("", "pijob-rel-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PI_ASYNC_SHELL_ROOT", root)

	dir, id, err := createOwnedDirectory(root, "job_11223344")
	if err != nil {
		t.Fatal(err)
	}
	if err := recordDirectoryOwnership(root, dir, id); err != nil {
		t.Fatal(err)
	}
	if usesFilesystemSocket {
		sockPath := filepath.Join(dir, taskSocketName)
		listener, listenErr := net.ListenUnix("unix", &net.UnixAddr{Name: sockPath, Net: "unix"})
		if listenErr != nil {
			t.Fatal(listenErr)
		}
		listener.SetUnlinkOnClose(false)
		if err := os.Chmod(sockPath, 0o600); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = listener.Close() })
	}

	stub := &probeRecordingBackend{runningFor: 3}
	previous := backend
	backend = stub
	t.Cleanup(func() { backend = previous })

	if err := recordBoundOwnership(root, dir); err != nil {
		t.Fatal(err)
	}
	if err := releaseTaskBackend(dir); err != nil {
		t.Fatalf("releaseTaskBackend failed: %v", err)
	}
	if stub.killCalls != 1 {
		t.Fatalf("killCalls = %d, want 1", stub.killCalls)
	}
	if len(stub.timeouts) < 4 {
		t.Fatalf("expected initial + post-kill probes, got %v", stub.timeouts)
	}
	for i, got := range stub.timeouts {
		if got != serverProbeTimeoutMs {
			t.Fatalf("probe[%d] timeout = %d, want full serverProbeTimeoutMs (%d)", i, got, serverProbeTimeoutMs)
		}
	}
}

func TestWaitForCloseExitsPromptlyWhenMonitorGone(t *testing.T) {
	dir := t.TempDir()
	paths := taskPaths(dir)

	// Spawn a short-lived process and wait for it so we have a provably exited pid.
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd.exe", "/c", "exit", "0")
	} else {
		cmd = exec.Command("true")
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	deadPid := cmd.Process.Pid
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	if alive(deadPid) {
		t.Skip("dead pid was reused immediately by OS")
	}

	start := time.Now()
	closed := waitForClose(paths, 5_000, deadPid)
	elapsed := time.Since(start)
	if closed {
		t.Fatal("waitForClose reported closed without a closed marker")
	}
	if elapsed > time.Second {
		t.Fatalf("waitForClose stalled for %v after monitor exited", elapsed)
	}

	// If the monitor wrote closed before exiting, waitForClose still observes it.
	writePrivateFile(paths.Closed, nil)
	if !waitForClose(paths, 5_000, deadPid) {
		t.Fatal("waitForClose missed a closed marker written before monitor exit")
	}
}
