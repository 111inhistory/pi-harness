package asyncshell

// decoder.go holds the incremental UTF-8 boundary the filter needs: a trailing
// sequence split across writes is held until it completes. Invalid bytes are not
// special-cased: an already-malformed PTY stream is degenerate input.

// utf8Decoder holds an incomplete trailing UTF-8 sequence across writes.
type utf8Decoder struct {
	pending []byte
}

func newUTF8Decoder() *utf8Decoder { return &utf8Decoder{} }

// utf8CheckByte is 0 for ASCII, the sequence length for a lead byte, -1 otherwise.
func utf8CheckByte(b byte) int {
	switch {
	case b <= 0x7f:
		return 0
	case b>>5 == 0x06:
		return 2
	case b>>4 == 0x0e:
		return 3
	case b>>3 == 0x1e:
		return 4
	default:
		return -1
	}
}

// utf8IncompleteTail returns how many trailing bytes belong to an incomplete
// sequence (the whole sequence from its lead byte).
func utf8IncompleteTail(buffer []byte) int {
	n := len(buffer)
	for back := 1; back <= 4 && n-back >= 0; back++ {
		check := utf8CheckByte(buffer[n-back])
		if check == 0 {
			return 0
		}
		if check > 0 {
			if back < check {
				return back
			}
			return 0
		}
	}
	return 0
}

// write decodes the complete prefix and holds an incomplete trailing sequence.
func (d *utf8Decoder) write(chunk []byte) string {
	d.pending = append(d.pending, chunk...)
	hold := utf8IncompleteTail(d.pending)
	cut := len(d.pending) - hold
	if cut < 0 {
		cut = 0
	}
	out := string(d.pending[:cut])
	d.pending = append([]byte(nil), d.pending[cut:]...)
	return out
}
