//go:build !windows

package asyncshell

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// window_posix_test.go drives the built pi-job binary so the reader contract is
// checked through the real entry points: the host create/cancel protocol and the
// standalone create/poll CLI.

func scriptedLines(count int) string {
	var builder strings.Builder
	for index := 0; index < count; index++ {
		builder.WriteString(fmt.Sprintf("line %05d\n", index+1))
	}
	return builder.String()
}

// cliResultBody is FormatResult's `output:` payload.
func cliResultBody(t *testing.T, reply string) string {
	t.Helper()
	_, body, found := strings.Cut(reply, "\n\noutput:\n")
	if !found {
		t.Fatalf("CLI reply has no output section:\n%s", reply)
	}
	return body
}

func TestHostSyncDeliveryKeepsTheTailWindow(t *testing.T) {
	binary := buildPiJob(t)
	root := taskRoot(t)
	script := `i=0; while [ $i -lt 5000 ]; do i=$((i+1)); printf "line %05d\n" "$i"; done`
	for _, wait := range [][]string{{"--wait", "10s"}, {"--foreground"}} {
		t.Run(strings.Join(wait, " "), func(t *testing.T) {
			result := requireHostCreate(t, binary, root, append(append([]string{"--pipe"}, wait...), "--", "sh", "-c", script)...)
			if result.Status != StatusCompleted || result.ExitCode == nil || *result.ExitCode != 0 {
				t.Fatalf("create = %#v, want a completed command", result)
			}
			window := result.Window
			if !result.Truncated {
				t.Fatal("a managed sync result that dropped earlier lines must report truncation")
			}
			if window.HeadBytes != 0 || window.HeadLines != 0 || window.TailFirstLine != window.FirstLine {
				t.Fatalf("sync window = %#v", window)
			}
			if window.FirstLine != 3001 || window.TotalLines != 5000 {
				t.Fatalf("sync window = %#v, want the last 2000 of 5000 lines", window)
			}
			if result.Output != scriptedLines(5000)[len(scriptedLines(3000)):] {
				t.Fatal("sync output is not the transcript tail")
			}
			if len(result.Output) > MaxSyncTailBytes {
				t.Fatalf("sync output carries %d bytes", len(result.Output))
			}
			data, err := os.ReadFile(taskPaths(taskDirFromResult(result)).Filtered)
			if err != nil {
				t.Fatal(err)
			}
			if result.Cursor != int64(len(data)) {
				t.Fatalf("sync cursor = %d, want EOF %d", result.Cursor, len(data))
			}
		})
	}
}

func TestHostWaitExpiryDeliversTheFirstUnreadLines(t *testing.T) {
	binary := buildPiJob(t)
	root := taskRoot(t)
	// 3000 lines of ~46 bytes exceed one result. The wait-expiry delivery must
	// start at the transcript's first line, not after a CLI increment that already
	// advanced the shared cursor.
	script := `i=0; while [ $i -lt 3000 ]; do i=$((i+1)); printf "RUN %04d %s\n" "$i" "abcdefghijklmnopqrstuvwxyz0123456789"; done; sleep 30`
	started := requireHostCreate(t, binary, root, "--pipe", "--wait", "2s", "--", "sh", "-c", script)
	if started.Status != StatusRunning {
		t.Fatalf("create = %#v, want a Job still running after the wait window", started)
	}
	window := started.Window
	if window.FirstLine != 1 || !strings.HasPrefix(started.Output, "RUN 0001 ") {
		t.Fatalf("window = %#v starts at %q, want the first unread line", window, firstLineOf(started.Output))
	}
	if !started.Truncated {
		t.Fatal("a clipped wait-expiry delivery must report truncation")
	}
	if window.HeadLines == 0 || window.HeadBytes == 0 {
		t.Fatalf("window = %#v has no head", window)
	}
	if window.TailFirstLine <= window.FirstLine+window.HeadLines {
		t.Fatalf("window = %#v, want an omitted middle", window)
	}
	if window.TotalLines < 2000 {
		t.Fatalf("totalLines = %d, want the whole script transcript", window.TotalLines)
	}
	if !strings.HasSuffix(strings.TrimSuffix(started.Output, "\n"), "RUN 3000 abcdefghijklmnopqrstuvwxyz0123456789") {
		t.Fatalf("window tail does not carry the last line: %q", lastLineOf(started.Output))
	}
	if len(started.Output) > MaxResultBytes {
		t.Fatalf("wait-expiry output carries %d bytes", len(started.Output))
	}
}

