package asyncshell

import "testing"

func TestUTF8DecoderMatchesStringDecoderInvalidSequences(t *testing.T) {
	cases := []struct {
		name  string
		bytes []byte
		want  string
	}{
		{"valid-ascii", []byte("hello"), "hello"},
		{"valid-emoji", []byte{0xf0, 0x9f, 0x92, 0xa9}, "💩"},
		{"invalid-lead", []byte{0xff}, "\uFFFD"},
		{"invalid-continuation-lead", []byte{0x80}, "\uFFFD"},
		{"overlong-lead", []byte{0xc0, 0x80}, "\uFFFD\uFFFD"},
		{"maximal-subpart-before-ascii", []byte{0xe2, 0x82, 0x28}, "\uFFFD("},
		{"maximal-subpart-before-invalid", []byte{0xe2, 0x82, 0xff}, "\uFFFD\uFFFD"},
		{"overlong-second-byte", []byte{0xe0, 0x80, 0x28}, "\uFFFD\uFFFD("},
		{"surrogate-second-byte", []byte{0xed, 0xa0, 0x28}, "\uFFFD\uFFFD("},
		{"four-byte-prefix-before-ascii", []byte{0xf0, 0x9f, 0x92, 0x28}, "\uFFFD("},
		{"four-byte-overlong", []byte{0xf0, 0x80, 0x80, 0x28}, "\uFFFD\uFFFD\uFFFD("},
		{"above-unicode-max", []byte{0xf4, 0x90, 0x80, 0x28}, "\uFFFD\uFFFD\uFFFD("},
		{"invalid-second-byte", []byte{0xe2, 0x28, 0xa1}, "\uFFFD(\uFFFD"},
		{"retired-two-byte-lead-held", []byte{0xc0}, ""},
		{"retired-two-byte-lead-complete", []byte{0xc0, 0x80}, "\uFFFD\uFFFD"},
		{"retired-four-byte-lead-complete", []byte{0xf5, 0x80, 0x80, 0x80}, "\uFFFD\uFFFD\uFFFD\uFFFD"},
		{"incomplete-broken-by-ascii", []byte{0xe0, 0x00}, "\uFFFD\x00"},
		{"incomplete-overlong-prefix-held", []byte{0xe0, 0x80}, ""},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			decoder := newUTF8Decoder()
			if got := decoder.write(test.bytes); got != test.want {
				t.Fatalf("write(% x) = %q, want %q", test.bytes, got, test.want)
			}
			for split := 0; split <= len(test.bytes); split++ {
				decoder := newUTF8Decoder()
				got := decoder.write(test.bytes[:split]) + decoder.write(test.bytes[split:])
				if got != test.want {
					t.Fatalf("split %d: write(% x) = %q, want %q", split, test.bytes, got, test.want)
				}
			}
		})
	}
}

func TestUTF8DecoderHoldsIncompleteSequenceAcrossWrites(t *testing.T) {
	decoder := newUTF8Decoder()
	if got := decoder.write([]byte{0xe2, 0x82}); got != "" {
		t.Fatalf("incomplete prefix produced %q", got)
	}
	if got := decoder.write([]byte{0xac}); got != "€" {
		t.Fatalf("completed sequence = %q", got)
	}

	decoder = newUTF8Decoder()
	if got := decoder.write([]byte{0xe0, 0x80}); got != "" {
		t.Fatalf("ill-formed but incomplete sequence produced %q", got)
	}
	if got := decoder.write([]byte{0x28}); got != "\uFFFD\uFFFD(" {
		t.Fatalf("completed ill-formed sequence = %q", got)
	}
}
