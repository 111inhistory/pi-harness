// Package aserr carries the task error codes across engine, backend and OS
// boundaries. A code is part of the CLI contract, not an internal detail.
package aserr

import (
	"fmt"
	"os"
)

// Error is a task operation the caller can act on.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

// New builds an Error with a contract code.
func New(code, message string) *Error { return &Error{Code: code, Message: message} }

// CodedError carries a Node-style `error.code` through a Go error.
type CodedError struct {
	Code string
	Err  error
}

func (e *CodedError) Error() string {
	if e.Err != nil {
		return e.Err.Error()
	}
	return e.Code
}

func (e *CodedError) ErrorCode() string { return e.Code }

// Coded wraps an OS error with the Node-style code when one can be derived.
func Coded(err error, fallback string) error {
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
	return &CodedError{Code: code, Err: err}
}

// AsError converts a recovered panic value into an error at a process boundary.
func AsError(recovered interface{}) error {
	if err, ok := recovered.(error); ok {
		return err
	}
	return fmt.Errorf("internal error: %v", recovered)
}

// Recover is the boundary that turns an escaped engine panic into an error.
func Recover(err *error) {
	if recovered := recover(); recovered != nil {
		*err = AsError(recovered)
	}
}

// Code reads the contract code from an engine or OS error.
func Code(err interface{}) string {
	if err == nil {
		return ""
	}
	if e, ok := err.(*Error); ok {
		return e.Code
	}
	if ce, ok := err.(interface{ ErrorCode() string }); ok {
		return ce.ErrorCode()
	}
	return ""
}
