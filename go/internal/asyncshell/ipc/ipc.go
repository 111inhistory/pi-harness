// Package ipc dials the callback transport: a Unix socket on POSIX and a
// Named Pipe on Windows.
package ipc

import (
	"io"
	"time"
)

// Timeout bounds both connecting and waiting for acknowledgements.
const Timeout = 5 * time.Second

// Conn is a bidirectional callback connection with a deadline.
type Conn interface {
	io.ReadWriteCloser
	SetDeadline(time.Time) error
}
