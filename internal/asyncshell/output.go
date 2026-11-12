// Package asyncshell is a mechanical Go translation of the TypeScript async-shell
// modules in src/async-shell/*.ts. Each Go file mirrors one TS file; names,
// branches and control/data flow follow the source as literally as Go permits.
// This is Stage 1 (translation); behavioral-equivalence verification is later.
package asyncshell

import (
	"strings"
	"unicode/utf8"
)

// output.go translates src/async-shell/output.ts.
//
// Member map (TS -> Go):
//
//	#decoder                -> decoder            (persistent UTF-8 decoder)
//	#state                  -> state
//	#line                   -> line
//	#returned               -> returned
//	#afterReturn            -> afterReturn
//	#pending                -> pending
//	write(chunk)            -> Write(chunk []byte) string
//	flush()                 -> Flush() string
//	#take()                 -> take()
//	#newline()              -> newline()
//	#text(input)            -> text(input string) string
//	#escape(char)           -> escape(char rune) filterState
//	#visible(char)          -> visible(char rune)
//
// Types: State -> filterState (same six string states).
const (
	escRune = '\u001b'
	belRune = '\u0007'
)

// State is the escape-parser state (TS: type State).
type filterState string

const (
	stateText        filterState = "text"
	stateEscape      filterState = "escape"
	stateEscapeFinal filterState = "escape-final"
	stateCSI         filterState = "csi"
	stateOSC         filterState = "osc"
	stateOSCEscape   filterState = "osc-escape"
)

// decoder is the language glue for Node's StringDecoder("utf8"): bytes forming an
// incomplete trailing multibyte sequence are retained until the next write, and an
// invalid byte decodes to U+FFFD (utf8.DecodeRune yields RuneError, size 1). The
// filter logic above it is a literal translation of the TS state machine.
type decoder struct {
	pending []byte
}

func (d *decoder) write(chunk []byte) string {
	d.pending = append(d.pending, chunk...)
	var b strings.Builder
	for len(d.pending) > 0 {
		if !utf8.FullRune(d.pending) {
			break
		}
		r, size := utf8.DecodeRune(d.pending)
		b.WriteRune(r)
		d.pending = d.pending[size:]
	}
	return b.String()
}

// OutputFilter is the incremental terminal-transcript filter (TS: OutputFilter).
type OutputFilter struct {
	decoder     decoder
	state       filterState
	line        string
	returned    string
	afterReturn bool
	pending     string
}

// Write feeds raw bytes; returns the transcript text that is ready to append.
func (f *OutputFilter) Write(chunk []byte) string {
	return f.text(f.decoder.write(chunk))
}

// Flush emits text that is still waiting for a newline, as the stream has gone quiet.
func (f *OutputFilter) Flush() string {
	if f.afterReturn {
		f.line = f.returned
		f.returned = ""
		f.afterReturn = false
	}
	if f.line != "" {
		f.pending += f.line
		f.line = ""
	}
	return f.take()
}

func (f *OutputFilter) take() string {
	text := f.pending
	f.pending = ""
	return text
}

func (f *OutputFilter) newline() {
	line := f.line
	if f.afterReturn {
		line = f.returned
	}
	f.pending += line + "\n"
	f.line = ""
	f.returned = ""
	f.afterReturn = false
}

func (f *OutputFilter) text(input string) string {
	for _, char := range input {
		switch f.state {
		case stateEscape:
			f.state = f.escape(char)
		case stateEscapeFinal:
			f.state = stateText
		case stateCSI:
			if char >= '\u0040' && char <= '\u007e' {
				f.state = stateText
			}
		case stateOSC:
			if char == belRune {
				f.state = stateText
			} else if char == escRune {
				f.state = stateOSCEscape
			}
		case stateOSCEscape:
			if char == '\\' {
				f.state = stateText
			} else {
				f.state = stateOSC
			}
		default:
			f.visible(char)
		}
	}
	return f.take()
}

func (f *OutputFilter) escape(char rune) filterState {
	if char == '[' {
		return stateCSI
	}
	if char == ']' || char == 'P' || char == '^' || char == '_' {
		return stateOSC
	}
	// Charset and other designated sequences carry one final byte.
	if char == '(' || char == ')' || char == '#' || char == '%' {
		return stateEscapeFinal
	}
	return stateText
}

func (f *OutputFilter) visible(char rune) {
	if char == escRune {
		f.state = stateEscape
		return
	}
	if f.afterReturn {
		if char == '\n' {
			f.newline()
			return
		}
		// The carriage return overwrote the previous line: it is gone.
		f.returned = ""
		f.afterReturn = false
	}
	switch char {
	case '\n':
		f.newline()
		return
	case '\r':
		f.returned = f.line
		f.line = ""
		f.afterReturn = true
		return
	case '\b':
		// TS: [#line].slice(0, -1) removes the last code point.
		f.line = dropLastRune(f.line)
		return
	case '\t':
		f.line += string(char)
		return
	default:
	}
	if char < 0x20 || char == 0x7f {
		return
	}
	f.line += string(char)
}

// dropLastRune is Go's spelling of TS [...line].slice(0, -1): drop the final code point.
func dropLastRune(line string) string {
	if line == "" {
		return line
	}
	_, size := utf8.DecodeLastRuneInString(line)
	return line[:len(line)-size]
}
