package display

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strings"
)

func DialerFor(spec string, logger *slog.Logger) (Dialer, error) {
	spec = strings.TrimSpace(spec)
	switch {
	case spec == "":
		return nil, nil
	case spec == "test":
		return screenDialer("test", func() (Screen, error) { return newTestScreen(logger), nil }, logger), nil
	case strings.HasPrefix(spec, "unix:"):
		path := strings.TrimPrefix(spec, "unix:")
		if path == "" {
			return nil, fmt.Errorf("display spec %q has no socket path", spec)
		}
		return func(ctx context.Context) (io.ReadWriteCloser, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "unix", path)
		}, nil
	default:
		return platformDialer(spec, logger)
	}
}

func screenDialer(name string, open func() (Screen, error), logger *slog.Logger) Dialer {
	return func(ctx context.Context) (io.ReadWriteCloser, error) {
		screen, err := open()
		if err != nil {
			return nil, err
		}
		local, remote := net.Pipe()
		go ServeScreen(ctx, remote, name, screen, logger)
		return local, nil
	}
}