func firstLineOf(text string) string {
	line, _, _ := strings.Cut(text, "\n")
	return line
}

func lastLineOf(text string) string {
	lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	return lines[len(lines)-1]
}

func TestHostCancelDeliversTheUnreadWindow(t *testing.T) {
	binary := buildPiJob(t)
	root := taskRoot(t)
	// The leading sleep keeps the create reply free of output, so the cancel
	// result covers the whole script transcript.
	script := `sleep 1; i=0; while [ $i -lt 5000 ]; do i=$((i+1)); printf "line %05d\n" "$i"; done; sleep 30`
	started := requireHostCreate(t, binary, root, "--pipe", "--wait", "0", "--", "sh", "-c", script)
	if started.Status != StatusRunning || started.Output != "" {
		t.Fatalf("create = %#v, want a running Job without output", started)
	}
	full := scriptedLines(5000)
	paths := taskPaths(taskDirFromResult(started))
	t.Cleanup(func() { _, _, _ = hostResult(t, binary, root, "", nil, "cancel", started.ID) })
	waitForPath(t, paths.ChildPid)
	deadline := time.Now().Add(30 * time.Second)
	for {
		info, statErr := os.Stat(paths.Filtered)
		if statErr == nil && info.Size() >= int64(len(full)) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("transcript never reached the script output: %v", statErr)
		}
		time.Sleep(25 * time.Millisecond)
	}

	cancelled, stderr, err := hostResult(t, binary, root, "", nil, "cancel", started.ID)
	if err != nil {
		t.Fatalf("__host cancel failed: %v\n%s", err, stderr)
	}
	if cancelled.Status != StatusCancelled {
		t.Fatalf("cancel status = %q, want cancelled", cancelled.Status)
	}
	window := cancelled.Window
	if !cancelled.Truncated {
		t.Fatal("a clipped unread range must report truncation")
	}
	if window.FirstLine != 1 || window.HeadLines != WindowHeadLines {
		t.Fatalf("window = %#v, want the head of the whole unread range", window)
	}
	if window.TailFirstLine <= window.FirstLine+window.HeadLines {
		t.Fatalf("window = %#v, want an omitted middle", window)
	}
	if window.TotalLines < 5000 {
		t.Fatalf("totalLines = %d, want the whole transcript", window.TotalLines)
	}
	if len(cancelled.Output) > MaxResultBytes {
		t.Fatalf("cancel output carries %d bytes", len(cancelled.Output))
	}
	head := cancelled.Output[:window.HeadBytes]
	if head != full[:len(head)] {
		t.Fatal("head is not the start of the unread transcript")
	}
	tail := cancelled.Output[window.HeadBytes:]
	tailStart := int64(len(full)) - int64(len(tail))
	if tailStart < 0 || !strings.HasPrefix(full[tailStart:], strings.SplitN(tail, "\n", 2)[0]) {
		t.Fatal("tail is not the transcript suffix")
	}
	waitTaskClosed(t, root, started.ID)
}

func TestStandaloneCreateKeepsSequentialIncrements(t *testing.T) {
	binary := buildPiJob(t)
	root := taskRoot(t)
	script := `i=0; while [ $i -lt 5000 ]; do i=$((i+1)); printf "line %05d\n" "$i"; done`
	reply, err := runPiJob(t, binary, root, "create", "--pipe", "--wait", "10s", "--", "sh", "-c", script)
	if err != nil {
		t.Fatalf("create failed: %v\n%s", err, reply)
	}
	id, _, _ := strings.Cut(reply, " ")
	if !strings.Contains(reply, "more output pending") {
		t.Fatalf("the first increment must report pending output:\n%s", reply)
	}
	first := cliResultBody(t, reply)
	if got := countLines([]byte(first)); got != MaxResultLines {
		t.Fatalf("first increment carries %d lines, want %d", got, MaxResultLines)
	}
	if !strings.HasPrefix(first, "line 00001\n") {
		t.Fatal("the standalone CLI increment must start at the transcript start")
	}

	second, err := runPiJob(t, binary, root, "poll", id)
	if err != nil {
		t.Fatalf("poll failed: %v\n%s", err, second)
	}
	third, err := runPiJob(t, binary, root, "poll", id)
	if err != nil {
		t.Fatalf("second poll failed: %v\n%s", err, third)
	}
	if combined := first + cliResultBody(t, second) + cliResultBody(t, third); combined != scriptedLines(5000) {
		t.Fatal("create and poll increments did not concatenate to the transcript")
	}
}
