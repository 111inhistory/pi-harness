/** Windows filesystem privacy uses the DACL, not Node's POSIX mode bits. */
import { spawnSync } from "node:child_process";

const DIRECTORY_ENV = "PI_HARNESS_DIRECTORY_ACL_PATH";
const CHECK = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  # Windows PowerShell's .NET API avoids inheriting pwsh module search paths.
  Add-Type -AssemblyName System.Security
  $acl = [System.IO.DirectoryInfo]::new($env:${DIRECTORY_ENV}).GetAccessControl()
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  # SYSTEM and administrators have privileged access regardless of a user DACL.
  $trusted = @($sid, 'S-1-5-18', 'S-1-5-32-544')
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { exit 1 }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  # A null DACL grants everyone access; no enumerated rules cannot prove privacy.
  if ($rules.Count -eq 0) { exit 1 }
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        $rule.IdentityReference.Value -notin ($trusted + 'S-1-3-0')) { exit 1 }
  }
  [Console]::Out.Write('private')
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 2
}
`;

/**
 * Verify an existing directory without rewriting its owner or inherited ACL.
 * Reject unprivileged foreign Allow entries conservatively, even when a Deny
 * might mask them. CREATOR OWNER may be inherited by files created by this user.
 * The path is data, never PowerShell source. Named Pipes never call this check.
 */
export function windowsPrivateDirectory(directory: string): boolean {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", CHECK], {
    env: { ...process.env, [DIRECTORY_ENV]: directory },
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw new Error(`Windows directory ACL inspection failed: ${result.error.message}`, { cause: result.error });
  }
  if (result.status === 1) return false;
  if (result.status !== 0 || result.stdout.trim() !== "private") {
    const detail = result.stderr.trim().split(/[\r\n]/, 1)[0] || `exit ${String(result.status)}`;
    throw new Error(`Windows directory ACL inspection failed: ${detail}`);
  }
  return true;
}
