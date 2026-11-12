//go:build windows

package asyncshell

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
)

func TestWriteSocketNamedPipe(t *testing.T) {
	address := fmt.Sprintf(`\\.\pipe\pi-job-test-%d-%d`, os.Getpid(), time.Now().UnixNano())
	listener, err := winio.ListenPipe(address, &winio.PipeConfig{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	frames := make(chan string, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		scanner := bufio.NewScanner(connection)
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				continue
			}
			select {
			case frames <- line:
			default:
			}
			_, _ = connection.Write([]byte("\n"))
		}
	}()

	frame := AsyncShellRegisterFrame{
		Kind: "async-shell", Token: "test-token", Operation: "register",
		ID: "job_11111111", Directory: `C:\tmp\job_11111111`, PID: os.Getpid(),
	}
	if err := writeSocket(address, frame); err != nil {
		t.Fatal(err)
	}

	select {
	case line := <-frames:
		var parsed AsyncShellRegisterFrame
		if err := json.Unmarshal([]byte(line), &parsed); err != nil {
			t.Fatal(err)
		}
		if parsed.Kind != "async-shell" || parsed.Token != "test-token" || parsed.Operation != "register" ||
			parsed.ID != "job_11111111" || parsed.Directory != `C:\tmp\job_11111111` {
			t.Fatalf("frame = %#v", parsed)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the callback server did not receive the frame")
	}
}
