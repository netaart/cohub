//go:build windows

package display

import (
	"context"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	procEnumWindows         = user32.NewProc("EnumWindows")
	procIsWindowVisible     = user32.NewProc("IsWindowVisible")
	procIsIconic            = user32.NewProc("IsIconic")
	procGetWindowRect       = user32.NewProc("GetWindowRect")
	procGetWindowTextW      = user32.NewProc("GetWindowTextW")
	procGetForegroundWindow = user32.NewProc("GetForegroundWindow")
)

const (
	gwlExStyle     = ^uintptr(19) // GWL_EXSTYLE (-20)
	wsExToolWindow = 0x00000080
)

// Go never frees a callback, and a process gets about a thousand: one serves every listing.
var (
	enumMu      sync.Mutex
	enumHandles []uintptr
	enumWindow  = syscall.NewCallback(func(hwnd, _ uintptr) uintptr {
		enumHandles = append(enumHandles, hwnd)
		return 1
	})
)

func topLevelWindows() []uintptr {
	enumMu.Lock()
	defer enumMu.Unlock()
	enumHandles = nil
	_, _, _ = procEnumWindows.Call(enumWindow, 0)
	return enumHandles
}

func (s *windowsScreen) Windows(context.Context) ([]Window, error) {
	width, height := float64(systemMetric(smCXScreen)), float64(systemMetric(smCYScreen))
	if width <= 0 || height <= 0 {
		return nil, errorf(CodeUnavailable, "no primary monitor")
	}
	foreground, _, _ := procGetForegroundWindow.Call()
	list := []Window{}
	for _, hwnd := range topLevelWindows() {
		if visible, _, _ := procIsWindowVisible.Call(hwnd); visible == 0 {
			continue
		}
		if iconic, _, _ := procIsIconic.Call(hwnd); iconic != 0 {
			continue
		}
		if style, _, _ := procGetWindowLongPtrW.Call(hwnd, gwlExStyle); style&wsExToolWindow != 0 {
			continue
		}
		title := windowText(hwnd)
		if title == "" {
			continue
		}
		var rect windows.Rect
		if ok, _, _ := procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&rect))); ok == 0 {
			continue
		}
		bounds := (&Focus{Bounds: [4]float64{
			float64(rect.Left) / width, float64(rect.Top) / height,
			float64(rect.Right-rect.Left) / width, float64(rect.Bottom-rect.Top) / height,
		}}).clean()
		if bounds == nil || bounds.Bounds[2] == 0 || bounds.Bounds[3] == 0 {
			continue
		}
		list = append(list, Window{
			ID: "h" + strconv.FormatUint(uint64(hwnd), 16), App: windowApp(hwnd), Title: title,
			Bounds: bounds.Bounds, Focused: hwnd == foreground,
		})
		if len(list) == MaxWindows {
			break
		}
	}
	return list, nil
}

func windowText(hwnd uintptr) string {
	buffer := make([]uint16, 512)
	n, _, _ := procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	return windows.UTF16ToString(buffer[:n])
}

func windowApp(hwnd uintptr) string {
	var pid uint32
	if _, err := windows.GetWindowThreadProcessId(windows.HWND(hwnd), &pid); err != nil || pid == 0 {
		return ""
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(process)
	buffer := make([]uint16, windows.MAX_PATH)
	size := uint32(len(buffer))
	if windows.QueryFullProcessImageName(process, 0, &buffer[0], &size) != nil {
		return ""
	}
	return strings.TrimSuffix(filepath.Base(windows.UTF16ToString(buffer[:size])), ".exe")
}
