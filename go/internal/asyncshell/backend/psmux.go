//go:build windows

package backend

import (
	"pijob/internal/asyncshell/aserr"
	"pijob/internal/asyncshell/proc"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

// platform_windows.go translates src/async-shell/platform-windows.ts (+ the
// Windows half of platform.ts). Control/process calls use os/exec.

const psmuxBinary = "psmux.exe"

// minPsmuxVersion is TS MIN_VERSION = [3, 4, 0].
var minPsmuxVersion = [3]int{3, 4, 0}

// ownershipTimeoutMs is TS OWNERSHIP_TIMEOUT_MS = 10_000.
const ownershipTimeoutMs = 10000

func describeWin(err error) string {
	if err != nil {
		return err.Error()
	}
	return ""
}

var psmuxLabelPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// labelOf is TS labelOf: the psmux label of this task's own server.
func labelOf(dir string) string {
	parts := strings.FieldsFunc(dir, func(r rune) bool { return r == '\\' || r == '/' })
	name := ""
	if len(parts) > 0 {
		name = parts[len(parts)-1]
	}
	if !psmuxLabelPattern.MatchString(name) {
		panic(aserr.New("invalid_task_id", "Not usable as a psmux label: "+name))
	}
	return "pi-job-" + name
}

// WindowsBackend is the Windows ShellBackend (TS: windowsBackend object).
type WindowsBackend struct{}

func (WindowsBackend) Kind() string { return "windows" }

func (WindowsBackend) Run(dir string, args []string, stdin *string) CommandResult {
	full := append([]string{"-L", labelOf(dir)}, args...)
	timeout := ControlTimeoutMs
	result := proc.Run(psmuxBinary, full, proc.Options{TimeoutMs: &timeout, Input: stdin, Hide: true})
	if result.Error != nil {
		panic(aserr.New("psmux_unavailable", describeWin(result.Error)))
	}
	return CommandResult{Code: result.Code, Stdout: result.Stdout, Stderr: result.Stderr}
}

func (WindowsBackend) RunOk(dir string, args []string, code string, stdin *string) CommandResult {
	result := WindowsBackend{}.Run(dir, args, stdin)
	if result.Code == nil || *result.Code != 0 {
		first := ""
		if len(args) > 0 {
			first = args[0]
		}
		detail := strings.TrimSpace(result.Stderr)
		if detail == "" {
			if result.Code == nil {
				detail = "exit unknown"
			} else {
				detail = "exit " + strconv.Itoa(*result.Code)
			}
		}
		panic(aserr.New(code, "psmux "+first+" failed: "+detail))
	}
	return result
}

var versionPattern = regexp.MustCompile(`(\d+)\.(\d+)(?:\.(\d+))?`)

// parseVersion is TS parseVersion.
func parseVersion(text string) *[3]int {
	match := versionPattern.FindStringSubmatch(text)
	if match == nil {
		return nil
	}
	major, _ := strconv.Atoi(match[1])
	minor, _ := strconv.Atoi(match[2])
	patch := 0
	if match[3] != "" {
		patch, _ = strconv.Atoi(match[3])
	}
	return &[3]int{major, minor, patch}
}

// atLeast is TS atLeast.
func atLeast(found [3]int, wanted [3]int) bool {
	for index := 0; index < 3; index++ {
		if found[index] != wanted[index] {
			return found[index] > wanted[index]
		}
	}
	return true
}

func (WindowsBackend) AssertAvailable() {
	if runtime.GOOS != "windows" {
		panic(aserr.New("unsupported_platform", "The psmux backend is only available on Windows."))
	}
	timeout := ControlTimeoutMs
	probe := proc.Run(psmuxBinary, []string{"-V"}, proc.Options{TimeoutMs: &timeout, Hide: true})
	if probe.Error != nil || probe.Code == nil || *probe.Code != 0 {
		panic(aserr.New("psmux_unavailable", "psmux 3.4.0 or newer is required for async shell tasks and was not found on PATH."))
	}
	version := parseVersion(probe.Stdout + "\n" + probe.Stderr)
	if version == nil || !atLeast(*version, minPsmuxVersion) {
		shown := "an unknown version"
		if version != nil {
			shown = strconv.Itoa(version[0]) + "." + strconv.Itoa(version[1]) + "." + strconv.Itoa(version[2])
		}
		panic(aserr.New("psmux_version", "async shell tasks require psmux 3.4.0 or newer; found "+shown+"."))
	}
}

func (WindowsBackend) KillServer(dir string) {
	WindowsBackend{}.Run(dir, []string{"kill-server"}, nil)
}

func (WindowsBackend) ServerRunning(dir string) bool {
	result := WindowsBackend{}.Run(dir, []string{"list-sessions"}, nil)
	return result.Code != nil && *result.Code == 0
}

// captureSink is TS captureSink: the server writes the pane's raw bytes; no shell.
func captureSink(rawPath string) string {
	if strings.Contains(rawPath, `"`) {
		panic(aserr.New("invalid_path", "The capture log path cannot contain a quote: "+rawPath))
	}
	return `cat >> "` + rawPath + `"`
}

func (WindowsBackend) Start(dir string, selfArgv []string, rawPath string) {
	newArgs := append([]string{"new-session", "-d", "-s", Session, "-x", "200", "-y", "50", "--"}, selfArgv...)
	WindowsBackend{}.RunOk(dir, newArgs, "session_failed", nil)
	WindowsBackend{}.RunOk(dir, []string{"pipe-pane", "-o", "-t", Session, captureSink(rawPath)}, "capture_failed", nil)
}

func (WindowsBackend) SendInput(dir string, input string) {
	if input == "" {
		return
	}
	PasteLiteral(WindowsBackend{}, dir, input, Session)
}

func (WindowsBackend) SendKey(dir string, key string) {
	WindowsBackend{}.RunOk(dir, []string{"send-keys", "-t", Session, key}, "send_failed", nil)
}

func (WindowsBackend) PaneGone(dir string) bool {
	result := WindowsBackend{}.Run(dir, []string{"display-message", "-p", "-t", Session, "#{pane_dead}"}, nil)
	return result.Code == nil || *result.Code != 0 || strings.TrimSpace(result.Stdout) != "0"
}

// shellForQuery is TS shellForQuery: pwsh when present, else Windows PowerShell.
func shellForQuery() []string {
	for _, candidate := range []string{"pwsh", "powershell"} {
		timeout := 5000
		probe := proc.Run(candidate, []string{"-NoProfile", "-NonInteractive", "-Command", "exit 0"}, proc.Options{TimeoutMs: &timeout, Hide: true})
		if probe.Error == nil && probe.Code != nil && *probe.Code == 0 {
			return []string{candidate, "-NoProfile", "-NonInteractive", "-Command"}
		}
	}
	panic(aserr.New("process_inspection_failed",
		"Neither pwsh nor Windows PowerShell could be started to inspect process ownership; the task fence is kept."))
}

const ownershipScriptPrefix = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)"

