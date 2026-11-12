package asyncshell

// seam_string_decoder.go is the incremental UTF-8 boundary the filter needs:
// a trailing sequence split across writes is held until it completes. Invalid
// bytes are not special-cased: an already-malformed PTY stream is degenerate
// input, and chasing Node's exact U+FFFD replacement would change log bytes and
// cursor offsets without a product-level contract.

// StringDecoder holds an incomplete trailing UTF-8 sequence across writes.
type StringDecoder struct {
	encoding string
	pending  []byte
}

// NewStringDecoder constructs a UTF-8 decoder (other encodings are not used).
func NewStringDecoder(encoding string) *StringDecoder {
	return &StringDecoder{encoding: encoding}
}

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

// Write decodes the complete prefix and holds an incomplete trailing sequence.
func (d *StringDecoder) Write(chunk []byte) string {
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

// BufferByteLength is TS Buffer.byteLength(value, "utf8") -> len of UTF-8 bytes.
func BufferByteLength(value string, encoding string) int {
	return len(value)
}
