package asyncshell

import (
	"reflect"
	"testing"

	"pijob/internal/asyncshell/aserr"
)

func TestParseDuration(t *testing.T) {
	valid := []struct {
		value string
		want  int64
	}{
		{"0", 0},
		{"250ms", 250},
		{"5s", 5000},
		{"10m", 600000},
		{"1h", 3600000},
	}
	for _, test := range valid {
		value := test.value
		got, err := ParseDuration(&value)
		if err != nil || got != test.want {
			t.Errorf("ParseDuration(%q) = (%d, %v), want (%d, nil)", test.value, got, err, test.want)
		}
	}
	for _, value := range []string{"1.5s", "", "-1s", "5x", "1 s"} {
		if _, err := ParseDuration(&value); aserr.Code(err) != "invalid_duration" {
			t.Errorf("ParseDuration(%q) error = %v, want invalid_duration", value, err)
		}
	}
	if _, err := ParseDuration(nil); aserr.Code(err) != "invalid_duration" {
		t.Errorf("ParseDuration(nil) error = %v, want invalid_duration", err)
	}
}

func TestParseCreateArgs(t *testing.T) {
	args, err := ParseCreateArgs([]string{"--wait", "0", "--timeout", "10s", "--cwd", "/tmp/project", "--", "echo", "hi"})
	if err != nil {
		t.Fatalf("ParseCreateArgs() error = %v", err)
	}
	if args.WaitMs != 0 || args.TimeoutMs == nil || *args.TimeoutMs != 10000 {
		t.Fatalf("timing = (%d, %v), want (0, 10000)", args.WaitMs, args.TimeoutMs)
	}
	if args.Cwd != "/tmp/project" {
		t.Fatalf("cwd = %q, want /tmp/project", args.Cwd)
	}
	if !reflect.DeepEqual(args.Argv, []string{"echo", "hi"}) {
		t.Fatalf("argv = %#v, want [echo hi]", args.Argv)
	}

	def, err := ParseCreateArgs([]string{"--", "true"})
	if err != nil {
		t.Fatalf("ParseCreateArgs(default) error = %v", err)
	}
	if def.WaitMs != 5000 || def.TimeoutMs != nil {
		t.Fatalf("default timing = (%d, %v), want (5000, nil)", def.WaitMs, def.TimeoutMs)
	}
	if !reflect.DeepEqual(def.Argv, []string{"true"}) {
		t.Fatalf("default argv = %#v, want [true]", def.Argv)
	}

	for _, test := range []struct {
		name   string
		tokens []string
	}{
		{"unknown option", []string{"--bogus", "--", "true"}},
		{"missing command", []string{"--wait", "5s"}},
		{"missing cwd", []string{"--cwd"}},
	} {
		if _, err := ParseCreateArgs(test.tokens); aserr.Code(err) != "invalid_command_args" {
			t.Errorf("%s: error = %v, want invalid_command_args", test.name, err)
		}
	}
}

func TestReadCursorOption(t *testing.T) {
	if cursor, err := readCursorOption(nil); err != nil || cursor != nil {
		t.Fatalf("readCursorOption(nil) = (%v, %v), want (nil, nil)", cursor, err)
	}
	if cursor, err := readCursorOption([]string{"--cursor", "12"}); err != nil || cursor == nil || *cursor != 12 {
		t.Fatalf("readCursorOption(--cursor 12) = (%v, %v), want (12, nil)", cursor, err)
	}
	for _, options := range [][]string{{"--cursor"}, {"--bogus"}, {"--cursor", "x"}} {
		if _, err := readCursorOption(options); err == nil {
			t.Errorf("readCursorOption(%#v) error = nil, want an error", options)
		}
	}
}
