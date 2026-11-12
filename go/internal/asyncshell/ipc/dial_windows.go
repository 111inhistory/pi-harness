//go:build windows

package ipc

import (
	"context"

	"github.com/Microsoft/go-winio"
)

// Dial connects to the callback's Named Pipe.
func Dial(address string) (Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), Timeout)
	defer cancel()
	connection, err := winio.DialPipeContext(ctx, address)
	if err != nil {
		return nil, err
	}
	return connection, nil
}
