package asyncshell

import (
	"strings"
	"unicode/utf8"
)

// decoder.go preserves Node's StringDecoder("utf8") behavior for PTY bytes.
//
// The original OutputFilter used StringDecoder.write, not Buffer.toString: an
// incomplete trailing sequence is held until the next write, and a completed
// ill-formed sequence is replaced by the maximal subpart rule (for example
// e2 82 28 becomes one U+FFFD followed by "("). The stream end is not decoded
// because the original filter never calls decoder.end(); trailing incomplete
// bytes are therefore still dropped.

type utf8Decoder struct {
	pending []byte
}

func newUTF8Decoder() *utf8Decoder { return &utf8Decoder{} }

// utf8SequenceLength returns the expected length for a valid UTF-8 lead byte,
// or zero for a byte that cannot start a sequence.
func utf8SequenceLength(lead byte) int {
	switch {
	case lead < 0x80:
		return 1
	case lead >= 0xC0 && lead <= 0xDF:
		return 2
	case lead >= 0xE0 && lead <= 0xEF:
		return 3
	case lead >= 0xF0 && lead <= 0xF7:
		return 4
	default:
		return 0
	}
}

// utf8LeadValid excludes the lead bytes that StringDecoder holds until the
// expected length arrives but must still decode as ill-formed.
func utf8LeadValid(lead byte) bool {
	return (lead >= 0xC2 && lead <= 0xDF) || (lead >= 0xE0 && lead <= 0xEF) || (lead >= 0xF0 && lead <= 0xF4)
}

// utf8ContinuationOK applies the second-byte restrictions that exclude
// overlongs, UTF-16 surrogates and code points above U+10FFFF.
func utf8ContinuationOK(lead byte, offset int, value byte) bool {
	if offset == 1 {
		switch lead {
		case 0xE0:
			return value >= 0xA0 && value <= 0xBF
		case 0xED:
			return value >= 0x80 && value <= 0x9F
		case 0xF0:
			return value >= 0x90 && value <= 0xBF
		case 0xF4:
			return value >= 0x80 && value <= 0x8F
		}
	}
	return value >= 0x80 && value <= 0xBF
}

// write decodes complete sequences and holds an incomplete trailing sequence.
// An invalid completed sequence consumes its maximal valid subpart and emits
// one U+FFFD; the bytes that invalidated it remain for the next iteration.
func (d *utf8Decoder) write(chunk []byte) string {
	if len(chunk) > 0 {
		d.pending = append(d.pending, chunk...)
	}
	var out strings.Builder
	index := 0
	for index < len(d.pending) {
		lead := d.pending[index]
		if lead < 0x80 {
			out.WriteByte(lead)
			index++
			continue
		}
		need := utf8SequenceLength(lead)
		if need == 0 {
			out.WriteRune(utf8.RuneError)
			index++
			continue
		}
		// A partial sequence is held only while every available continuation is
		// structurally a continuation. A non-continuation byte proves the lead
		// ill-formed immediately, even before the expected length arrives.
		if index+need > len(d.pending) {
			broken := false
			for offset := 1; offset < len(d.pending)-index; offset++ {
				if d.pending[index+offset] < 0x80 || d.pending[index+offset] > 0xBF {
					broken = true
					break
				}
			}
			if broken {
				out.WriteRune(utf8.RuneError)
				index++
				continue
			}
			break
		}
		if !utf8LeadValid(lead) {
			out.WriteRune(utf8.RuneError)
			index++
			continue
		}
		invalidAt := 0
		for offset := 1; offset < need; offset++ {
			if !utf8ContinuationOK(lead, offset, d.pending[index+offset]) {
				invalidAt = offset
				break
			}
		}
		if invalidAt == 0 {
			r, _ := utf8.DecodeRune(d.pending[index : index+need])
			out.WriteRune(r)
			index += need
			continue
		}
		out.WriteRune(utf8.RuneError)
		index += invalidAt
	}
	d.pending = append([]byte(nil), d.pending[index:]...)
	return out.String()
}
