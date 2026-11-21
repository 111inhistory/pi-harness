//go:build !windows

package asyncshell

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func requireTmux(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux is required for the PTY host input test")
	}
	if output, err := exec.Command("tmux", "-V").CombinedOutput(); err != nil {
		t.Skipf("tmux is not usable: %v %s", err, output)
	}
}

func waitForPath(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("%s never appeared", path)
}

func TestHostSendAndKeyDoNotConsumeOutputCursor(t *testing.T) {
	requireTmux(t)
	binary := buildPiJob(t)
	root := taskRoot(t)

	started := requireHostCreate(t, binary, root, "--wait", "0", "--", "cat")
	if started.Status != StatusRunning {
		t.Fatalf("create = %#v, want running", started)
	}
	dir := taskDirFromResult(started)
	paths := taskPaths(dir)
	t.Cleanup(func() {
		_, _, _ = hostResult(t, binary, root, "", nil, "cancel", started.ID)
	})
	waitForPath(t, paths.ChildPid)

	before := readCursor(paths)
	sent, stderr, err := hostResult(t, binary, root, "hello\n", nil, "send", started.ID)
	if err != nil {
		t.Fatalf("__host send failed: %v\n%s", err, stderr)
	}
	if sent.Status != StatusRunning || sent.Output != "" {
		t.Fatalf("send result = %#v, want a non-consuming running status", sent)
	}
	if sent.Cursor != before || readCursor(paths) != before {
		t.Fatalf("send moved the cursor: result=%d file=%d before=%d", sent.Cursor, readCursor(paths), before)
	}

	keyed, stderr, err := hostResult(t, binary, root, "", nil, "key", started.ID, "Enter")
	if err != nil {
		t.Fatalf("__host key failed: %v\n%s", err, stderr)
	}
	if keyed.Status != StatusRunning || keyed.Output != "" {
		t.Fatalf("key result = %#v, want a non-consuming running status", keyed)
	}
	if keyed.Cursor != before || readCursor(paths) != before {
		t.Fatalf("key moved the cursor: result=%d file=%d before=%d", keyed.Cursor, readCursor(paths), before)
	}

	// The public poll path still consumes the transcript the acknowledgements
	// deliberately left in place.
	deadline := time.Now().Add(10 * time.Second)
	for {
		polled, pollErr := PollTask(dir, nil)
		if pollErr != nil {
			t.Fatal(pollErr)
		}
		if polled.Output != "" {
			if readCursor(paths) == before {
				t.Fatalf("public poll did not consume output: %#v", polled)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("public poll never saw the sent bytes; log=%s", filepath.Base(paths.Filtered))
		}
		time.Sleep(25 * time.Millisecond)
	}
}
