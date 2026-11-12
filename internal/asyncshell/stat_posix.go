//go:build !windows

package asyncshell

import (
	"os"
	"syscall"
)

// statFrom is the POSIX fs.Stats projection used by the seams.
func statFrom(info os.FileInfo) Stat {
	stat := Stat{
		Size:   info.Size(),
		IsDir:  info.IsDir(),
		IsFile: info.Mode().IsRegular(),
		IsLink: info.Mode()&os.ModeSymlink != 0,
		Mode:   uint32(info.Mode().Perm()),
	}
	if system, ok := info.Sys().(*syscall.Stat_t); ok {
		stat.Uid = int(system.Uid)
		stat.Dev = uint64(system.Dev)
		stat.Ino = uint64(system.Ino)
		stat.Mode = uint32(system.Mode)
	}
	return stat
}
