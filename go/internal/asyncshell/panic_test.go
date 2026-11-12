package asyncshell

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPanicReportsInternalErrorWithoutClaimingCleanup(t *testing.T) {
	// Corrupt task metadata aborts the actual process boundaries before startup.
	// No callback from this test may reach the invoking Harness session.
	t.Setenv("PI_AGENT_SOCKET", "")
	t.Setenv("PI_ASYNC_SHELL_TOKEN", "")
	t.Setenv("PATH", t.TempDir()) // No test cleanup may address a real terminal server.
	dir := filepath.Join(t.TempDir(), "job_11223344")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	paths := taskPaths(dir)
	if exit := RunnerMain(dir); exit != 1 {
		t.Fatalf("runner exit = %d, want 1", exit)
	}
	report := asExitFile(readJSON(paths.Exit))
	if report == nil || !report.InternalError || report.Error == nil {
		t.Fatalf("runner lost its internal-error marker: %#v", report)
	}
	if ordinary := asExitFile(map[string]interface{}{"code": float64(7)}); ordinary == nil || ordinary.InternalError {
		t.Fatalf("ordinary command failure became internal_error: %#v", ordinary)
	}

	MonitorMain(dir)
	state := readStateFile(paths, safeReadTask(paths))
	if state.Status != StatusInternalError || state.ExitCode != nil {
		t.Fatalf("panic state = %#v, want internal_error without command exit code", state)
	}
	if _, err := os.Stat(paths.Closed); !os.IsNotExist(err) {
		t.Fatalf("panic must not certify cleanup with closed: %v", err)
	}
	result := resultOf(paths, state, 0)
	if !strings.Contains(result.Message, "do not assume the command has stopped or cleanup is complete") {
		t.Fatalf("missing actionable cleanup reminder: %#v", result)
	}
	if rendered := FormatResult(result); !strings.Contains(rendered, result.Message) || !strings.Contains(rendered, "internal_error") {
		t.Fatalf("CLI lost internal-error notification: %q", rendered)
	}
}
