package asyncshell

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// platform.go translates src/async-shell/platform.ts.
//
// Exports map (TS -> Go):
//
//	SESSION   -> Session
//	CONTROL_TIMEOUT_MS -> ControlTimeoutMs
//	CommandResult -> CommandResult
//	ShellBackend  -> ShellBackend
//	ControlClient -> ControlClient
//	pasteLiteral  -> PasteLiteral
//	selfArgv      -> SelfArgv
//	ChildCommand  -> ChildCommand
//	childCommand  -> ChildCommandFor
//	escapeCommand -> escapeCommand
//	escapeArgument-> escapeArgument
//	envValue      -> envValue
//	resolveWindowsExecutable -> resolveWindowsExecutable
//
// Node builtins (fs/path.win32/process) stay as seams (see seams.go).

// Session is the pane's session name inside a task's own server (TS: SESSION).
const Session = "task"

// ControlTimeoutMs bounds every control command (TS: CONTROL_TIMEOUT_MS = 20_000).
const ControlTimeoutMs = 20000

// CommandResult is TS CommandResult. Code is null (nil) on signal/unknown status.
type CommandResult struct {
	Code   *int
	Stdout string
	Stderr string
}

// ShellBackend is TS ShellBackend (method names capitalised for Go).
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

// ControlClient is TS ControlClient.
type ControlClient interface {
	Run(dir string, args []string, stdin *string) CommandResult
	RunOk(dir string, args []string, code string, stdin *string) CommandResult
}

// PasteLiteral is TS pasteLiteral: load-buffer (stdin) -> paste-buffer -> delete-buffer.
func PasteLiteral(client ControlClient, dir string, input string, target string) {
	buffer := "pi-" + filepath.Base(dir)
	client.RunOk(dir, []string{"load-buffer", "-b", buffer, "-"}, "send_failed", &input)
	defer client.Run(dir, []string{"delete-buffer", "-b", buffer}, nil)
	client.RunOk(dir, []string{"paste-buffer", "-p", "-r", "-b", buffer, "-t", target}, "send_failed", nil)
}

// SelfArgv is TS selfArgv adapted to a single native binary: the pane re-runs
// this executable in an internal mode. Node's `execPath + execArgv + script`
// shape does not exist in Go, so the binary is its own entry point.
func SelfArgv(dir string, mode string) []string {
	executable, err := os.Executable()
	if err != nil || executable == "" {
		panic(NewAsyncShellError("self_unresolved", "The async-shell CLI cannot locate its own entry point."))
	}
	return []string{executable, mode, dir}
}

// DefaultPathext is TS DEFAULT_PATHEXT.
const DefaultPathext = ".COM;.EXE;.BAT;.CMD"

// ChildCommand is TS ChildCommand. Verbatim means cmd.exe needs the prepared line verbatim.
type ChildCommand struct {
	File     string
	Args     []string
	Verbatim bool
}

// cmdMeta is the cmd.exe metacharacter set handled by the cross-spawn escaping.
var cmdMeta = regexp.MustCompile("([()\\]\\[%!^\"`<>&|;, *?])")

// escapeCommand is TS escapeCommand: escape the command word itself (not quoted as a unit).
func escapeCommand(value string) string {
	return cmdMeta.ReplaceAllString(value, "^$1")
}

// escapeArgument is TS escapeArgument: escape one argument for cmd.exe.
func escapeArgument(value string) string {
	var b strings.Builder
	run := 0
	writeRaw := func(n int) {
		for i := 0; i < n; i++ {
			b.WriteByte('\\')
		}
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch c {
		case '\\':
			run++
		case '"':
			writeRaw(2*run + 1)
			b.WriteByte('"')
			run = 0
		default:
			writeRaw(run)
			run = 0
			b.WriteByte(c)
		}
	}
	writeRaw(2 * run)
	text := `"` + b.String() + `"`
	text = cmdMeta.ReplaceAllString(text, "^$1")
	text = cmdMeta.ReplaceAllString(text, "^$1")
	return text
}

// envValue is TS envValue: environment names are case-insensitive on Windows.
func envValue(env map[string]string, name string) (string, bool) {
	wanted := strings.ToLower(name)
	for key, value := range env {
		if strings.ToLower(key) == wanted {
			return value, true
		}
	}
	return "", false
}

// ChildCommandFor is TS childCommand: resolve a task's argv into something a pane can execute.
func ChildCommandFor(argv []string, platform string, env map[string]string, cwd string) ChildCommand {
	var file string
	if len(argv) > 0 {
		file = argv[0]
	}
	if file == "" {
		panic(NewAsyncShellError("invalid_command_args", "create requires a command."))
	}
	rest := argv[1:]
	if platform != "win32" {
		return ChildCommand{File: file, Args: rest, Verbatim: false}
	}
	resolved := resolveWindowsExecutable(file, env, cwd)
	if !regexp.MustCompile(`(?i)\.(bat|cmd)$`).MatchString(resolved) {
		return ChildCommand{File: resolved, Args: rest, Verbatim: false}
	}
	for _, arg := range rest {
		if strings.ContainsAny(arg, "\r\n") {
			panic(NewAsyncShellError("unsupported_script_argument",
				"Cannot pass a line break to "+Win32PathBasename(resolved)+": cmd.exe treats it as a command separator."))
		}
	}
	parts := make([]string, 0, len(rest)+1)
	parts = append(parts, escapeCommand(resolved))
	for _, arg := range rest {
		parts = append(parts, escapeArgument(arg))
	}
	line := `"` + strings.Join(parts, " ") + `"`
	comspec, ok := envValue(env, "ComSpec")
	if !ok {
		comspec = "cmd.exe"
	}
	return ChildCommand{File: comspec, Args: []string{"/d", "/s", "/c", line}, Verbatim: true}
}

// resolveWindowsExecutable is TS resolveWindowsExecutable: find the file the command
// would run, honouring PATHEXT (uses path.win32 + fs.existsSync seams).
func resolveWindowsExecutable(file string, env map[string]string, cwd string) string {
	hasDirectory := strings.ContainsAny(file, `\/`)
	var absolute string
	if hasDirectory {
		absolute = Win32PathResolve(cwd, file)
	} else {
		absolute = file
	}
	basename := Win32PathBasename(absolute)
	var names []string
	if Win32PathExtname(basename) == "" {
		pathext := DefaultPathext
		if v, ok := envValue(env, "PATHEXT"); ok {
			pathext = v
		}
		for _, entry := range strings.Split(pathext, ";") {
			entry = strings.TrimSpace(entry)
			if entry != "" {
				names = append(names, basename+entry)
			}
		}
		names = append(names, basename)
	} else {
		names = []string{basename}
	}
	var directories []string
	if hasDirectory {
		directories = []string{Win32PathDirname(absolute)}
	} else {
		directories = append(directories, cwd)
		if p, ok := envValue(env, "PATH"); ok {
			for _, entry := range strings.Split(p, ";") {
				entry = strings.TrimSpace(entry)
				if entry != "" {
					directories = append(directories, entry)
				}
			}
		}
	}
	for _, directory := range directories {
		for _, name := range names {
			candidate := Win32PathJoin(directory, name)
			if fileExists(candidate) {
				return candidate
			}
		}
	}
	return absolute
}
