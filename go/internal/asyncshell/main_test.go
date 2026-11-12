package asyncshell

import (
	"os"
	"testing"
)

// TestMain forwards the pane runner and monitor modes to the production CLI
// entry point. CreateTask launches os.Executable(), which is the test binary
// under `go test`; without this, those child processes would run the test
// harness instead of the internal modes.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && (os.Args[1] == "__run" || os.Args[1] == "__monitor") {
		os.Exit(Main(os.Args))
	}
	os.Exit(m.Run())
}
