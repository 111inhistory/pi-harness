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

// MaxResultLines bounds one result's output in lines. Byte and line budgets are
// independent: whichever is reached first ends the result (see window.go).
const MaxResultLines = 2000

// MaxSyncTailBytes and MaxSyncTailLines bound a synchronously delivered managed
// result, matching the native shell tail (last 2000 lines, at most 50 KiB). The
// larger byte budget never raises MaxResultBytes for background windows or the
// standalone CLI: a sync result travels only in create's reply, never in a frame.
const (
	MaxSyncTailBytes = 50 * 1024
	MaxSyncTailLines = 2000
)

const InternalErrorMessage = "pi-job encountered an internal error. Cleanup is best effort; do not assume the command has stopped or cleanup is complete. Inspect the task before taking further action."

// ShellStatus is TS `type ShellStatus`.
type ShellStatus string

const (
	StatusRunning       ShellStatus = "running"
	StatusCompleted     ShellStatus = "completed"
	StatusFailed        ShellStatus = "failed"
	StatusInternalError ShellStatus = "internal_error"
	StatusCancelled     ShellStatus = "cancelled"
	StatusTimedOut      ShellStatus = "timed_out"
)

// OutputWindow locates one result's Output inside the complete filtered log, so a
// caller can render the omitted range and point at a resumable line without ever
// seeing a byte cursor. Output holds the head bytes followed by the tail bytes;
// HeadBytes is the split point, so no line walking is needed to separate them.
//
// Lines are 1-based and global to output.log. A head that ends mid-line only
// happens when a single line exceeds the head byte budget; TailFirstLine may then
// equal the head's last line, which is why resuming at TailFirstLine is allowed to
// overlap one line.
type OutputWindow struct {
	FirstLine     int64 `json:"firstLine"`
	HeadLines     int64 `json:"headLines"`
	HeadBytes     int64 `json:"headBytes"`
	TailFirstLine int64 `json:"tailFirstLine"`
	TotalLines    int64 `json:"totalLines"`
}

// ShellResult is TS `interface ShellResult`.
type ShellResult struct {
	ID       string      `json:"id"`
	Status   ShellStatus `json:"status"`
	ExitCode *int        `json:"exitCode"`
	Output   string      `json:"output"`
	Cursor   int64       `json:"cursor"`
	LogPath  string      `json:"logPath"`
	// Truncated reports lost bytes: on a host delivery, bytes omitted from what the
	// caller asked to see; on a CLI increment, bytes still waiting after Cursor.
	Truncated bool `json:"truncated"`
	// Window is always present, including for an empty result, so every result
	// carries the same shape.
	Window  OutputWindow `json:"window"`
	Message string       `json:"message,omitempty"`
}

// AsyncShellRegisterFrame is TS `interface AsyncShellRegisterFrame`.
type AsyncShellRegisterFrame struct {
	Kind      string `json:"kind"`
	AgentID   string `json:"agentId"`
	Token     string `json:"token"`
	Operation string `json:"operation"`
	ID        string `json:"id"`
	Directory string `json:"directory"`
	PID       int    `json:"pid"`
	// CallID is the host-only invocation correlation for startup abort. It is
	// optional; standalone creates and monitors never set it.
	CallID string `json:"callId,omitempty"`
	PTY    bool   `json:"pty"`
}

// AsyncShellCompleteFrame is TS `interface AsyncShellCompleteFrame`.
type AsyncShellCompleteFrame struct {
	Kind      string      `json:"kind"`
	AgentID   string      `json:"agentId"`
	Token     string      `json:"token"`
	Operation string      `json:"operation"`
	ID        string      `json:"id"`
	Notify    bool        `json:"notify"`
	Result    ShellResult `json:"result"`
}
