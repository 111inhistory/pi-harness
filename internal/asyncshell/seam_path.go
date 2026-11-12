package asyncshell

import (
	"os"
	"path/filepath"
)

// seam_path.go implements node:path (default POSIX dialect) using path/filepath.

// realpath is fs.realpathSync's resolution (symlinks + absolute).
func realpath(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	return filepath.Abs(resolved)
}

// PathResolve is path.resolve(...parts).
func PathResolve(parts ...string) string {
	resolved, err := filepath.Abs(filepath.Join(parts...))
	if err != nil {
		panic(coded(err, "EIO"))
	}
	return resolved
}

// PathJoin is path.join(...parts).
func PathJoin(parts ...string) string { return filepath.Join(parts...) }

// PathDirname is path.dirname(value).
func PathDirname(value string) string { return filepath.Dir(value) }

// PathBasename is path.basename(value).
func PathBasename(value string) string { return filepath.Base(value) }

// PathExtname is path.extname(value).
func PathExtname(value string) string { return filepath.Ext(value) }

// privateDirectory verifies the POSIX ownership/mode contract.
func privateDirectory(directory string, stat Stat) (bool, error) {
	if stat.Uid != os.Getuid() {
		return false, nil
	}
	return stat.Mode&0o077 == 0, nil
}
