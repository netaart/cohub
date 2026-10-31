//go:build windows

package power

import (
	"fmt"
	"runtime"

	"golang.org/x/sys/windows"
)

const (
	esContinuous     = 0x80000000
	esSystemRequired = 0x00000001
)

var setThreadExecutionState = windows.NewLazySystemDLL("kernel32.dll").NewProc("SetThreadExecutionState")

func platformAssert() (func(), error) {
	started := make(chan error, 1)
	stop := make(chan struct{})
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		if previous, _, err := setThreadExecutionState.Call(esContinuous | esSystemRequired); previous == 0 {
			started <- fmt.Errorf("SetThreadExecutionState: %w", err)
			return
		}
		started <- nil
		<-stop
		_, _, _ = setThreadExecutionState.Call(esContinuous)
	}()
	if err := <-started; err != nil {
		return nil, err
	}
	return func() { close(stop) }, nil
}
