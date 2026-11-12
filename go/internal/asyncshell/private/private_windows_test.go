//go:build windows

package private

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureDirectoryAcceptsUserDirectory(t *testing.T) {
	dir := t.TempDir()
	if err := EnsureDirectory(dir); err != nil {
		t.Fatalf("EnsureDirectory(%q) = %v", dir, err)
	}
	nested := filepath.Join(dir, "nested")
	if err := os.Mkdir(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := EnsureDirectory(nested); err != nil {
		t.Fatalf("EnsureDirectory(%q) = %v", nested, err)
	}
}
