//go:build !windows

package asyncshell

import (
	"fmt"
	"os"
)

// EnsurePrivateDirectory is ensurePrivateDirectory on POSIX.
func EnsurePrivateDirectory(directory string) error {
	info, err := os.Lstat(directory)
	if err != nil {
		if !os.IsNotExist(err) {
			return coded(err, "EIO")
		}
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return coded(err, "EIO")
		}
		info, err = os.Lstat(directory)
		if err != nil {
			return coded(err, "EIO")
		}
	}
	stat := statFrom(info)
	if stat.IsLink {
		return &codedError{Code: "ipc_directory_symlink", Err: fmt.Errorf("Refusing IPC directory symlink: %s", directory)}
	}
	if !stat.IsDir {
		return &codedError{Code: "ipc_directory_not_directory", Err: fmt.Errorf("IPC parent is not a directory: %s", directory)}
	}
	private, err := privateDirectory(directory, stat)
	if err != nil {
		return err
	}
	if !private {
		return &codedError{Code: "ipc_directory_insecure", Err: fmt.Errorf("IPC directory is not private to the effective user: %s", directory)}
	}
	return nil
}
