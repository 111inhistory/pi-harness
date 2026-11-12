//go:build !windows

package asyncshell

import (
	"fmt"
	"os"
	"syscall"
)

// private_posix.go implements the POSIX private-directory ownership/mode check.
func ensurePrivateDirectory(directory string) error {
	info, err := os.Lstat(directory)
	if err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return err
		}
		info, err = os.Lstat(directory)
		if err != nil {
			return err
		}
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return &codedError{Code: "ipc_directory_symlink", Err: fmt.Errorf("Refusing IPC directory symlink: %s", directory)}
	}
	if !info.IsDir() {
		return &codedError{Code: "ipc_directory_not_directory", Err: fmt.Errorf("IPC parent is not a directory: %s", directory)}
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		if int(stat.Uid) != os.Getuid() || stat.Mode&0o077 != 0 {
			return &codedError{Code: "ipc_directory_insecure", Err: fmt.Errorf("IPC directory is not private to the effective user: %s", directory)}
		}
	}
	return nil
}
