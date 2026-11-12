//go:build windows

package aserr

// errnoName uses the generic os.Is* classification on Windows.
func errnoName(err error) string { return "" }
