package asyncshell

import (
	"io"
	"os"
	"runtime"
	"strings"
)

// seam_process.go implements the node:process globals used by the engine.

// ProcessArgv is process.argv.
func ProcessArgv() []string { return os.Args }

// ProcessExecPath is process.execPath.
func ProcessExecPath() string {
	executable, err := os.Executable()
	if err != nil {
		panic(coded(err, "EIO"))
	}
	return executable
}

// ProcessExecArgv is process.execArgv (Go has no interpreter flags).
func ProcessExecArgv() []string { return []string{} }

// ProcessEnv is process.env.
func ProcessEnv() map[string]string {
	env := map[string]string{}
	for _, entry := range os.Environ() {
		if index := strings.IndexByte(entry, '='); index >= 0 {
			env[entry[:index]] = entry[index+1:]
		}
	}
	return env
}

// ProcessPlatform is process.platform.
func ProcessPlatform() string { return runtime.GOOS }

// ProcessGetuid is process.getuid?.(); Windows reports -1 like Node's absence.
func ProcessGetuid() int { return os.Getuid() }

// ProcessPid is process.pid.
func ProcessPid() int { return os.Getpid() }

// ProcessCwd is process.cwd().
func ProcessCwd() string {
	directory, err := os.Getwd()
	if err != nil {
		panic(coded(err, "EIO"))
	}
	return directory
}

// ProcessStdoutWrite is process.stdout.write(text).
func ProcessStdoutWrite(text string) { _, _ = os.Stdout.WriteString(text) }

// ProcessStderrWrite is process.stderr.write(text).
func ProcessStderrWrite(text string) { _, _ = os.Stderr.WriteString(text) }

// ProcessExit is process.exit(code).
func ProcessExit(code int) { os.Exit(code) }

// ProcessStdinRead is reading all of process.stdin up to maxBytes (readStdin).
func ProcessStdinRead(maxBytes int) (string, error) {
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		return "", coded(err, "EIO")
	}
	if len(data) > maxBytes {
		return "", NewAsyncShellError("input_too_large", "Input must not exceed "+formatInt(maxBytes)+" bytes.")
	}
	return string(data), nil
}
