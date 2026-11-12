package asyncshell

import (
	"os"

	"pijob/internal/asyncshell/aserr"
)

// SelfArgv is TS selfArgv adapted to a single native binary: the pane re-runs
// this executable in an internal mode.
func SelfArgv(dir string, mode string) ([]string, error) {
	executable, err := os.Executable()
	if err != nil || executable == "" {
		return nil, aserr.New("self_unresolved", "The async-shell CLI cannot locate its own entry point.")
	}
	return []string{executable, mode, dir}, nil
}
