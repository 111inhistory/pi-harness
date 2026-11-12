package asyncshell

import (
	"io"
	"os"
	"strings"
)

// cli.go translates src/async-shell/cli.ts.
//
// The TS module throws AsyncShellError and relies on a try/catch in main(); the
// literal Go translation keeps throw sites as panic(AsyncShellError) and catches
// them with one defer/recover at the Main boundary, preserving the error/catch
// placement and control flow of the source.

// Usage is TS USAGE.
var Usage = strings.Join([]string{
	"pi-job create [--wait <duration>] [--timeout <duration>] [--cwd <dir>] -- <command> [args...]",
	"pi-job poll <id> [--cursor <bytes>]",
	"pi-job read <id> [--cursor <bytes>]",
	"pi-job send <id> [--enter]   (literal stdin bytes; --enter adds one Enter key)",
	"pi-job key <id> <key>",
	"pi-job cancel <id>",
}, "\n")

// usageErrors is TS USAGE_ERRORS.
var usageErrors = map[string]struct{}{
	"invalid_command_args": {}, "invalid_duration": {}, "invalid_cursor": {}, "invalid_id": {}, "input_too_large": {}, "invalid_key": {},
}

// DefaultWaitMs is TS DEFAULT_WAIT_MS.
const DefaultWaitMs = 5000

// ParseDuration is TS parseDuration.
func ParseDuration(value *string) int64 {
	if value == nil {
		panic(NewAsyncShellError("invalid_duration", "A duration value is required."))
	}
	match := durationPattern.FindStringSubmatch(*value)
	if match == nil {
		panic(NewAsyncShellError("invalid_duration", "Not a duration: "+*value))
	}
	amount := parseFloatDigits(match[1])
	unit := "ms"
	if match[2] != "" {
		unit = match[2]
	}
	var factor float64
	switch unit {
	case "ms":
		factor = 1
	case "s":
		factor = 1000
	case "m":
		factor = 60000
	default:
		factor = 3600000
	}
	total := amount * factor
	if !isSafeIntegerFloat(total) || total < 0 {
		panic(NewAsyncShellError("invalid_duration", "Not a duration: "+*value))
	}
	return int64(total)
}

// parseCursor is TS parseCursor (not exported in TS).
func parseCursor(value *string) *int64 {
	if value == nil {
		return nil
	}
	if !cursorPattern.MatchString(*value) {
		panic(NewAsyncShellError("invalid_cursor", "Not a byte cursor: "+*value))
	}
	n, _ := parseInt64(*value)
	return &n
}

// CreateArgs is TS CreateArgs.
type CreateArgs struct {
	Argv      []string
	Cwd       string
	WaitMs    int64
	TimeoutMs *int64
}

// ParseCreateArgs is TS parseCreateArgs.
func ParseCreateArgs(tokens []string) CreateArgs {
	waitMs := int64(DefaultWaitMs)
	var timeoutMs *int64
	cwd, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	index := 0
	for ; index < len(tokens); index++ {
		token := tokens[index]
		if token == "--" {
			index++
			break
		}
		if !strings.HasPrefix(token, "-") || token == "-" {
			break
		}
		switch token {
		case "--wait":
			var next *string
			if index+1 < len(tokens) {
				next = &tokens[index+1]
			}
			waitMs = ParseDuration(next)
			index++
		case "--timeout":
			var next *string
			if index+1 < len(tokens) {
				next = &tokens[index+1]
			}
			timeoutMs = int64Ptr(ParseDuration(next))
			index++
		case "--cwd":
			value := ""
			if index+1 < len(tokens) {
				value = tokens[index+1]
			}
			if value == "" {
				panic(NewAsyncShellError("invalid_command_args", "--cwd requires a directory."))
			}
			cwd = value
			index++
		default:
			panic(NewAsyncShellError("invalid_command_args", "Unknown create option: "+token))
		}
	}
	argv := tokens[index:]
	if len(argv) == 0 {
		panic(NewAsyncShellError("invalid_command_args", "create requires a command after --."))
	}
	return CreateArgs{Argv: argv, Cwd: cwd, WaitMs: waitMs, TimeoutMs: timeoutMs}
}

// readStdin is TS readStdin: all of stdin, byte for byte, bounded while reading.
func readStdin(maxBytes int) string {
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		panic(err)
	}
	if len(data) > maxBytes {
		panic(NewAsyncShellError("input_too_large", "Input must not exceed "+formatInt(maxBytes)+" bytes."))
	}
	return string(data)
}

func report(result ShellResult) {
	os.Stdout.WriteString(FormatResult(result))
}

