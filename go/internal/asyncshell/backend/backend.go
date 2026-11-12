package backend

import (
	"path/filepath"

	"pijob/internal/asyncshell/proc"
)

// Session is the pane's session name inside a task's own server.
const Session = "task"

// ControlTimeoutMs bounds every control command.
const ControlTimeoutMs = 20000

// CommandResult is the result of one backend control command.
type CommandResult = proc.Result

// ShellBackend is the task's terminal multiplexer.
type ShellBackend interface {
	Kind() string
	AssertAvailable()
	Run(dir string, args []string, stdin *string) CommandResult
	KillServer(dir string)
	ServerRunning(dir string) bool
	Start(dir string, selfArgv []string, rawPath string)
	SendInput(dir string, input string)
	SendKey(dir string, key string)
	PaneGone(dir string) bool
	OwnsProcess(pid int, marker string, dir string) bool
}

// ControlClient issues one control command against a task's server.
type ControlClient interface {
	Run(dir string, args []string, stdin *string) CommandResult
	RunOk(dir string, args []string, code string, stdin *string) CommandResult
}

// PasteLiteral loads, pastes and deletes a literal input buffer.
func PasteLiteral(client ControlClient, dir string, input string, target string) {
	buffer := "pi-" + filepath.Base(dir)
	client.RunOk(dir, []string{"load-buffer", "-b", buffer, "-"}, "send_failed", &input)
	defer client.Run(dir, []string{"delete-buffer", "-b", buffer}, nil)
	client.RunOk(dir, []string{"paste-buffer", "-p", "-r", "-b", buffer, "-t", target}, "send_failed", nil)
}
