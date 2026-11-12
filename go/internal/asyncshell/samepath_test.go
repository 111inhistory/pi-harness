package asyncshell

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSamePathUsesExistingDirectoryIdentity(t *testing.T) {
	root := t.TempDir()
	one := filepath.Join(root, "one")
	two := filepath.Join(root, "two")
	for _, dir := range []string{one, two} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	same, err := samePath(one, filepath.Join(root, ".", "one"))
	if err != nil {
		t.Fatal(err)
	}
	if !same {
		t.Fatal("the same existing directory must match")
	}
	same, err = samePath(one, two)
	if err != nil {
		t.Fatal(err)
	}
	if same {
		t.Fatal("different existing directories must not match")
	}
}

func TestSamePathReportsMissingPath(t *testing.T) {
	root := t.TempDir()
	missing := filepath.Join(root, "missing")
	if _, err := samePath(missing, missing); err == nil {
		t.Fatal("a missing directory must report why its identity is unknown")
	}
}

func TestCheckedTaskDirectoryRejectsMissingRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "missing-root")
	dir := filepath.Join(root, "job_12345678")
	if _, err := checkedTaskDirectory(dir, root); err == nil {
		t.Fatal("a missing task root must not fall back to string equality")
	}
}
