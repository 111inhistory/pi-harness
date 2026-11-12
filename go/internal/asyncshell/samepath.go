package asyncshell

import (
	"os"
	"path/filepath"
)

// samePath reports whether both paths name the same directory.
//
// File identity decides when both exist: Windows can be case-sensitive per
// directory or SMB share, so folding case is not a valid equivalence rule, and
// Unicode case folding is not the filesystem's ordinal comparison anyway.
// A missing path cannot be compared by identity; it falls back to an exact
// cleaned-string comparison, never a case-folded one.
//
// This is filesystem identity only. A Named Pipe address is a kernel object
// name (case-insensitive), not a filesystem path; compare pipes in the IPC
// adapter, never here.
func samePath(left string, right string) bool {
	leftInfo, leftErr := os.Stat(left)
	rightInfo, rightErr := os.Stat(right)
	if leftErr == nil && rightErr == nil {
		return os.SameFile(leftInfo, rightInfo)
	}
	return filepath.Clean(left) == filepath.Clean(right)
}
