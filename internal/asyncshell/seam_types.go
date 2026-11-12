package asyncshell

import "os"

// seam_types.go: shared boundary types for the TS-runtime seams. These keep the
// translated call sites unchanged while the bodies are implemented in Go.

// FileOptions is the subset of fs write/append options used (mode).
type FileOptions struct {
	Mode *uint32
}

// MkdirOptions is fs mkdir options (recursive, mode).
type MkdirOptions struct {
	Recursive bool
	Mode      *uint32
}

// Stat is the fs stat subset the sources read.
type Stat struct {
	Size   int64
	IsDir  bool
	IsFile bool
	IsLink bool
	Mode   uint32
	Uid    int
	Dev    uint64
	Ino    uint64
}

// SpawnOptions is the spawnSync options subset used.
type SpawnOptions struct {
	Encoding            *string
	TimeoutMs           *int
	Input               *string
	WindowsHide         bool
	Env                 map[string]string
	WindowsVerbatimArgs bool
}

// SpawnResult is the spawnSync result subset used.
type SpawnResult struct {
	Status *int
	Stdout string
	Stderr string
	Error  error
	Pid    int
}

// SpawnInheritOptions is the spawn options used by runnerMain.
type SpawnInheritOptions struct {
	Cwd                      string
	Env                      map[string]string
	StdioInherit             bool
	WindowsVerbatimArguments bool
}

// ChildProcess models the node ChildProcess events runnerMain uses.
type ChildProcess struct {
	Pid           *int
	cmd           *os.Process
	exitHandlers  []func(code *int, signal *string)
	errorHandlers []func(err error)
	waitErr       error
}

// SpawnDetachedOptions is the detached monitor spawn options.
type SpawnDetachedOptions struct {
	Detached    bool
	StdioIgnore bool
	Env         map[string]string
}

// DetachedChild is the monitor ChildProcess subset (pid + unref).
type DetachedChild struct {
	Pid *int
}

// Unref is child.unref(); the Go process is already detached.
func (c DetachedChild) Unref() {}

// codedError carries the Node-style `error.code` through a Go error.
type codedError struct {
	Code string
	Err  error
}

func (e *codedError) Error() string {
	if e.Err != nil {
		return e.Err.Error()
	}
	return e.Code
}

func (e *codedError) ErrorCode() string { return e.Code }

// coded wraps an OS error with the Node-style code when one can be derived.
func coded(err error, fallback string) error {
	if err == nil {
		return nil
	}
	code := errnoName(err)
	if code == "" {
		switch {
		case os.IsNotExist(err):
			code = "ENOENT"
		case os.IsPermission(err):
			code = "EACCES"
		case os.IsExist(err):
			code = "EEXIST"
		default:
			code = fallback
		}
	}
	return &codedError{Code: code, Err: err}
}

// envSlice converts a map to the KEY=VALUE form used by os/exec.
func envSlice(env map[string]string) []string {
	if env == nil {
		return nil
	}
	out := make([]string, 0, len(env))
	for key, value := range env {
		out = append(out, key+"="+value)
	}
	return out
}
