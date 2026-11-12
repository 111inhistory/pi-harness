package asyncshell

import (
	"io"
	"os"
	"pijob/internal/asyncshell/aserr"
	"strings"
)

// cli.go translates src/async-shell/cli.ts.
//
// Handle-able failures are returned as errors here. The engine still reports a
// few invalid states with panic; `run` is the one boundary that converts any
// escaped panic into an error, so the CLI surface never crashes with a stack.

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
func ParseDuration(value *string) (int64, error) {
	if value == nil {
		return 0, aserr.New("invalid_duration", "A duration value is required.")
	}
	match := durationPattern.FindStringSubmatch(*value)
	if match == nil {
		return 0, aserr.New("invalid_duration", "Not a duration: "+*value)
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
		return 0, aserr.New("invalid_duration", "Not a duration: "+*value)
	}
	return int64(total), nil
}

// parseCursor is TS parseCursor (not exported in TS).
func parseCursor(value *string) (*int64, error) {
	if value == nil {
		return nil, nil
	}
	if !cursorPattern.MatchString(*value) {
		return nil, aserr.New("invalid_cursor", "Not a byte cursor: "+*value)
	}
	n, _ := parseInt64(*value)
	return &n, nil
}

// CreateArgs is TS CreateArgs.
type CreateArgs struct {
	Argv      []string
	Cwd       string
	WaitMs    int64
	TimeoutMs *int64
}

// ParseCreateArgs is TS parseCreateArgs.
func ParseCreateArgs(tokens []string) (CreateArgs, error) {
	waitMs := int64(DefaultWaitMs)
	var timeoutMs *int64
	cwd, err := os.Getwd()
	if err != nil {
		return CreateArgs{}, err
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
			waitMs, err = ParseDuration(next)
			if err != nil {
				return CreateArgs{}, err
			}
			index++
		case "--timeout":
			var next *string
			if index+1 < len(tokens) {
				next = &tokens[index+1]
			}
			duration, err := ParseDuration(next)
			if err != nil {
				return CreateArgs{}, err
			}
			timeoutMs = &duration
			index++
		case "--cwd":
			value := ""
			if index+1 < len(tokens) {
				value = tokens[index+1]
			}
			if value == "" {
				return CreateArgs{}, aserr.New("invalid_command_args", "--cwd requires a directory.")
			}
			cwd = value
			index++
		default:
			return CreateArgs{}, aserr.New("invalid_command_args", "Unknown create option: "+token)
		}
	}
	argv := tokens[index:]
	if len(argv) == 0 {
		return CreateArgs{}, aserr.New("invalid_command_args", "create requires a command after --.")
	}
	return CreateArgs{Argv: argv, Cwd: cwd, WaitMs: waitMs, TimeoutMs: timeoutMs}, nil
}

// readStdin is TS readStdin: all of stdin, byte for byte, bounded while reading.
func readStdin(maxBytes int) (string, error) {
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		return "", err
	}
	if len(data) > maxBytes {
		return "", aserr.New("input_too_large", "Input must not exceed "+formatInt(maxBytes)+" bytes.")
	}
	return string(data), nil
}

func report(result ShellResult) error {
	_, err := os.Stdout.WriteString(FormatResult(result))
	return err
}

