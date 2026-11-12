//go:build windows

package private

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"pijob/internal/asyncshell/aserr"
	"strings"
)

// private_windows.go verifies the directory DACL through PowerShell, matching
// src/ipc/private-directory-windows.ts: the owner must be this user, SYSTEM or
// Administrators, and every Allow rule must target one of those or CREATOR OWNER.

const directoryACLEnv = "PI_HARNESS_DIRECTORY_ACL_PATH"

const windowsDirectoryACLCheck = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName System.Security
  $acl = [System.IO.DirectoryInfo]::new($env:PI_HARNESS_DIRECTORY_ACL_PATH).GetAccessControl()
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $trusted = @($sid, 'S-1-5-18', 'S-1-5-32-544')
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { exit 1 }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -eq 0) { exit 1 }
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        $rule.IdentityReference.Value -notin ($trusted + 'S-1-3-0')) { exit 1 }
  }
  [Console]::Out.Write('private')
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 2
}
`

func windowsPrivateDirectory(directory string) (bool, error) {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", windowsDirectoryACLCheck)
	env := make([]string, 0, len(os.Environ())+1)
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(entry), directoryACLEnv+"=") {
			env = append(env, entry)
		}
	}
	cmd.Env = append(env, directoryACLEnv+"="+directory)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 1 {
			return false, nil
		}
		detail := firstLine(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return false, fmt.Errorf("Windows directory ACL inspection failed: %s", detail)
	}
	if strings.TrimSpace(stdout.String()) != "private" {
		detail := firstLine(stderr.String())
		if detail == "" {
			detail = "unexpected inspection output"
		}
		return false, fmt.Errorf("Windows directory ACL inspection failed: %s", detail)
	}
	return true, nil
}

func firstLine(text string) string {
	return strings.TrimSpace(strings.SplitN(strings.TrimSpace(text), "\n", 2)[0])
}

func EnsureDirectory(directory string) error {
	info, err := os.Lstat(directory)
	if err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return err
		}
		info, err = os.Lstat(directory)
		if err != nil {
			return err
		}
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return &aserr.CodedError{Code: "ipc_directory_symlink", Err: fmt.Errorf("Refusing IPC directory symlink: %s", directory)}
	}
	if !info.IsDir() {
		return &aserr.CodedError{Code: "ipc_directory_not_directory", Err: fmt.Errorf("IPC parent is not a directory: %s", directory)}
	}
	private, err := windowsPrivateDirectory(directory)
	if err != nil {
		return err
	}
	if !private {
		return &aserr.CodedError{Code: "ipc_directory_insecure", Err: fmt.Errorf("IPC directory is not private to the effective user: %s", directory)}
	}
	return nil
}
