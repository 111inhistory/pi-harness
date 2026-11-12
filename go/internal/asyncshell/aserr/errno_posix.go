//go:build !windows

package aserr

import (
	"errors"
	"syscall"
)

// errnoName maps a POSIX errno to the Node error code string.
func errnoName(err error) string {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return ""
	}
	switch errno {
	case syscall.EPERM:
		return "EPERM"
	case syscall.EACCES:
		return "EACCES"
	case syscall.ENOENT:
		return "ENOENT"
	case syscall.EEXIST:
		return "EEXIST"
	case syscall.EISDIR:
		return "EISDIR"
	case syscall.ENOTDIR:
		return "ENOTDIR"
	case syscall.ESRCH:
		return "ESRCH"
	case syscall.EADDRINUSE:
		return "EADDRINUSE"
	case syscall.EPIPE:
		return "EPIPE"
	case syscall.ECONNRESET:
		return "ECONNRESET"
	case syscall.ECONNREFUSED:
		return "ECONNREFUSED"
	case syscall.ENOSPC:
		return "ENOSPC"
	}
	return ""
}
