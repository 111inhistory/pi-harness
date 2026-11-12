//go:build !windows

package proc

import "pijob/internal/asyncshell/aserr"

// ChildCommandFor passes the task argv through unchanged on POSIX.
func ChildCommandFor(argv []string, _ map[string]string, _ string) (ChildCommand, error) {
	var file string
	if len(argv) > 0 {
		file = argv[0]
	}
	if file == "" {
		return ChildCommand{}, aserr.New("invalid_command_args", "create requires a command.")
	}
	return ChildCommand{File: file, Args: argv[1:], Verbatim: false}, nil
}
