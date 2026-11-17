package backend

import "testing"

func TestExplicitNoServerClassification(t *testing.T) {
	for _, test := range []struct {
		stderr string
		want   bool
	}{
		{stderr: "no server running on /tmp/pi-job", want: true},
		{stderr: "error: no sessions", want: false},
		{stderr: "no sessions", want: false},
		{stderr: "server not found", want: false},
		{stderr: "no server", want: false},
		{stderr: "connection refused", want: false},
	} {
		if got := isExplicitNoServer(test.stderr); got != test.want {
			t.Fatalf("isExplicitNoServer(%q) = %v, want %v", test.stderr, got, test.want)
		}
	}
}
