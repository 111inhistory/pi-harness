//go:build windows

package proc

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pijob/internal/asyncshell/aserr"
)

func windowsEnv() map[string]string {
	env := map[string]string{}
	for _, entry := range os.Environ() {
		if index := strings.IndexByte(entry, '='); index >= 0 {
			env[entry[:index]] = entry[index+1:]
		}
	}
	return env
}

func writeBatch(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	script := filepath.Join(dir, "args.cmd")
	if err := os.WriteFile(script, []byte("@echo off\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir, script
}

func TestChildCommandForBatchTargetEscapesLiterals(t *testing.T) {
	dir, script := writeBatch(t)
	command, err := ChildCommandFor([]string{script, "a^b", "c&d"}, windowsEnv(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !command.Verbatim || len(command.Args) != 4 {
		t.Fatalf("command = %#v, want a verbatim cmd.exe invocation", command)
	}
	if !strings.EqualFold(filepath.Base(command.File), "cmd.exe") {
		t.Fatalf("file = %q, want cmd.exe", command.File)
	}
	if command.Args[0] != "/d" || command.Args[1] != "/s" || command.Args[2] != "/c" {
		t.Fatalf("prefix = %#v, want /d /s /c", command.Args[:3])
	}
	line := command.Args[3]
	for _, want := range []string{script, `^^^"a^^^^b^^^"`, `^^^"c^^^&d^^^"`} {
		if !strings.Contains(line, want) {
			t.Fatalf("line %q does not contain %q", line, want)
		}
	}
}

func TestChildCommandForBareBatchName(t *testing.T) {
	dir, script := writeBatch(t)
	command, err := ChildCommandFor([]string{"args.cmd"}, windowsEnv(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !command.Verbatim || len(command.Args) != 4 || !strings.Contains(command.Args[3], script) {
		t.Fatalf("command = %#v, want the resolved .cmd through cmd.exe", command)
	}
}

func TestChildCommandForDirectExecutable(t *testing.T) {
	dir, _ := writeBatch(t)
	command, err := ChildCommandFor([]string{"cmd.exe", "/c", "echo", "hi"}, windowsEnv(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if command.Verbatim {
		t.Fatalf("command = %#v, want literal argv passthrough", command)
	}
	if !strings.EqualFold(filepath.Base(command.File), "cmd.exe") {
		t.Fatalf("file = %q, want cmd.exe", command.File)
	}
	if strings.Join(command.Args, " ") != "/c echo hi" {
		t.Fatalf("args = %#v, want /c echo hi", command.Args)
	}
}

func TestChildCommandForRefusesLineBreak(t *testing.T) {
	dir, script := writeBatch(t)
	if _, err := ChildCommandFor([]string{script, "a\rb"}, windowsEnv(), dir); aserr.Code(err) != "unsupported_script_argument" {
		t.Fatalf("error = %v, want unsupported_script_argument", err)
	}
}
