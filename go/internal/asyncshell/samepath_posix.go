//go:build !windows

package asyncshell

import "path/filepath"

func samePath(left string, right string) bool {
	leftResolved, leftErr := filepath.Abs(left)
	rightResolved, rightErr := filepath.Abs(right)
	if leftErr != nil || rightErr != nil {
		return false
	}
	return leftResolved == rightResolved
}
