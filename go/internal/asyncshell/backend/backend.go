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

// ServerState is the backend's tri-state answer. Suspect means the transport
// refused or the path was absent, which is never by itself proof that the
// server process exited.
type ServerState int

const (
	ServerRunning ServerState = iota
	ServerStopped
	ServerSuspect
	ServerMissing
	ServerUnknown
)

// ShellBackend is the task's terminal multiplexer.
type ShellBackend interface {
	Kind() string
	AssertAvailable()
	Run(dir string, args []string, stdin *string) CommandResult
	RunOk(dir string, args []string, code string, stdin *string) CommandResult
	KillServer(dir string) error
	KillServerWithin(dir string, timeoutMs int) error
	ServerState(dir string, timeoutMs int) (ServerState, error)
	ServerPid(dir string) (int, error)
	Start(dir string, selfArgv []string, rawPath string, afterBind func() error)
	SendInput(dir string, input string)
	SendKey(dir string, key string)
	PaneGone(dir string) bool
	OwnsProcess(pid int, marker string, dir string) bool
	OwnsProcessWithin(pid int, marker string, dir string, timeoutMs int) bool
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
