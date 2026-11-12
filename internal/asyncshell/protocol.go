package asyncshell

// protocol.go translates the TYPE portion of src/async-shell/protocol.ts that the
// Go side needs to emit. The inbound frame VALIDATORS in protocol.ts stay in TS
// (host-side admission); only the wire types/constants are translated here so the
// Go engine can build register/complete frames with the exact JSON shape.

// AsyncShellKind is the frame discriminator (TS: ASYNC_SHELL_KIND).
const AsyncShellKind = "async-shell"

// MaxResultBytes is the upper bound of one result's output, in UTF-8 bytes
// (TS: MAX_RESULT_BYTES = 32 * 1024).
const MaxResultBytes = 32 * 1024

// ShellStatus is TS `type ShellStatus`.
type ShellStatus string

const (
	StatusRunning   ShellStatus = "running"
	StatusCompleted ShellStatus = "completed"
	StatusFailed    ShellStatus = "failed"
	StatusCancelled ShellStatus = "cancelled"
	StatusTimedOut  ShellStatus = "timed_out"
)

// ShellResult is TS `interface ShellResult`.
// TODO(harness-protocol): the reference shape has no error/reason field, so a
// task failure is distinguishable only by status + exitCode + output.log text.
// See the monitor panic TODO in tmux.go before extending this wire type.
type ShellResult struct {
	ID        string      `json:"id"`
	Status    ShellStatus `json:"status"`
	ExitCode  *int        `json:"exitCode"`
	Output    string      `json:"output"`
	Cursor    int64       `json:"cursor"`
	LogPath   string      `json:"logPath"`
	Truncated bool        `json:"truncated"`
}

// AsyncShellRegisterFrame is TS `interface AsyncShellRegisterFrame`.
type AsyncShellRegisterFrame struct {
	Kind      string `json:"kind"`
	Token     string `json:"token"`
	Operation string `json:"operation"`
	ID        string `json:"id"`
	Directory string `json:"directory"`
	PID       int    `json:"pid"`
}

// AsyncShellCompleteFrame is TS `interface AsyncShellCompleteFrame`.
type AsyncShellCompleteFrame struct {
	Kind      string      `json:"kind"`
	Token     string      `json:"token"`
	Operation string      `json:"operation"`
	ID        string      `json:"id"`
	Notify    bool        `json:"notify"`
	Result    ShellResult `json:"result"`
}
