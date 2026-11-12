package proc

import (
	"os"
	"regexp"
	"strings"

	"pijob/internal/asyncshell/aserr"
	"pijob/internal/asyncshell/win32path"
)

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
func ChildCommandFor(argv []string, platform string, env map[string]string, cwd string) (ChildCommand, error) {
	var file string
	if len(argv) > 0 {
		file = argv[0]
	}
	if file == "" {
		return ChildCommand{}, aserr.New("invalid_command_args", "create requires a command.")
	}
	rest := argv[1:]
	if platform != "windows" {
		return ChildCommand{File: file, Args: rest, Verbatim: false}, nil
	}
	resolved := resolveWindowsExecutable(file, env, cwd)
	if !regexp.MustCompile(`(?i)\.(bat|cmd)$`).MatchString(resolved) {
		return ChildCommand{File: resolved, Args: rest, Verbatim: false}, nil
	}
	for _, arg := range rest {
		if strings.ContainsAny(arg, "\r\n") {
			return ChildCommand{}, aserr.New("unsupported_script_argument",
				"Cannot pass a line break to "+win32path.Basename(resolved)+": cmd.exe treats it as a command separator.")
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
	return ChildCommand{File: comspec, Args: []string{"/d", "/s", "/c", line}, Verbatim: true}, nil
}

// resolveWindowsExecutable is TS resolveWindowsExecutable: find the file the command
// would run, honouring PATHEXT (uses path.win32 + fs.existsSync seams).
func resolveWindowsExecutable(file string, env map[string]string, cwd string) string {
	hasDirectory := strings.ContainsAny(file, `\/`)
	var absolute string
	if hasDirectory {
		absolute = win32path.Resolve(cwd, file)
	} else {
		absolute = file
	}
	basename := win32path.Basename(absolute)
	var names []string
	if win32path.Extname(basename) == "" {
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
		directories = []string{win32path.Dirname(absolute)}
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
			candidate := win32path.Join(directory, name)
			if fileExists(candidate) {
				return candidate
			}
		}
	}
	return absolute
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
