//go:build windows

package asyncshell

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

const (
	usesFilesystemSocket = false
	// Windows ServerState spawns psmux.exe, so each probe needs the same
	// subprocess timeout budget as other cancel-scoped controls, and post-kill
	// confirmation allows slower ConPTY/server teardown without tight polling.
	serverProbeTimeoutMs = CancelControlTimeoutMs
	postKillWaitMs       = 5_000
	postKillPollDelayMs  = 100
)

var errNoFilesystemSocket = fmt.Errorf("the psmux backend uses a named pipe, not a filesystem socket")

func isNoFilesystemSocket(err error) bool { return err == errNoFilesystemSocket }

func createOwnedDirectory(root string, id string) (string, ownershipID, error) {
	dir := filepath.Join(root, id)
	if err := os.Mkdir(dir, 0o700); err != nil {
		return "", ownershipID{}, err
	}
	identity, err := directoryIdentity(dir)
	if err != nil {
		return "", ownershipID{}, err
	}
	return dir, identity, nil
}

func directoryIdentity(path string) (ownershipID, error) {
	pointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return ownershipID{}, err
	}
	handle, err := windows.CreateFile(pointer, windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return ownershipID{}, err
	}
	defer windows.CloseHandle(handle)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return ownershipID{}, err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return ownershipID{}, fmt.Errorf("not a directory: %s", path)
	}
	return ownershipID{
		Dev:  uint64(info.VolumeSerialNumber),
		Ino:  uint64(info.FileIndexHigh)<<32 | uint64(info.FileIndexLow),
		Mode: uint32(info.FileAttributes),
	}, nil
}

func socketIdentity(path string) (ownershipID, error) { return ownershipID{}, errNoFilesystemSocket }

func verifyRootDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("async-shell root is not a real directory: %s", path)
	}
	return nil
}

func verifySidecarDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("ownership sidecar directory is not a real directory: %s", path)
	}
	return nil
}

func readSidecarFile(path string) ([]byte, error) {
	if err := verifySidecarFile(path); err != nil {
		return nil, err
	}
	return os.ReadFile(path)
}

func verifySidecarFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return fmt.Errorf("ownership sidecar is not a regular file: %s", path)
	}
	return nil
}

func verifyDirectoryIdentity(path string, want ownershipID) error {
	got, err := directoryIdentity(path)
	if err != nil {
		return err
	}
	if got.Dev != want.Dev || got.Ino != want.Ino {
		return fmt.Errorf("task directory identity changed: %s", path)
	}
	return nil
}

func verifySocketIdentity(string, ownershipID) error { return nil }

func socketEntryExists(string) bool { return false }

func unlinkOwnedSocket(string, ownershipRecord, bool) error { return nil }
