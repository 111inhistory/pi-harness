package asyncshell

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSamePathUsesIdentityWithoutCaseFolding(t *testing.T) {
	root := t.TempDir()
	one := filepath.Join(root, "one")
	two := filepath.Join(root, "two")
	for _, dir := range []string{one, two} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if !samePath(one, filepath.Join(root, ".", "one")) {
		t.Fatal("the same existing directory must match")
	}
	if samePath(one, two) {
		t.Fatal("different existing directories must not match")
	}
	if !samePath(filepath.Join(root, "missing"), filepath.Join(root, ".", "missing")) {
		t.Fatal("the same missing path must match exactly")
	}
	if samePath(filepath.Join(root, "Missing"), filepath.Join(root, "missing")) {
		t.Fatal("a missing path must not be matched by case folding")
	}
}
