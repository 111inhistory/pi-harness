package asyncshell

import (
	"encoding/json"
	"errors"
	"net"
	"strings"
	"time"
)

// seam_ipc.go implements the IPC write used for register/complete frames.

const socketWriteTimeout = 5 * time.Second

// WriteSocket is writeSocket(socketPath, payload): NDJSON out, acknowledgements back.
func WriteSocket(socketPath string, payload interface{}) error {
	text := ""
	if value, ok := payload.(string); ok {
		text = value
	} else {
		data, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		text = string(data)
	}
	if !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	expected := 0
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) != "" {
			expected++
		}
	}
	connection, err := net.DialTimeout("unix", socketPath, socketWriteTimeout)
	if err != nil {
		return coded(err, "ECONNREFUSED")
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(socketWriteTimeout))
	if _, err := connection.Write([]byte(text)); err != nil {
		return coded(err, "EPIPE")
	}
	decoder := newUTF8Decoder()
	buffer := ""
	received := 0
	chunk := make([]byte, 4096)
	for received < expected {
		read, readErr := connection.Read(chunk)
		if read > 0 {
			buffer += decoder.write(chunk[:read])
		}
		if readErr != nil {
			return &codedError{Code: "missing_response", Err: readErr}
		}
		for {
			index := strings.IndexByte(buffer, '\n')
			if index < 0 {
				break
			}
			line := buffer[:index]
			buffer = buffer[index+1:]
			if strings.TrimSpace(line) == "" {
				received++
				if received == expected {
					return nil
				}
				continue
			}
			var parsed struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			}
			if err := json.Unmarshal([]byte(line), &parsed); err != nil || parsed.Message == "" {
				return &codedError{Code: "invalid_response", Err: errors.New("Invalid socket response.")}
			}
			code := parsed.Code
			if code == "" {
				code = "delivery_failed"
			}
			return &codedError{Code: code, Err: errors.New(parsed.Message)}
		}
	}
	return nil
}
