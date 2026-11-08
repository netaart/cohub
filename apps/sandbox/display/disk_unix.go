//go:build !windows

package display

import "golang.org/x/sys/unix"

func freeBytes(path string) (uint64, bool) {
	var stat unix.Statfs_t
	if unix.Statfs(path, &stat) != nil {
		return 0, false
	}
	return stat.Bavail * uint64(stat.Bsize), true
}
