//go:build windows

package backend

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"pijob/internal/asyncshell/aserr"
	"pijob/internal/asyncshell/proc"
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

func (WindowsBackend) runWithTimeout(dir string, args []string, timeoutMs int, stdin *string) CommandResult {
	full := append([]string{"-L", labelOf(dir)}, args...)
	timeout := timeoutMs
	result := proc.Run(psmuxBinary, full, proc.Options{TimeoutMs: &timeout, Input: stdin, Hide: true})
	if result.Error != nil {
		panic(aserr.New("psmux_unavailable", describeWin(result.Error)))
	}
	return CommandResult{Code: result.Code, Stdout: result.Stdout, Stderr: result.Stderr}
}

func (WindowsBackend) Run(dir string, args []string, stdin *string) CommandResult {
	return WindowsBackend{}.runWithTimeout(dir, args, ControlTimeoutMs, stdin)
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

func (WindowsBackend) KillServerWithin(dir string, timeoutMs int) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = aserr.AsError(recovered)
		}
	}()
	result := WindowsBackend{}.runWithTimeout(dir, []string{"kill-server"}, timeoutMs, nil)
	if result.Code == nil || *result.Code != 0 {
		return fmt.Errorf("psmux kill-server failed: %s", strings.TrimSpace(result.Stderr))
	}
	return nil
}

func (WindowsBackend) KillServer(dir string) error {
	return WindowsBackend{}.KillServerWithin(dir, ControlTimeoutMs)
}

// ServerState accepts only an explicit no-server answer as stopped. "no
// sessions" does not prove the server exited. Spawn errors and timeouts return
// ServerUnknown/error instead of panicking past this classification.
func (WindowsBackend) ServerState(dir string, timeoutMs int) (state ServerState, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			state = ServerUnknown
			err = aserr.AsError(recovered)
		}
	}()
	if timeoutMs <= 0 {
		return ServerUnknown, nil
	}
	result := WindowsBackend{}.runWithTimeout(dir, []string{"list-sessions"}, timeoutMs, nil)
	if result.Code != nil && *result.Code == 0 {
		return ServerRunning, nil
	}
	if isExplicitNoServer(result.Stderr) {
		return ServerStopped, nil
	}
	return ServerUnknown, fmt.Errorf("cannot determine the psmux server state: %s", strings.TrimSpace(result.Stderr))
}

func (WindowsBackend) ServerPid(dir string) (int, error) {
	result := WindowsBackend{}.runWithTimeout(dir, []string{"display-message", "-p", "#{pid}"}, ControlTimeoutMs, nil)
	if result.Code == nil || *result.Code != 0 {
		return 0, fmt.Errorf("psmux display-message failed: %s", strings.TrimSpace(result.Stderr))
	}
	pid, err := strconv.Atoi(strings.TrimSpace(result.Stdout))
	if err != nil || pid <= 0 {
		return 0, fmt.Errorf("psmux returned an invalid server pid: %q", strings.TrimSpace(result.Stdout))
	}
	return pid, nil
}

// captureSink is TS captureSink: the server writes the pane's raw bytes; no shell.
func captureSink(rawPath string) string {
	if strings.Contains(rawPath, `"`) {
		panic(aserr.New("invalid_path", "The capture log path cannot contain a quote: "+rawPath))
	}
	return `cat >> "` + rawPath + `"`
}

func (WindowsBackend) Start(dir string, selfArgv []string, rawPath string, afterBind func() error) {
	newArgs := append([]string{"new-session", "-d", "-s", Session, "-x", "200", "-y", "50", "--"}, selfArgv...)
	WindowsBackend{}.RunOk(dir, newArgs, "session_failed", nil)
	if err := afterBind(); err != nil {
		panic(err)
	}
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
func shellForQueryWithin(timeoutMs int) []string {
	deadline := time.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
	for _, candidate := range []string{"pwsh", "powershell"} {
		remaining := int(time.Until(deadline).Milliseconds())
		if remaining <= 0 {
			break
		}
		timeout := remaining
		if timeout > 5000 {
			timeout = 5000
		}
		probe := proc.Run(candidate, []string{"-NoProfile", "-NonInteractive", "-Command", "exit 0"}, proc.Options{TimeoutMs: &timeout, Hide: true})
		if probe.Error == nil && probe.Code != nil && *probe.Code == 0 {
			return []string{candidate, "-NoProfile", "-NonInteractive", "-Command"}
		}
	}
	panic(aserr.New("process_inspection_failed",
		"Neither pwsh nor Windows PowerShell could be started to inspect process ownership; the task fence is kept."))
}

func shellForQuery() []string { return shellForQueryWithin(ownershipTimeoutMs) }

const ownershipScriptPrefix = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)"

func (WindowsBackend) OwnsProcessWithin(pid int, marker string, dir string, timeoutMs int) bool {
	if timeoutMs <= 0 {
		panic(aserr.New("process_inspection_failed", "No time remains to inspect pid "+strconv.Itoa(pid)+"."))
	}
	deadline := time.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
	shell := shellForQueryWithin(timeoutMs)
	script := strings.Join([]string{
		ownershipScriptPrefix,
		`$p = Get-CimInstance Win32_Process -Filter "ProcessId=` + strconv.Itoa(pid) + `" -ErrorAction Stop`,
		`$answer = 'absent'`,
		`if ($p) { $answer = 'unreadable' }`,
		`if ($p -and -not [string]::IsNullOrEmpty($p.CommandLine)) { $answer = 'cmd:' + $p.CommandLine }`,
		"[Console]::Out.Write($answer)",
	}, "; ")
	args := append(append([]string{}, shell[1:]...), script)
	timeout := int(time.Until(deadline).Milliseconds())
	if timeout <= 0 {
		panic(aserr.New("process_inspection_failed", "No time remains to inspect pid "+strconv.Itoa(pid)+"."))
	}
	if timeout > ownershipTimeoutMs {
		timeout = ownershipTimeoutMs
	}
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

func (WindowsBackend) OwnsProcess(pid int, marker string, dir string) bool {
	return WindowsBackend{}.OwnsProcessWithin(pid, marker, dir, ControlTimeoutMs)
}

// Default is tmux.ts's `backend` selection for Windows builds.
func Default() ShellBackend { return WindowsBackend{} }
