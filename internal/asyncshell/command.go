package asyncshell

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"strings"
	"time"
)

// command.go runs child processes with the subset of spawn options the engine
// needs, using os/exec directly.

type commandResult struct {
	Code   *int
	Stdout string
	Stderr string
	Error  error
}

type commandOptions struct {
	TimeoutMs *int
	Input     *string
	Env       map[string]string
	Verbatim  bool
	Hide      bool
}

func runCommand(command string, args []string, options commandOptions) commandResult {
	ctx := context.Background()
	cancel := func() {}
	if options.TimeoutMs != nil && *options.TimeoutMs > 0 {
		ctx, cancel = context.WithTimeout(ctx, time.Duration(*options.TimeoutMs)*time.Millisecond)
	}
	defer cancel()
	cmd := exec.CommandContext(ctx, command, args...)
	if options.Env != nil {
		cmd.Env = envSlice(options.Env)
	}
	if options.Input != nil {
		cmd.Stdin = strings.NewReader(*options.Input)
	}
	if options.Verbatim {
		applyVerbatim(cmd, command, args)
	}
	if options.Hide {
		applyHidden(cmd)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	result := commandResult{Stdout: stdout.String(), Stderr: stderr.String()}
	if ctx.Err() == context.DeadlineExceeded {
		result.Error = coded(ctx.Err(), "ETIMEDOUT")
		return result
	}
	if err == nil {
		code := 0
		result.Code = &code
		return result
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		if code := exitError.ExitCode(); code >= 0 {
			result.Code = &code
		}
		return result
	}
	result.Error = coded(err, "ENOENT")
	return result
}

// startDetached starts the per-task monitor in its own session/process group.
func startDetached(command string, args []string, env map[string]string) (*int, error) {
	cmd := exec.Command(command, args...)
	if env != nil {
		cmd.Env = envSlice(env)
	}
	applyDetached(cmd)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()
	return &pid, nil
}

func envSlice(env map[string]string) []string {
	if env == nil {
		return nil
	}
	out := make([]string, 0, len(env))
	for key, value := range env {
		out = append(out, key+"="+value)
	}
	return out
}
