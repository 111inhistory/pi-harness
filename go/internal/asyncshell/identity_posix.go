//go:build !windows

package asyncshell

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"

	"pijob/internal/asyncshell/aserr"
	shellbackend "pijob/internal/asyncshell/backend"
)

const usesFilesystemSocket = true

func isNoFilesystemSocket(error) bool { return false }

func createOwnedDirectory(root string, id string) (string, ownershipID, error) {
	rootFD, err := unix.Open(root, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return "", ownershipID{}, err
	}
	defer unix.Close(rootFD)
	var rootStat unix.Stat_t
	if err := unix.Fstat(rootFD, &rootStat); err != nil {
		return "", ownershipID{}, err
	}
	if err := verifyPrivateDirectoryStat(&rootStat, root); err != nil {
		return "", ownershipID{}, err
	}
	if err := unix.Mkdirat(rootFD, id, 0o700); err != nil {
		return "", ownershipID{}, err
	}
	dirFD, err := unix.Openat(rootFD, id, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return "", ownershipID{}, err
	}
	defer unix.Close(dirFD)
	var dirStat unix.Stat_t
	if err := unix.Fstat(dirFD, &dirStat); err != nil {
		return "", ownershipID{}, err
	}
	identity := identityFromStat(&dirStat)
	if err := verifyPrivateDirectoryStat(&dirStat, filepath.Join(root, id)); err != nil {
		return "", ownershipID{}, err
	}
	return filepath.Join(root, id), identity, nil
}

func directoryIdentity(path string) (ownershipID, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return ownershipID{}, err
	}
	defer unix.Close(fd)
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return ownershipID{}, err
	}
	if err := verifyPrivateDirectoryStat(&stat, path); err != nil {
		return ownershipID{}, err
	}
	return identityFromStat(&stat), nil
}

func socketIdentity(path string) (ownershipID, error) {
	var stat unix.Stat_t
	if err := unix.Lstat(path, &stat); err != nil {
		return ownershipID{}, err
	}
	if err := verifyOwnedSocketStat(&stat); err != nil {
		return ownershipID{}, err
	}
	return identityFromStat(&stat), nil
}

func identityFromStat(stat *unix.Stat_t) ownershipID {
	return ownershipID{Dev: uint64(stat.Dev), Ino: uint64(stat.Ino), Uid: stat.Uid, Mode: uint32(stat.Mode)}
}

func verifyPrivateDirectoryStat(stat *unix.Stat_t, path string) error {
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
		return fmt.Errorf("not a directory: %s", path)
	}
	if int(stat.Uid) != os.Geteuid() || stat.Mode&0o077 != 0 {
		return fmt.Errorf("directory is not private to the effective user: %s", path)
	}
	return nil
}

func verifyOwnedSocketStat(stat *unix.Stat_t) error {
	if stat.Mode&unix.S_IFMT != unix.S_IFSOCK {
		return fmt.Errorf("not a Unix socket")
	}
	if int(stat.Uid) != os.Geteuid() || stat.Mode&0o077 != 0 {
		return fmt.Errorf("socket is not owned by the effective user")
	}
	return nil
}

func verifyRootDirectory(path string) error {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return err
	}
	return verifyPrivateDirectoryStat(&stat, path)
}

func verifySidecarDirectory(path string) error {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return err
	}
	return verifyPrivateDirectoryStat(&stat, path)
}

func readSidecarFile(path string) ([]byte, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("cannot open ownership sidecar: %s", path)
	}
	defer file.Close()
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return nil, err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Mode&0o077 != 0 || int(stat.Uid) != os.Geteuid() {
		return nil, fmt.Errorf("ownership sidecar is not a private regular file: %s", path)
	}
	return io.ReadAll(file)
}

func verifySidecarFile(path string) error {
	var stat unix.Stat_t
	if err := unix.Lstat(path, &stat); err != nil {
		return err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Mode&0o077 != 0 || int(stat.Uid) != os.Geteuid() {
		return fmt.Errorf("ownership sidecar is not a private regular file: %s", path)
	}
	return nil
}

func verifyDirectoryIdentity(path string, want ownershipID) error {
	got, err := directoryIdentity(path)
	if err != nil {
		return err
	}
	if got.Dev != want.Dev || got.Ino != want.Ino || got.Uid != want.Uid || got.Mode != want.Mode {
		return fmt.Errorf("task directory identity changed: %s", path)
	}
	return nil
}

func verifySocketIdentity(path string, want ownershipID) error {
	got, err := socketIdentity(path)
	if err != nil {
		return err
	}
	if got.Dev != want.Dev || got.Ino != want.Ino || got.Uid != want.Uid || got.Mode != want.Mode {
		return fmt.Errorf("task socket identity changed: %s", path)
	}
	return nil
}

func socketEntryExists(dir string) bool {
	_, err := os.Lstat(filepath.Join(dir, taskSocketName))
	return err == nil
}

// unlinkOwnedSocket removes only the recorded inode after re-checking the task
// directory, socket identity and a stopped probe through the directory fd.
func unlinkOwnedSocket(dir string, record ownershipRecord, serverExited bool) error {
	if record.Socket == nil {
		return nil
	}
	root := StateRoot()
	if err := verifyRootDirectory(root); err != nil {
		return aserr.New("socket_unknown", "The async-shell root is not private: "+messageOf(err))
	}
	rootFD, err := unix.Open(root, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return aserr.New("socket_unknown", "Cannot open the async-shell root for socket cleanup: "+messageOf(err))
	}
	defer unix.Close(rootFD)
	dirFD, err := unix.Openat(rootFD, filepath.Base(dir), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return aserr.New("socket_unknown", "Cannot open the task directory for socket cleanup: "+messageOf(err))
	}
	defer unix.Close(dirFD)
	var dirStat unix.Stat_t
	if err := unix.Fstat(dirFD, &dirStat); err != nil {
		return aserr.New("socket_unknown", "Cannot inspect the task directory for socket cleanup: "+messageOf(err))
	}
	if identityFromStat(&dirStat).Dev != record.Directory.Dev || identityFromStat(&dirStat).Ino != record.Directory.Ino {
		return aserr.New("socket_unknown", "The task directory identity changed; its socket is left in place.")
	}
	var socketStat unix.Stat_t
	if err := unix.Fstatat(dirFD, taskSocketName, &socketStat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return aserr.New("socket_unknown", "The recorded task socket disappeared; it is not treated as released.")
		}
		return aserr.New("socket_unknown", "Cannot inspect the task socket before cleanup: "+messageOf(err))
	}
	current := identityFromStat(&socketStat)
	if current.Dev != record.Socket.Dev || current.Ino != record.Socket.Ino || current.Uid != record.Socket.Uid || current.Mode != record.Socket.Mode {
		return aserr.New("socket_unknown", "The task socket identity changed; it is left in place.")
	}
	state, err := backend.ServerState(dir, socketProbeTimeoutMs)
	if err != nil || state == shellbackend.ServerUnknown || state == shellbackend.ServerMissing || state == shellbackend.ServerRunning {
		return aserr.New("socket_unknown", "The task's terminal server is not confirmed stopped; its socket is left in place.")
	}
	if state == shellbackend.ServerSuspect && !serverExited {
		return aserr.New("socket_unknown", "The terminal server process exit is not proven; its socket is left in place.")
	}
	if err := unix.Unlinkat(dirFD, taskSocketName, 0); err != nil && !errors.Is(err, unix.ENOENT) {
		return aserr.New("socket_cleanup_failed", "Cannot remove the task socket: "+messageOf(err))
	}
	return nil
}
