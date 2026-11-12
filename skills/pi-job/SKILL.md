---
name: pi-job
description: Run and interact with asynchronous terminal commands using pi-job. Use for long builds, tests, REPLs, progress checks, or multiline terminal input while continuing other work.
compatibility: Requires the installed pi-job CLI, tmux on POSIX or psmux 3.4.0+ on Windows.
---

# Async terminal tasks with pi-job

Use the existing shell tool to call `pi-job`. Commands run in a real terminal and return the result and output per call.

## Create a task

```bash
pi-job create --wait <duration> --timeout <duration> -- npm run build
```

- `--wait <duration>` is optional and limits how long this call waits. Choose the duration for the task; if it is still running, retain its returned `id` and continue independent work. Defaults to 5s for fast-fail on startup.
- `--timeout <duration>` is optional and limits the task's runtime. Choose a suitable limit for bounded work such as builds and tests.
- Both duration values use a non-negative integer followed by an optional unit: `ms`, `s`, or `m` (minutes), defaults to ms. Fractions and negative values are rejected.
- Put the executable and its arguments after `--`. Shell syntax requires an explicit shell:

```bash
pi-job create -- bash -c 'npm run build && npm test'
```

Windows `.cmd` and `.bat` launchers, including `npm`, are resolved using PATH and PATHEXT. Their arguments are escaped for cmd.exe; literal CR/LF inside an argument is refused. Use an executable or stdin for multiline payloads.

Completion is delivered automatically to you. When nothing else can advance, conclude the turn to wait for that event. A Subagent remains in its current assignment while its terminal tasks are running; provide the final handoff after consuming and verifying their results.

## Read incremental output

```bash
pi-job poll TASK_ID
```

Task IDs use `job_<8 lowercase hex digits>`, for example `job_1234cdef`. Use the exact ID returned by `create`.

`poll` returns immediately with new output and current status. Use it when a progress check will inform your next action; wait for the completion event otherwise.

Results contain `id`, `status`, `exitCode`, `output`, `cursor`, `logPath`, and `truncated`. Check status and exit code before treating the command as successful. Terminal states are `completed`, `failed`, `cancelled`, `timed_out`, and `internal_error`. An `internal_error` result includes a `message` reminder: cleanup is best effort; do not assume the command stopped or cleanup completed. Inspect the task before taking further action.

Default responses consume the next output chunk. Read the same task sequentially so its default cursor remains useful. If `truncated` is true, more output remains; poll again when you need the next chunk. A terminal status can still have unread output.

For an independent replay, use a non-consuming read:

```bash
pi-job read TASK_ID --cursor 0
```

Pass the returned byte cursor to read subsequent chunks. `logPath` points to the complete filtered transcript and can also be read with the file-reading tool. The raw PTY log is retained beside it as `raw.log`. Filtered output is a text transcript; full-screen interfaces and cursor rewrites may require inspecting the current terminal or raw log.

## Send text and keys

Use a quoted heredoc for literal multiline text:

```bash
pi-job send TASK_ID <<'EOF'
first line
literal "$value" and $(command)
EOF
```

Quoting `EOF` prevents the calling Bash from expanding the payload. In PowerShell, use a literal here-string:

```powershell
@'
first line
literal "$value" and $(command)
'@ | pi-job send TASK_ID
```

The heredoc or pipeline's trailing newline is part of the input. `send` pastes the text as supplied; the target program's terminal mode determines how it interprets newlines. In Windows console line mode, a bare LF may remain buffered until CR or Enter submits the line. A raw-mode reader can receive LF unchanged, but CRLF may become LF through the Windows terminal path; a separate Enter sends CR.

Send terminal keys explicitly, using tmux key names:

```bash
pi-job key TASK_ID Enter
pi-job key TASK_ID C-c
```

`pi-job send TASK_ID --enter` adds one Enter after the supplied text. To send a single line without a trailing newline first:

```bash
printf '%s' 'some input' | pi-job send TASK_ID
pi-job key TASK_ID Enter
```

## Stop and finish

```bash
pi-job cancel TASK_ID
```

Cancel work that is no longer needed. Use Main for services intended to remain running after delegated work finishes; an outstanding task retains its owning Subagent's assignment.

On failure, inspect the returned output and remaining log, then decide whether to correct the command or report a blocker. A failed or cancelled task is a result to assess, not proof that the broader assignment is complete.

The wrapper obtains completion routing from its shell environment. Use it directly; no callback address or separate completion message is needed.
