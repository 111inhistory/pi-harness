//go:build windows

package asyncshell

import "os"

// statFrom is the Windows fs.Stats projection; uid/dev/ino are not meaningful.
func statFrom(info os.FileInfo) Stat {
	return Stat{
		Size:   info.Size(),
		IsDir:  info.IsDir(),
		IsFile: info.Mode().IsRegular(),
		IsLink: info.Mode()&os.ModeSymlink != 0,
		Mode:   uint32(info.Mode().Perm()),
		Uid:    -1,
	}
}
