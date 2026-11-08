//go:build darwin

package display

import (
	"context"
	"strconv"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	cgWindowListOnScreenOnly   = 1 << 0
	cgWindowListExcludeDesktop = 1 << 4
)

var cgWindows struct {
	copyInfo func(options uint32, relativeTo uint32) uintptr
	keys     struct{ number, owner, name, bounds, layer, x, y, width, height uintptr }
}

var cgWindowsOnce sync.Once

func loadWindowList() bool {
	cgWindowsOnce.Do(func() {
		graphics := quartzLibs.graphics
		if graphics == 0 || symbolAddress(graphics, "CGWindowListCopyWindowInfo") == 0 {
			return
		}
		purego.RegisterLibFunc(&cgWindows.copyInfo, graphics, "CGWindowListCopyWindowInfo")
		k := &cgWindows.keys
		k.number, k.owner, k.name = global(graphics, "kCGWindowNumber"), global(graphics, "kCGWindowOwnerName"), global(graphics, "kCGWindowName")
		k.bounds, k.layer = global(graphics, "kCGWindowBounds"), global(graphics, "kCGWindowLayer")
		k.x, k.y, k.width, k.height = cfString("X"), cfString("Y"), cfString("Width"), cfString("Height")
	})
	return cgWindows.copyInfo != nil
}

func cfFloat(ref uintptr) float64 {
	var value float64
	if ref == 0 || cf.typeID(ref) != cf.numberTypeID() || !cf.numberGetValue(ref, cfNumberDouble, unsafe.Pointer(&value)) {
		return 0
	}
	return value
}

func (s *macScreen) Windows(context.Context) ([]Window, error) {
	if !loadWindowList() {
		return nil, errorf(CodeUnsupported, "this Mac does not list its windows")
	}
	width, height := s.size()
	if width <= 0 || height <= 0 {
		return nil, errorf(CodeUnavailable, "no main display")
	}
	list := cgWindows.copyInfo(cgWindowListOnScreenOnly|cgWindowListExcludeDesktop, 0)
	if list == 0 {
		return nil, errorf(CodeFailed, "list windows")
	}
	defer cf.release(list)
	k := cgWindows.keys
	windows := []Window{}
	for i := range cf.arrayCount(list) {
		entry := cf.arrayAt(list, i)
		if layer, _ := cfInt(cf.dictionaryGet(entry, k.layer)); layer != 0 {
			continue
		}
		number, ok := cfInt(cf.dictionaryGet(entry, k.number))
		frame := cf.dictionaryGet(entry, k.bounds)
		if !ok || frame == 0 {
			continue
		}
		box := [4]float64{
			cfFloat(cf.dictionaryGet(frame, k.x)) / width, cfFloat(cf.dictionaryGet(frame, k.y)) / height,
			cfFloat(cf.dictionaryGet(frame, k.width)) / width, cfFloat(cf.dictionaryGet(frame, k.height)) / height,
		}
		bounds := (&Focus{Bounds: box}).clean()
		if bounds == nil || bounds.Bounds[2] == 0 || bounds.Bounds[3] == 0 {
			continue
		}
		windows = append(windows, Window{
			ID: "w" + strconv.FormatInt(number, 10), App: goString(cf.dictionaryGet(entry, k.owner)),
			Title: goString(cf.dictionaryGet(entry, k.name)), Bounds: bounds.Bounds, Focused: len(windows) == 0,
		})
		if len(windows) == MaxWindows {
			break
		}
	}
	return windows, nil
}
