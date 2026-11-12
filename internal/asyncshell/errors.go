package asyncshell

// errors.ts translates src/async-shell/errors.ts (AsyncShellError).

// AsyncShellError is a task operation the caller can act on (TS: AsyncShellError).
type AsyncShellError struct {
	Code    string
	Message string
}

func (e *AsyncShellError) Error() string { return e.Message }

// NewAsyncShellError builds an AsyncShellError (TS: new AsyncShellError(code, message)).
func NewAsyncShellError(code, message string) *AsyncShellError {
	return &AsyncShellError{Code: code, Message: message}
}
