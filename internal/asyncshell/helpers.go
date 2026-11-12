package asyncshell

import (
	"encoding/hex"
	"regexp"
	"strconv"
)

// helpers.go holds direct Go spellings of inline TS literals used across the
// translated modules (regexes, number parsing/formatting, hex). These are 1:1
// language mappings, not behavioral glue.

var durationPattern = regexp.MustCompile(`^(\d+)(ms|s|m|h)?$`)
var cursorPattern = regexp.MustCompile(`^\d+$`)

func parseInt64(value string) (int64, error) { return strconv.ParseInt(value, 10, 64) }

// isSafeInteger mirrors Number.isSafeInteger (|v| <= 2^53-1).
func isSafeInteger(value int64) bool {
	const max = int64(1) << 53
	return value < max && value > -max
}

func int64Ptr(value int64) *int64 { return &value }
func intPtr(value int) *int       { return &value }
func formatInt(value int) string  { return strconv.Itoa(value) }
func hexEncode(data []byte) string { return hex.EncodeToString(data) }
