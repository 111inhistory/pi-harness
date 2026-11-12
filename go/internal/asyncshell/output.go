package asyncshell

import "unicode/utf8"

// output.go translates src/async-shell/output.ts (OutputFilter).
//
// Member map (TS -> Go):
//
//	#decoder      -> decoder     (*utf8Decoder, decoder.go)
//	#state        -> state
//	#line         -> line
//	#returned     -> returned
//	#afterReturn  -> afterReturn
//	#pending      -> pending
//	write(chunk)  -> Write(chunk []byte) string
//	flush()       -> Flush() string
//	#take()       -> take()
//	#newline()    -> newline()
//	#text(input)  -> text(input string) string
//	#escape(char) -> escape(char rune) filterState
//	#visible      -> visible(char rune)
//
// Bytes are decoded incrementally by utf8Decoder (decoder.go); an incomplete
// trailing sequence is held across writes.

const (
	escRune = '\u001b'
	belRune = '\u0007'
)

// filterState is TS `type State`.
type filterState string

const (
	stateText        filterState = "text"
	stateEscape      filterState = "escape"
	stateEscapeFinal filterState = "escape-final"
	stateCSI         filterState = "csi"
	stateOSC         filterState = "osc"
	stateOSCEscape   filterState = "osc-escape"
)

// OutputFilter is the incremental terminal-transcript filter (TS: OutputFilter).
type OutputFilter struct {
	decoder     *utf8Decoder
	state       filterState
	line        string
	returned    string
	afterReturn bool
	pending     string
}

// NewOutputFilter is TS `new OutputFilter()` (default UTF-8 decoder).
func NewOutputFilter() *OutputFilter {
	return &OutputFilter{decoder: newUTF8Decoder()}
}

// Write feeds raw bytes; returns the transcript text that is ready to append (TS write()).
func (f *OutputFilter) Write(chunk []byte) string {
	return f.text(f.decoder.write(chunk))
}

// Flush emits text that is still waiting for a newline, as the stream has gone quiet (TS flush()).
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
			switch char {
			case belRune:
				f.state = stateText
			case escRune:
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
		// TS: [...line].slice(0, -1) removes the last code point.
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

// dropLastRune is Go's literal spelling of TS [...line].slice(0, -1).
func dropLastRune(line string) string {
	if line == "" {
		return line
	}
	_, size := utf8.DecodeLastRuneInString(line)
	return line[:len(line)-size]
}
