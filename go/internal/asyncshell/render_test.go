package asyncshell

import (
	"strings"
	"testing"
)

func renderFixture(mutate func(*ShellResult)) ShellResult {
	result := ShellResult{
		ID:       "job_3f8a1c2d",
		Status:   StatusCompleted,
		ExitCode: intPtrForTest(0),
		Output:   "hello\nworld\n",
		Cursor:   12,
		LogPath:  "/tmp/pi-async-shell-1000/job_3f8a1c2d/output.log",
	}
	if mutate != nil {
		mutate(&result)
	}
	return result
}

func intPtrForTest(value int) *int { return &value }

func TestFormatResultShape(t *testing.T) {
	got := FormatResult(renderFixture(nil))
	want := "job_3f8a1c2d  completed  exit 0  cursor 12  log /tmp/pi-async-shell-1000/job_3f8a1c2d/output.log\n" +
		"\n" +
		"output:\n" +
		"hello\nworld\n"
	if got != want {
		t.Fatalf("FormatResult() = %q, want %q", got, want)
	}
}

func TestFormatResultRunningEmpty(t *testing.T) {
	got := FormatResult(renderFixture(func(result *ShellResult) {
		result.Status = StatusRunning
		result.ExitCode = nil
		result.Output = ""
		result.Cursor = 40
		result.Truncated = true
	}))
	want := "job_3f8a1c2d  running  cursor 40  more output pending  log /tmp/pi-async-shell-1000/job_3f8a1c2d/output.log\n" +
		"\n" +
		"output:\n"
	if got != want {
		t.Fatalf("FormatResult() = %q, want %q", got, want)
	}
}

func TestFormatResultFailedText(t *testing.T) {
	got := FormatResult(renderFixture(func(result *ShellResult) {
		result.Status = StatusFailed
		result.ExitCode = intPtrForTest(3)
		result.Output = "boom\n\n"
	}))
	if !strings.HasPrefix(got, "job_3f8a1c2d  failed  exit 3  cursor 12") {
		t.Fatalf("metadata line = %q", got)
	}
	if !strings.HasSuffix(got, "output:\nboom\n\n") {
		t.Fatalf("output tail = %q", got)
	}
	if got := FormatResult(renderFixture(func(result *ShellResult) { result.Output = "no newline" })); !strings.HasSuffix(got, "output:\nno newline") {
		t.Fatalf("a chunk cut mid-line must be passed on unaltered: %q", got)
	}
}

func TestFormatError(t *testing.T) {
	if got, want := FormatError("No async-shell task at /tmp/pi-async-shell-1000/job_00000000.", nil),
		"pi-job: No async-shell task at /tmp/pi-async-shell-1000/job_00000000.\n"; got != want {
		t.Fatalf("FormatError() = %q, want %q", got, want)
	}
	usage := "pi-job create -- COMMAND"
	if got, want := FormatError("usage", &usage), "pi-job: usage\n\npi-job create -- COMMAND\n"; got != want {
		t.Fatalf("FormatError() = %q, want %q", got, want)
	}
}
