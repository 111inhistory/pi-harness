package backend

import "strings"

// isExplicitNoServer is the only nonzero-exit answer that may be classified as
// stopped. "no sessions" means the server is alive without sessions, so it is
// deliberately not accepted.
func isExplicitNoServer(stderr string) bool {
	detail := strings.ToLower(strings.TrimSpace(stderr))
	return strings.Contains(detail, "no server running")
}
