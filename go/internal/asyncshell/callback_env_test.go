package asyncshell

import (
	"fmt"
	"strings"
	"testing"
)

// Callback intent is the endpoint/token pair: both absent keeps the CLI
// standalone, while a partial pair or a managed pair without the owning Actor
// is refused instead of running an untracked task.
func TestCallbackFromEnvRequiresCompleteManagedTriple(t *testing.T) {
	clear := func(t *testing.T) {
		t.Helper()
		for _, key := range []string{"PI_AGENT_SOCKET", "PI_ASYNC_SHELL_TOKEN", "PI_AGENT_ID", "PI_ASYNC_SHELL_HOST_ERROR"} {
			t.Setenv(key, "")
		}
	}

	t.Run("no wiring stays standalone", func(t *testing.T) {
		clear(t)
		if target := CallbackFromEnv(); target != nil {
			t.Fatalf("target = %#v, want nil", target)
		}
	})

	t.Run("actor alone stays standalone", func(t *testing.T) {
		clear(t)
		t.Setenv("PI_AGENT_ID", "sub_1")
		if target := CallbackFromEnv(); target != nil {
			t.Fatalf("target = %#v, want nil", target)
		}
	})

	t.Run("complete triple is a managed callback", func(t *testing.T) {
		clear(t)
		t.Setenv("PI_AGENT_SOCKET", "/tmp/project/main.sock")
		t.Setenv("PI_ASYNC_SHELL_TOKEN", "token-a")
		t.Setenv("PI_AGENT_ID", "sub_1")
		target := CallbackFromEnv()
		if target == nil || target.Socket != "/tmp/project/main.sock" || target.Token != "token-a" || target.AgentID != "sub_1" {
			t.Fatalf("target = %#v", target)
		}
	})

	for _, partial := range [][2]string{
		{"PI_AGENT_SOCKET", "/tmp/project/main.sock"},
		{"PI_ASYNC_SHELL_TOKEN", "token-a"},
	} {
		t.Run("partial pair "+partial[0], func(t *testing.T) {
			clear(t)
			t.Setenv(partial[0], partial[1])
			assertPanicsIncomplete(t)
		})
	}

	t.Run("managed pair without actor", func(t *testing.T) {
		clear(t)
		t.Setenv("PI_AGENT_SOCKET", "/tmp/project/main.sock")
		t.Setenv("PI_ASYNC_SHELL_TOKEN", "token-a")
		assertPanicsIncomplete(t)
	})
}

func assertPanicsIncomplete(t *testing.T) {
	t.Helper()
	defer func() {
		recovered := recover()
		if recovered == nil {
			t.Fatal("CallbackFromEnv accepted an incomplete managed environment")
		}
		message := ""
		if err, ok := recovered.(error); ok {
			message = err.Error()
		} else {
			message = fmt.Sprint(recovered)
		}
		if !strings.Contains(message, "required together") {
			t.Fatalf("panic = %q", message)
		}
	}()
	_ = CallbackFromEnv()
}
