package asyncshell

import (
	"encoding/hex"
	"math"
	"regexp"
	"strconv"
)

// helpers.go holds direct Go spellings of inline TS literals used across the
// translated modules (regexes, number parsing/formatting, hex). These are 1:1
// language mappings, not behavioral glue.

var durationPattern = regexp.MustCompile(`^(\d+)(ms|s|m|h)?$`)
var cursorPattern = regexp.MustCompile(`^\d+$`)

func parseInt64(value string) (int64, error) { return strconv.ParseInt(value, 10, 64) }

// parseFloatDigits is Number.parseInt's digit prefix, kept as a JS-number
// (float64) so huge values overflow to +Inf instead of being silently clamped.
func parseFloatDigits(value string) float64 {
	parsed, _ := strconv.ParseFloat(value, 64)
	return parsed
}

// isSafeIntegerFloat is Number.isSafeInteger on a JS number.
func isSafeIntegerFloat(value float64) bool {
	return !math.IsInf(value, 0) && !math.IsNaN(value) && math.Trunc(value) == value && math.Abs(value) <= 9007199254740991
}

func int64Ptr(value int64) *int64  { return &value }
func formatInt(value int) string   { return strconv.Itoa(value) }
func hexEncode(data []byte) string { return hex.EncodeToString(data) }

// parseIntPrefix mirrors Number.parseInt(value, 10): optional sign + leading digits.
func parseIntPrefix(value string) (int64, bool) {
	index := 0
	for index < len(value) && (value[index] == ' ' || value[index] == '\t' || value[index] == '\n' || value[index] == '\r') {
		index++
	}
	start := index
	if index < len(value) && (value[index] == '+' || value[index] == '-') {
		index++
	}
	digits := 0
	for index < len(value) && value[index] >= '0' && value[index] <= '9' {
		index++
		digits++
	}
	if digits == 0 {
		return 0, false
	}
	parsed, err := strconv.ParseInt(value[start:index], 10, 64)
	return parsed, err == nil
}
