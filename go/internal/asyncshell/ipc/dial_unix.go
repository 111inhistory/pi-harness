//go:build !windows

package ipc

import "net"

// Dial connects to the callback's Unix socket.
func Dial(address string) (Conn, error) {
	connection, err := net.DialTimeout("unix", address, Timeout)
	if err != nil {
		return nil, err
	}
	return connection, nil
}