// run is TS run(): dispatch one verb. Handle-able failures return an error; an
// escaped engine panic is converted at this single boundary.
func run(argv []string) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = aserr.AsError(recovered)
		}
	}()
	var verb string
	var rest []string
	if len(argv) > 0 {
		verb = argv[0]
		rest = argv[1:]
	}
	switch verb {
	case "create":
		parsed, parseErr := ParseCreateArgs(rest)
		if parseErr != nil {
			return parseErr
		}
		options := CreateTaskOptions{
			Argv: parsed.Argv, Cwd: parsed.Cwd, TimeoutMs: parsed.TimeoutMs, WaitMs: parsed.WaitMs,
			Callback: CallbackFromEnv(),
		}
		result, taskErr := CreateTask(options)
		if taskErr != nil {
			return taskErr
		}
		return report(result)
	case "poll":
		id := ""
		if len(rest) > 0 {
			id = rest[0]
		}
		cursor, cursorErr := readCursorOption(tail(rest, 1))
		if cursorErr != nil {
			return cursorErr
		}
		taskID, idErr := requireId(id, "poll")
		if idErr != nil {
			return idErr
		}
		dir, dirErr := TaskDirectory(taskID, StateRoot())
		if dirErr != nil {
			return dirErr
		}
		result, taskErr := PollTask(dir, cursor)
		if taskErr != nil {
			return taskErr
		}
		return report(result)
	case "read":
		id := ""
		if len(rest) > 0 {
			id = rest[0]
		}
		cursor, cursorErr := readCursorOption(tail(rest, 1))
		if cursorErr != nil {
			return cursorErr
		}
		taskID, idErr := requireId(id, "read")
		if idErr != nil {
			return idErr
		}
		dir, dirErr := TaskDirectory(taskID, StateRoot())
		if dirErr != nil {
			return dirErr
		}
		result, taskErr := ReadTask(dir, cursor)
		if taskErr != nil {
			return taskErr
		}
		return report(result)
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
				return aserr.New("invalid_command_args", "Unknown send option: "+token)
			}
		}
		if len(positional) != 1 {
			return aserr.New("invalid_command_args", "send takes one task id.")
		}
		taskID, idErr := requireId(positional[0], "send")
		if idErr != nil {
			return idErr
		}
		dir, dirErr := TaskDirectory(taskID, StateRoot())
		if dirErr != nil {
			return dirErr
		}
		input, stdinErr := readStdin(MaxSendBytes)
		if stdinErr != nil {
			return stdinErr
		}
		if err := SendInput(dir, input, enter); err != nil {
			return err
		}
		result, taskErr := PollTask(dir, nil)
		if taskErr != nil {
			return taskErr
		}
		return report(result)
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
			return aserr.New("invalid_command_args", "key takes one task id and one key name.")
		}
		taskID, idErr := requireId(id, "key")
		if idErr != nil {
			return idErr
		}
		dir, dirErr := TaskDirectory(taskID, StateRoot())
		if dirErr != nil {
			return dirErr
		}
		if key == "" {
			return aserr.New("invalid_command_args", "key requires a key name.")
		}
		if err := SendKey(dir, key); err != nil {
			return err
		}
		result, taskErr := PollTask(dir, nil)
		if taskErr != nil {
			return taskErr
		}
		return report(result)
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
			return aserr.New("invalid_command_args", "cancel takes one task id.")
		}
		taskID, idErr := requireId(id, "cancel")
		if idErr != nil {
			return idErr
		}
		dir, dirErr := TaskDirectory(taskID, StateRoot())
		if dirErr != nil {
			return dirErr
		}
		if err := CancelTask(dir); err != nil {
			return err
		}
		result, taskErr := PollTask(dir, nil)
		if taskErr != nil {
			return taskErr
		}
		return report(result)
	case "__run":
		directory, dirErr := requireDirectory(rest)
		if dirErr != nil {
			return dirErr
		}
		os.Exit(RunnerMain(directory))
		return nil
	case "__monitor":
		directory, dirErr := requireDirectory(rest)
		if dirErr != nil {
			return dirErr
		}
		MonitorMain(directory)
		return nil
	default:
		return aserr.New("invalid_command_args", Usage)
	}
}

func tail(values []string, from int) []string {
	if from >= len(values) {
		return nil
	}
	return values[from:]
}

func requireId(value string, verb string) (string, error) {
	if value == "" {
		return "", aserr.New("invalid_command_args", verb+" requires a task id.")
	}
	return value, nil
}

func requireDirectory(rest []string) (string, error) {
	value := ""
	if len(rest) > 0 {
		value = rest[0]
	}
	if value == "" {
		return "", aserr.New("invalid_command_args", "Internal mode requires a task directory.")
	}
	return value, nil
}

func readCursorOption(options []string) (*int64, error) {
	if len(options) == 0 {
		return nil, nil
	}
	if len(options) == 2 && options[0] == "--cursor" {
		return parseCursor(&options[1])
	}
	return nil, aserr.New("invalid_command_args", "Unknown option: "+options[0])
}

// Main is TS main(): Node's argv is [execPath, script, ...]; Go's is
// [executable, ...], so the verb starts at argv[1] here.
func Main(fullArgv []string) (exitCode int) {
	var argv []string
	if len(fullArgv) > 1 {
		argv = fullArgv[1:]
	}
	internal := len(argv) > 0 && (argv[0] == "__run" || argv[0] == "__monitor")
	defer func() {
		if recovered := recover(); recovered != nil {
			writeMainError(internal, aserr.AsError(recovered))
			exitCode = 1
		}
	}()
	if err := run(argv); err != nil {
		writeMainError(internal, err)
		return 1
	}
	return 0
}

func writeMainError(internal bool, err error) {
	errorCode := "internal_error"
	message := err.Error()
	if typed, ok := err.(*aserr.Error); ok {
		errorCode = typed.Code
		message = typed.Message
	}
	if internal {
		os.Stderr.WriteString("pi-job: " + message + "\n")
		return
	}
	var usage *string
	if _, isUsage := usageErrors[errorCode]; isUsage {
		u := Usage
		usage = &u
	}
	os.Stderr.WriteString(FormatError(message, usage))
}
