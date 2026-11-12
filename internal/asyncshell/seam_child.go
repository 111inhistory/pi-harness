package asyncshell

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"strings"
	"time"
)

// seam_child.go implements the child_process subset using os/exec.

// SpawnSync is child_process.spawnSync(command, args, options).
func SpawnSync(command string, args []string, options *SpawnOptions) SpawnResult {
	ctx := context.Background()
	cancel := func() {}
	if options != nil && options.TimeoutMs != nil && *options.TimeoutMs > 0 {
		ctx, cancel = context.WithTimeout(ctx, time.Duration(*options.TimeoutMs)*time.Millisecond)
	}
	defer cancel()
	cmd := exec.CommandContext(ctx, command, args...)
	if options != nil {
		if options.Env != nil {
			cmd.Env = envSlice(options.Env)
		}
		if options.Input != nil {
			cmd.Stdin = strings.NewReader(*options.Input)
		}
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	result := SpawnResult{Stdout: stdout.String(), Stderr: stderr.String()}
	// Node spawnSync reports a timeout as an ETIMEDOUT error with no status.
	if ctx.Err() == context.DeadlineExceeded {
		result.Error = coded(ctx.Err(), "ETIMEDOUT")
		return result
	}
	if err == nil {
		code := 0
		result.Status = &code
		return result
	}
	var exitError *exec.ExitError
	if ok := asExitError(err, &exitError); ok {
		if code := exitError.ExitCode(); code >= 0 {
			result.Status = &code
		}
		return result
	}
	result.Error = coded(err, "ENOENT")
	return result
}

func asExitError(err error, target **exec.ExitError) bool {
	if exitError, ok := err.(*exec.ExitError); ok {
		*target = exitError
		return true
	}
	return false
}

// SpawnInherit is child_process.spawn(...) with inherited stdio (runnerMain).
func SpawnInherit(file string, args []string, options SpawnInheritOptions) ChildProcess {
	cmd := exec.Command(file, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if options.Cwd != "" {
		cmd.Dir = options.Cwd
	}
	if options.Env != nil {
		cmd.Env = envSlice(options.Env)
	}
	child := ChildProcess{}
	if err := cmd.Start(); err != nil {
		child.waitErr = coded(err, "ENOENT")
		return child
	}
	pid := cmd.Process.Pid
	child.Pid = &pid
	child.cmd = cmd.Process
	return child
}

// Kill is child.kill(signal).
func (c *ChildProcess) Kill(signal string) {
	if c.cmd == nil {
		return
	}
	_ = c.cmd.Signal(signalFor(signal))
}

// OnceExit is child.once("exit", handler).
func (c *ChildProcess) OnceExit(handler func(code *int, signal *string)) {
	c.exitHandlers = append(c.exitHandlers, handler)
}

// OnceError is child.once("error", handler).
func (c *ChildProcess) OnceError(handler func(err error)) {
	c.errorHandlers = append(c.errorHandlers, handler)
}

// Wait blocks until the exit or error handler fired; 0 for exit, 1 for error.
func (c *ChildProcess) Wait() int {
	if c.waitErr != nil {
		for _, handler := range c.errorHandlers {
			handler(c.waitErr)
		}
		return 1
	}
	if c.cmd == nil {
		return 1
	}
	state, _ := c.cmd.Wait()
	var codePtr *int
	if state != nil {
		if code := state.ExitCode(); code >= 0 {
			codePtr = &code
		}
	}
	var signal *string
	if state != nil {
		signal = exitSignal(state)
	}
	for _, handler := range c.exitHandlers {
		handler(codePtr, signal)
	}
	return 0
}

// SpawnDetached is child_process.spawn(..., { detached: true, stdio: "ignore" }).
func SpawnDetached(command string, args []string, options SpawnDetachedOptions) DetachedChild {
	cmd := exec.Command(command, args...)
	if options.Env != nil {
		cmd.Env = envSlice(options.Env)
	}
	cmd.SysProcAttr = detachedSysProcAttr()
	if err := cmd.Start(); err != nil {
		panic(coded(err, "ENOENT"))
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()
	return DetachedChild{Pid: &pid}
}
