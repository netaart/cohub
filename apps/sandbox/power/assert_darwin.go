//go:build darwin

package power

import (
	"fmt"
	"sync"

	"github.com/ebitengine/purego"
)

const (
	assertionLevelOn = 255
	cfStringUTF8     = 0x08000100
)

var iokit struct {
	once    sync.Once
	err     error
	create  func(kind, level, name uintptr, id *uint32) int32
	release func(id uint32) int32
	text    func(alloc uintptr, text string, encoding uint32) uintptr
	free    func(uintptr)
}

func loadIOKit() error {
	iokit.once.Do(func() {
		foundation, err := purego.Dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", purego.RTLD_LAZY)
		if err != nil {
			iokit.err = err
			return
		}
		kit, err := purego.Dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", purego.RTLD_LAZY)
		if err != nil {
			iokit.err = err
			return
		}
		purego.RegisterLibFunc(&iokit.text, foundation, "CFStringCreateWithCString")
		purego.RegisterLibFunc(&iokit.free, foundation, "CFRelease")
		purego.RegisterLibFunc(&iokit.create, kit, "IOPMAssertionCreateWithName")
		purego.RegisterLibFunc(&iokit.release, kit, "IOPMAssertionRelease")
	})
	return iokit.err
}

func platformAssert() (func(), error) {
	if err := loadIOKit(); err != nil {
		return nil, err
	}
	kind := iokit.text(0, "PreventUserIdleSystemSleep", cfStringUTF8)
	defer iokit.free(kind)
	name := iokit.text(0, "Cohub is running a task", cfStringUTF8)
	defer iokit.free(name)
	var id uint32
	if status := iokit.create(kind, assertionLevelOn, name, &id); status != 0 {
		return nil, fmt.Errorf("IOPMAssertionCreateWithName: %d", status)
	}
	return func() { iokit.release(id) }, nil
}
