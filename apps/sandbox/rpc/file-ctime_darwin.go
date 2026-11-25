//go:build darwin

package rpc

import (
	"os"
	"syscall"

	"github.com/cohub/apps/sandbox/protocol"
)

func fileCtimeMs(info os.FileInfo) (int64, bool) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return protocol.TimespecMs(stat.Ctimespec.Sec, stat.Ctimespec.Nsec), true
}
