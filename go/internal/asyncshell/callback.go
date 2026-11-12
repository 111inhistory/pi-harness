package asyncshell

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"pijob/internal/asyncshell/aserr"
	"pijob/internal/asyncshell/ipc"
)

// writeSocket sends NDJSON and waits for the receiver's acknowledgements.
func writeSocket(socketPath string, payload interface{}) error {
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
	connection, err := ipc.Dial(socketPath)
	if err != nil {
		return aserr.Coded(err, "ECONNREFUSED")
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(ipc.Timeout))
	if _, err := connection.Write([]byte(text)); err != nil {
		return aserr.Coded(err, "EPIPE")
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
			return &aserr.CodedError{Code: "missing_response", Err: readErr}
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
				return &aserr.CodedError{Code: "invalid_response", Err: errors.New("Invalid socket response.")}
			}
			code := parsed.Code
			if code == "" {
				code = "delivery_failed"
			}
			return &aserr.CodedError{Code: code, Err: errors.New(parsed.Message)}
		}
	}
	return nil
}
