package asyncshell

import (
	"fmt"
	"os"
)

// errors.go translates src/async-shell/errors.ts (AsyncShellError) plus the
// coded-error helper used by OS/command boundaries.

// AsyncShellError is a task operation the caller can act on (TS: AsyncShellError).
type AsyncShellError struct {
	Code    string
	Message string
}

func (e *AsyncShellError) Error() string { return e.Message }

// asError converts a recovered panic value into an error at a process boundary.
func asError(recovered interface{}) error {
	if err, ok := recovered.(error); ok {
		return err
	}
	return fmt.Errorf("internal error: %v", recovered)
}

// recoverError is the boundary that turns an escaped engine panic into an error.
func recoverError(err *error) {
	if recovered := recover(); recovered != nil {
		*err = asError(recovered)
	}
}

// NewAsyncShellError builds an AsyncShellError (TS: new AsyncShellError(code, message)).
func NewAsyncShellError(code, message string) *AsyncShellError {
	return &AsyncShellError{Code: code, Message: message}
}

// codedError carries a Node-style `error.code` through a Go error.
type codedError struct {
	Code string
	Err  error
}

func (e *codedError) Error() string {
	if e.Err != nil {
		return e.Err.Error()
	}
	return e.Code
}

func (e *codedError) ErrorCode() string { return e.Code }

// coded wraps an OS error with the Node-style code when one can be derived.
func coded(err error, fallback string) error {
	if err == nil {
		return nil
	}
	code := errnoName(err)
	if code == "" {
		switch {
		case os.IsNotExist(err):
			code = "ENOENT"
		case os.IsPermission(err):
			code = "EACCES"
		case os.IsExist(err):
			code = "EEXIST"
		default:
			code = fallback
		}
	}
	return &codedError{Code: code, Err: err}
}
