//go:build windows

package asyncshell

// errnoName uses the generic os.Is* classification on Windows.
func errnoName(err error) string { return "" }
