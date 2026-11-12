package asyncshell

import (
	"fmt"
	"os"
)

// samePath reports whether two existing paths name the same directory.
//
// The cancellation root and the task directory both exist by the time this
// check runs; file identity is the only reliable answer on Windows, where a
// directory (or share) may be case-sensitive and a lexical lowercase comparison
// can equate distinct entries. A failed inspection is therefore returned as an
// error instead of being replaced by a cleaned-string fallback: missing,
// inaccessible and identity-unknown paths are different failures.
//
// This is filesystem identity only. A Named Pipe address is a kernel object
// name (case-insensitive), not a filesystem path; compare pipes in the IPC
// adapter, never here.
func samePath(left string, right string) (bool, error) {
	leftInfo, err := os.Stat(left)
	if err != nil {
		return false, fmt.Errorf("cannot inspect directory %s: %w", left, err)
	}
	rightInfo, err := os.Stat(right)
	if err != nil {
		return false, fmt.Errorf("cannot inspect directory %s: %w", right, err)
	}
	return os.SameFile(leftInfo, rightInfo), nil
}
