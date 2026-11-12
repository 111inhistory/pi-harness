package asyncshell

import (
	"strconv"
	"strings"
)

// render.go translates src/async-shell/render.ts.
//
// formatResult -> FormatResult, formatError -> FormatError.

// FormatResult is TS formatResult: a metadata line, a blank line, `output:`, then
// the carried text.
func FormatResult(result ShellResult) string {
	head := []string{result.ID, string(result.Status)}
	if result.ExitCode != nil {
		head = append(head, "exit "+strconv.Itoa(*result.ExitCode))
	}
	head = append(head, "cursor "+strconv.FormatInt(result.Cursor, 10))
	if result.Truncated {
		head = append(head, "more output pending")
	}
	head = append(head, "log "+result.LogPath)
	return strings.Join(head, "  ") + "\n\noutput:\n" + result.Output
}

// FormatError is TS formatError: `pi-job: <message>`, with the usage overview when provided.
func FormatError(message string, usage *string) string {
	if usage == nil {
		return "pi-job: " + message + "\n"
	}
	return "pi-job: " + message + "\n\n" + *usage + "\n"
}
