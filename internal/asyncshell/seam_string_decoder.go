package asyncshell

// seam_string_decoder.go implements node:string_decoder's UTF-8 StringDecoder
// semantics: complete sequences are decoded now; an incomplete trailing
// multibyte sequence is held for the next write.

// StringDecoder is the seam for Node's new StringDecoder("utf8").
type StringDecoder struct {
	encoding string
	pending  []byte
}

// NewStringDecoder constructs a UTF-8 decoder (other encodings are not used).
func NewStringDecoder(encoding string) *StringDecoder {
	return &StringDecoder{encoding: encoding}
}

// Write is StringDecoder.write(Buffer): valid UTF-8, holding an incomplete tail.
func (d *StringDecoder) Write(chunk []byte) string {
	d.pending = append(d.pending, chunk...)
	n := len(d.pending)
	if n == 0 {
		return ""
	}
	cut := n
	for back := 1; back <= 3 && n-back >= 0; back++ {
		b := d.pending[n-back]
		if b < 0x80 {
			break
		}
		if b >= 0xc0 {
			needed := 2
			if b >= 0xf0 {
				needed = 4
			} else if b >= 0xe0 {
				needed = 3
			}
			if back < needed {
				cut = n - back
			}
			break
		}
	}
	out := string(d.pending[:cut])
	d.pending = append([]byte(nil), d.pending[cut:]...)
	return out
}

// BufferByteLength is TS Buffer.byteLength(value, "utf8").
func BufferByteLength(value string, encoding string) int {
	return len([]byte(value))
}
