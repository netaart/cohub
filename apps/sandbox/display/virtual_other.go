//go:build !(linux && !android)

package display

import "log/slog"

func virtualAvailable() bool { return false }

func startVirtual(string, *slog.Logger) (Dialer, func(), error) {
	return nil, nil, errorf(CodeUnsupported, "virtual screens need Linux")
}