func (WindowsBackend) OwnsProcess(pid int, marker string, dir string) bool {
	shell := shellForQuery()
	script := strings.Join([]string{
		ownershipScriptPrefix,
		`$p = Get-CimInstance Win32_Process -Filter "ProcessId=` + strconv.Itoa(pid) + `" -ErrorAction Stop`,
		`$answer = 'absent'`,
		`if ($p) { $answer = 'unreadable' }`,
		`if ($p -and -not [string]::IsNullOrEmpty($p.CommandLine)) { $answer = 'cmd:' + $p.CommandLine }`,
		"[Console]::Out.Write($answer)",
	}, "; ")
	args := append(append([]string{}, shell[1:]...), script)
	timeout := ownershipTimeoutMs
	probe := proc.Run(shell[0], args, proc.Options{TimeoutMs: &timeout, Hide: true})
	if probe.Error != nil {
		panic(aserr.New("process_inspection_failed", "Could not inspect pid "+strconv.Itoa(pid)+": "+describeWin(probe.Error)))
	}
	if probe.Code == nil || *probe.Code != 0 {
		statusText := "unknown"
		if probe.Code != nil {
			statusText = strconv.Itoa(*probe.Code)
		}
		panic(aserr.New("process_inspection_failed", "Could not inspect pid "+strconv.Itoa(pid)+": the process query exited "+statusText+" "+strings.TrimSpace(probe.Stderr)))
	}
	answer := strings.TrimSpace(probe.Stdout)
	if answer == "absent" {
		return false
	}
	if !strings.HasPrefix(answer, "cmd:") {
		panic(aserr.New("process_inspection_failed", "Could not read the command line of pid "+strconv.Itoa(pid)+"."))
	}
	command := strings.TrimPrefix(answer, "cmd:")
	return strings.Contains(command, marker) && strings.Contains(command, dir)
}

// Default is tmux.ts's `backend` selection for Windows builds.
func Default() ShellBackend { return WindowsBackend{} }
