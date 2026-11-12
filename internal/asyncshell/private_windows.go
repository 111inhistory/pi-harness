//go:build windows

package asyncshell

import (
	"fmt"
	"os"
)

// private_windows.go: the ACL-based verification from
// src/ipc/private-directory-windows.ts is not implemented in this stage; the
// seam fails closed instead of treating an unverified directory as private.
// TODO(language-adaptation/windows): implement the ACL check.
func ensurePrivateDirectory(directory string) error {
	if _, err := os.Lstat(directory); err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return err
		}
	}
	return &codedError{Code: "ipc_directory_unverified", Err: fmt.Errorf("Windows private-directory ACL verification is not implemented: %s", directory)}
}