// run is TS run(): dispatch one verb. Errors are panicked (TS: thrown).
func run(argv []string) {
	var verb string
	var rest []string
	if len(argv) > 0 {
		verb = argv[0]
		rest = argv[1:]
	}
	switch verb {
	case "create":
		parsed := ParseCreateArgs(rest)
		options := CreateTaskOptions{
			Argv: parsed.Argv, Cwd: parsed.Cwd, TimeoutMs: parsed.TimeoutMs, WaitMs: parsed.WaitMs,
			Callback: CallbackFromEnv(),
		}
		report(CreateTask(options))
	case "poll":
		id := ""
		if len(rest) > 0 {
			id = rest[0]
		}
		cursor := readCursorOption(rest[1:])
		report(PollTask(TaskDirectory(requireId(id, "poll"), StateRoot()), cursor))
	case "read":
		id := ""
		if len(rest) > 0 {
			id = rest[0]
		}
		cursor := readCursorOption(rest[1:])
		report(ReadTask(TaskDirectory(requireId(id, "read"), StateRoot()), cursor))
	case "send":
		enter := false
		var positional []string
		for _, token := range rest {
			if token == "--enter" {
				enter = true
			} else {
				positional = append(positional, token)
			}
		}
		for _, token := range positional {
			if strings.HasPrefix(token, "-") {
				panic(NewAsyncShellError("invalid_command_args", "Unknown send option: "+token))
			}
		}
		if len(positional) != 1 {
			panic(NewAsyncShellError("invalid_command_args", "send takes one task id."))
		}
		dir := TaskDirectory(requireId(positional[0], "send"), StateRoot())
		input := readStdin(MaxSendBytes)
		SendInput(dir, input, enter)
		report(PollTask(dir, nil))
	case "key":
		var id, key string
		var extra []string
		if len(rest) > 0 {
			id = rest[0]
		}
		if len(rest) > 1 {
			key = rest[1]
		}
		if len(rest) > 2 {
			extra = rest[2:]
		}
		if len(extra) != 0 {
			panic(NewAsyncShellError("invalid_command_args", "key takes one task id and one key name."))
		}
		dir := TaskDirectory(requireId(id, "key"), StateRoot())
		if key == "" {
			panic(NewAsyncShellError("invalid_command_args", "key requires a key name."))
		}
		SendKey(dir, key)
		report(PollTask(dir, nil))
	case "cancel":
		var id string
		var extra []string
		if len(rest) > 0 {
			id = rest[0]
		}
		if len(rest) > 1 {
			extra = rest[1:]
		}
		if len(extra) != 0 {
			panic(NewAsyncShellError("invalid_command_args", "cancel takes one task id."))
		}
		dir := TaskDirectory(requireId(id, "cancel"), StateRoot())
		CancelTask(dir)
		report(PollTask(dir, nil))
	case "__run":
		os.Exit(RunnerMain(requireDirectory(rest)))
	case "__monitor":
		MonitorMain(requireDirectory(rest))
	default:
		panic(NewAsyncShellError("invalid_command_args", Usage))
	}
}

func requireId(value string, verb string) string {
	if value == "" {
		panic(NewAsyncShellError("invalid_command_args", verb+" requires a task id."))
	}
	return value
}

func requireDirectory(rest []string) string {
	value := ""
	if len(rest) > 0 {
		value = rest[0]
	}
	if value == "" {
		panic(NewAsyncShellError("invalid_command_args", "Internal mode requires a task directory."))
	}
	return value
}

func readCursorOption(options []string) *int64 {
	if len(options) == 0 {
		return nil
	}
	if len(options) == 2 && options[0] == "--cursor" {
		return parseCursor(&options[1])
	}
	panic(NewAsyncShellError("invalid_command_args", "Unknown option: "+options[0]))
}

// Main is TS main(): Node's argv is [execPath, script, ...]; Go's is
// [executable, ...], so the verb starts at argv[1] here. The rest of the
// dispatch and the try/catch boundary are unchanged.
func Main(fullArgv []string) int {
	var argv []string
	if len(fullArgv) > 1 {
		argv = fullArgv[1:]
	}
	internal := len(argv) > 0 && (argv[0] == "__run" || argv[0] == "__monitor")
	exitCode := 0
	func() {
		defer func() {
			recovered := recover()
			if recovered == nil {
				return
			}
			errorCode := "internal_error"
			message := "internal error: " + messageOf(recovered)
			if err, ok := recovered.(*AsyncShellError); ok {
				errorCode = err.Code
				message = err.Message
			}
			if internal {
				os.Stderr.WriteString("pi-job: " + message + "\n")
			} else {
				var usage *string
				if _, isUsage := usageErrors[errorCode]; isUsage {
					u := Usage
					usage = &u
				}
				os.Stderr.WriteString(FormatError(message, usage))
			}
			exitCode = 1
		}()
		run(argv)
	}()
	return exitCode
}
