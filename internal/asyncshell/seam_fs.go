package asyncshell

import (
	"os"
	"sync"
)

// seam_fs.go implements the node:fs subset used by the translated engine.

var (
	fsHandlesMu  sync.Mutex
	fsHandles    = map[int]*os.File{}
	fsNextHandle int
)

// FsReadFileSync is fs.readFileSync(path, "utf8").
func FsReadFileSync(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		panic(coded(err, "EIO"))
	}
	return string(data)
}

// FsReadFileBytesSync is fs.readFileSync(path) returning raw bytes.
func FsReadFileBytesSync(path string) []byte {
	data, err := os.ReadFile(path)
	if err != nil {
		panic(coded(err, "EIO"))
	}
	return data
}

// FsWriteFileSync is fs.writeFileSync(path, data, options).
func FsWriteFileSync(path string, data []byte, options *FileOptions) {
	mode := os.FileMode(0o644)
	if options != nil && options.Mode != nil {
		mode = os.FileMode(*options.Mode)
	}
	if err := os.WriteFile(path, data, mode); err != nil {
		panic(coded(err, "EIO"))
	}
}

// FsAppendFileSync is fs.appendFileSync(path, data, options).
func FsAppendFileSync(path string, data []byte, options *FileOptions) {
	mode := os.FileMode(0o644)
	if options != nil && options.Mode != nil {
		mode = os.FileMode(*options.Mode)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, mode)
	if err != nil {
		panic(coded(err, "EIO"))
	}
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		panic(coded(err, "EIO"))
	}
}

// FsExistsSync is fs.existsSync(path).
func FsExistsSync(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// FsLstatSync is fs.lstatSync(path).
func FsLstatSync(path string) Stat {
	info, err := os.Lstat(path)
	if err != nil {
		panic(coded(err, "EIO"))
	}
	return statFrom(info)
}

// FsStatSync is fs.statSync(path).
func FsStatSync(path string) Stat {
	info, err := os.Stat(path)
	if err != nil {
		panic(coded(err, "EIO"))
	}
	return statFrom(info)
}

// FsMkdirSync is fs.mkdirSync(path, options).
func FsMkdirSync(path string, options *MkdirOptions) {
	mode := os.FileMode(0o777)
	recursive := false
	if options != nil {
		recursive = options.Recursive
		if options.Mode != nil {
			mode = os.FileMode(*options.Mode)
		}
	}
	var err error
	if recursive {
		err = os.MkdirAll(path, mode)
	} else {
		err = os.Mkdir(path, mode)
	}
	if err != nil {
		panic(coded(err, "EIO"))
	}
}

// FsRenameSync is fs.renameSync(from, to).
func FsRenameSync(from string, to string) {
	if err := os.Rename(from, to); err != nil {
		panic(coded(err, "EIO"))
	}
}

// FsRealpathSync is fs.realpathSync(path).
func FsRealpathSync(path string) string {
	resolved, err := realpath(path)
	if err != nil {
		panic(coded(err, "ENOENT"))
	}
	return resolved
}

// FsOpenSync is fs.openSync(path, flags); returns a stable seam handle.
func FsOpenSync(path string, flags string) int {
	flag := os.O_RDONLY
	if flags == "r+" {
		flag = os.O_RDWR
	}
	file, err := os.OpenFile(path, flag, 0)
	if err != nil {
		panic(coded(err, "EIO"))
	}
	fsHandlesMu.Lock()
	handle := fsNextHandle
	fsNextHandle++
	fsHandles[handle] = file
	fsHandlesMu.Unlock()
	return handle
}

func fsLookup(handle int) *os.File {
	fsHandlesMu.Lock()
	file := fsHandles[handle]
	fsHandlesMu.Unlock()
	if file == nil {
		panic("invalid seam file handle")
	}
	return file
}

// FsFstatSync is fs.fstatSync(handle).
func FsFstatSync(handle int) Stat {
	info, err := fsLookup(handle).Stat()
	if err != nil {
		panic(coded(err, "EIO"))
	}
	return statFrom(info)
}

// FsReadSync is fs.readSync(handle, buffer, offset, length, position).
func FsReadSync(handle int, buffer []byte, offset int, length int, position int64) int {
	read, err := fsLookup(handle).ReadAt(buffer[offset:offset+length], position)
	if err != nil && read == 0 {
		return 0
	}
	return read
}

// FsCloseSync is fs.closeSync(handle).
func FsCloseSync(handle int) {
	fsHandlesMu.Lock()
	file := fsHandles[handle]
	delete(fsHandles, handle)
	fsHandlesMu.Unlock()
	if file != nil {
		_ = file.Close()
	}
}
