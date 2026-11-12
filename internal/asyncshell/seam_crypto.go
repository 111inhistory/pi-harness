package asyncshell

import (
	crand "crypto/rand"
	"os"
)

// RandomBytes is crypto.randomBytes(size).
func RandomBytes(size int) []byte {
	buffer := make([]byte, size)
	if _, err := crand.Read(buffer); err != nil {
		panic(coded(err, "EIO"))
	}
	return buffer
}

// OsTmpdir is os.tmpdir().
func OsTmpdir() string { return os.TempDir() }
