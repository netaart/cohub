//go:build !(linux && !android) && !darwin

package display

import (
	"fmt"
	"log/slog"
)

func platformDialer(spec string, _ *slog.Logger) (Dialer, error) {
	return nil, fmt.Errorf("display spec %q is not supported on this platform", spec)
}
