//go:build windows

package display

import "golang.org/x/sys/windows"

func freeBytes(path string) (uint64, bool) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, false
	}
	var free uint64
	if windows.GetDiskFreeSpaceEx(name, &free, nil, nil) != nil {
		return 0, false
	}
	return free, true
}
