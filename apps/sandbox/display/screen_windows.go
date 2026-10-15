//go:build windows

package display

import (
	"cmp"
	"context"
	"fmt"
	"image"
	"log/slog"
	"sync"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

type windowsProc interface {
	Call(...uintptr) (uintptr, uintptr, error)
}

var (
	user32 = windows.NewLazySystemDLL("user32.dll")
	gdi32  = windows.NewLazySystemDLL("gdi32.dll")

	procSetProcessDpiAwarenessContext             = user32.NewProc("SetProcessDpiAwarenessContext")
	procGetSystemMetrics                          = user32.NewProc("GetSystemMetrics")
	procGetDC                                     = user32.NewProc("GetDC")
	procReleaseDC                                 = user32.NewProc("ReleaseDC")
	procSendInput                                 = user32.NewProc("SendInput")
	procMapVirtualKeyW                windowsProc = user32.NewProc("MapVirtualKeyW")
	procVkKeyScanW                    windowsProc = user32.NewProc("VkKeyScanW")
	procCreateCompatibleDC                        = gdi32.NewProc("CreateCompatibleDC")
	procCreateDIBSection                          = gdi32.NewProc("CreateDIBSection")
	procSelectObject                              = gdi32.NewProc("SelectObject")
	procBitBlt                                    = gdi32.NewProc("BitBlt")
	procDeleteDC                                  = gdi32.NewProc("DeleteDC")
	procDeleteObject                              = gdi32.NewProc("DeleteObject")
)

const (
	dpiAwarenessPerMonitorV2 = ^uintptr(3) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4)

	smCXScreen   = 0
	smCYScreen   = 1
	smSwapButton = 23

	srcCopy    = 0x00cc0020
	captureBlt = 0x40000000

	inputMouse    = 0
	inputKeyboard = 1

	mouseMove       = 0x0001
	mouseLeftDown   = 0x0002
	mouseLeftUp     = 0x0004
	mouseRightDown  = 0x0008
	mouseRightUp    = 0x0010
	mouseMiddleDown = 0x0020
	mouseMiddleUp   = 0x0040
	mouseWheel      = 0x0800
	mouseHWheel     = 0x1000
	mouseAbsolute   = 0x8000

	keyExtended = 0x0001
	keyUp       = 0x0002
	keyUnicode  = 0x0004

	wheelDelta       = 120
	notchesPerScreen = 20
)

// Keys on the extended block must say so, or Windows reads them as their numeric keypad twins.
var extendedKeys = map[uint16]bool{0x21: true, 0x22: true, 0x23: true, 0x24: true, 0x25: true, 0x26: true, 0x27: true, 0x28: true, 0x2d: true, 0x2e: true, 0x5b: true}

var (
	dpiOnce sync.Once
	dpiErr  error
)

func platformDialer(spec string, logger *slog.Logger) (Dialer, error) {
	if spec != "auto" && spec != "windows" {
		return nil, fmt.Errorf("unknown display spec %q", spec)
	}
	// Per-monitor awareness makes stills, gdigrab's region and input share physical pixels;
	// otherwise a scaled screen reports a smaller, virtualized size.
	dpiOnce.Do(func() {
		if dpiErr = procSetProcessDpiAwarenessContext.Find(); dpiErr != nil {
			dpiErr = fmt.Errorf("screen sharing needs Windows 10 version 1703 or later: %w", dpiErr)
			return
		}
		if ok, _, err := procSetProcessDpiAwarenessContext.Call(dpiAwarenessPerMonitorV2); ok == 0 {
			dpiErr = fmt.Errorf("enable per-monitor DPI awareness: %w", err)
		}
	})
	if dpiErr != nil {
		return nil, dpiErr
	}
	return screenDialer("windows", func() (Screen, error) { return &windowsScreen{name: hostName()}, nil }, logger), nil
}

// windowsScreen shares the primary monitor, which sits at the virtual desktop's origin.
type windowsScreen struct {
	name string

	mu     sync.Mutex
	button string
	at     [2]int32 // normalized absolute pointer position
	keys   map[string][]input
}

func systemMetric(index uintptr) int {
	value, _, _ := procGetSystemMetrics.Call(index)
	return int(int32(value))
}

func (s *windowsScreen) size() (int, int) {
	return systemMetric(smCXScreen), systemMetric(smCYScreen)
}

func (s *windowsScreen) Info() (Info, error) {
	width, height := s.size()
	return Info{ID: "screen", Name: s.name, Width: width, Height: height, Capture: true, Input: true, Desktop: true}, nil
}

func (s *windowsScreen) Source(fps int) []string {
	width, height := s.size()
	return []string{"-f", "gdigrab", "-draw_mouse", "1", "-framerate", fmt.Sprint(fps),
		"-offset_x", "0", "-offset_y", "0", "-video_size", fmt.Sprintf("%dx%d", width, height), "-i", "desktop"}
}

type bitmapInfo struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
	Colors        [1]uint32
}

func (s *windowsScreen) Capture(context.Context) (image.Image, error) {
	width, height := s.size()
	if width <= 0 || height <= 0 {
		return nil, errorf(CodeUnavailable, "no screen to capture")
	}
	screen, _, _ := procGetDC.Call(0)
	if screen == 0 {
		return nil, errorf(CodeFailed, "open the screen device context")
	}
	defer procReleaseDC.Call(0, screen)
	memory, _, _ := procCreateCompatibleDC.Call(screen)
	if memory == 0 {
		return nil, errorf(CodeFailed, "create a memory device context")
	}
	defer procDeleteDC.Call(memory)
	// A negative height makes the bitmap top-down, matching image.RGBA rows.
	info := bitmapInfo{Width: int32(width), Height: -int32(height), Planes: 1, BitCount: 32}
	info.Size = uint32(unsafe.Offsetof(info.Colors))
	var bits unsafe.Pointer
	bitmap, _, _ := procCreateDIBSection.Call(memory, uintptr(unsafe.Pointer(&info)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if bitmap == 0 || bits == nil {
		return nil, errorf(CodeFailed, "create a %dx%d bitmap", width, height)
	}
	defer procDeleteObject.Call(bitmap)
	previous, _, _ := procSelectObject.Call(memory, bitmap)
	defer procSelectObject.Call(memory, previous)
	// The locked or UAC secure desktop refuses the copy.
	if ok, _, err := procBitBlt.Call(memory, 0, 0, uintptr(width), uintptr(height), screen, 0, 0, srcCopy|captureBlt); ok == 0 {
		return nil, errorf(CodeUnavailable, "capture the screen: %v", err)
	}
	pixels := unsafe.Slice((*byte)(bits), width*height*4)
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for i := 0; i < len(pixels); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = pixels[i+2], pixels[i+1], pixels[i], 0xff
	}
	return img, nil
}

// input mirrors INPUT; the union is sized by MOUSEINPUT, its largest member.
type input struct {
	Type  uint32
	Mouse mouseInput
}

type mouseInput struct {
	DX, DY    int32
	MouseData uint32
	Flags     uint32
	Time      uint32
	// Keyboard ExtraInfo overlaps these bytes on 64-bit Windows; Go copies must preserve them.
	Padding   [unsafe.Sizeof(uintptr(0)) - 4]byte
	ExtraInfo uintptr
}

type keyboardInput struct {
	VK, Scan  uint16
	Flags     uint32
	Time      uint32
	ExtraInfo uintptr
}

func mouseEvent(flags uint32, at [2]int32, data int32) input {
	return input{Type: inputMouse, Mouse: mouseInput{DX: at[0], DY: at[1], MouseData: uint32(data), Flags: flags}}
}

func keyEvent(vk, scan uint16, flags uint32) input {
	event := input{Type: inputKeyboard}
	*(*keyboardInput)(unsafe.Pointer(&event.Mouse)) = keyboardInput{VK: vk, Scan: scan, Flags: flags}
	return event
}

func virtualKey(vk uint16, down bool) input {
	var flags uint32
	if !down {
		flags |= keyUp
	}
	if extendedKeys[vk] {
		flags |= keyExtended
	}
	scan, _, _ := procMapVirtualKeyW.Call(uintptr(vk), 0)
	return keyEvent(vk, uint16(scan), flags)
}

func unicodeKeys(events []input, text string, down bool) []input {
	flags := uint32(keyUnicode)
	if !down {
		flags |= keyUp
	}
	for _, unit := range utf16.Encode([]rune(text)) {
		events = append(events, keyEvent(0, unit, flags))
	}
	return events
}

var sendInput = nativeSendInput

func nativeSendInput(events ...input) error {
	sent, _, err := procSendInput.Call(uintptr(len(events)), uintptr(unsafe.Pointer(&events[0])), unsafe.Sizeof(events[0]))
	if int(sent) != len(events) {
		return errorf(CodeFailed, "SendInput: %v", err)
	}
	return nil
}

// point maps a normalized position to SendInput's 0..65535 primary-monitor space,
// rounding up so Windows' floor lands on the intended pixel.
func (s *windowsScreen) point(x, y float64) [2]int32 {
	width, height := s.size()
	width, height = max(1, width), max(1, height)
	px, py := int64(x*float64(width-1)), int64(y*float64(height-1))
	return [2]int32{int32((px*65536 + int64(width) - 1) / int64(width)), int32((py*65536 + int64(height) - 1) / int64(height))}
}

// SendInput reports physical buttons, so swapped buttons must be swapped back.
func buttonFlags(button string) (down, up uint32) {
	if button == "middle" {
		return mouseMiddleDown, mouseMiddleUp
	}
	if (button == "secondary") != (systemMetric(smSwapButton) != 0) {
		return mouseRightDown, mouseRightUp
	}
	return mouseLeftDown, mouseLeftUp
}

func (s *windowsScreen) Pointer(action string, x, y float64, button string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if action != "cancel" {
		s.at = s.point(x, y)
	}
	switch action {
	case "down":
		s.button = cmp.Or(button, "primary")
		down, _ := buttonFlags(s.button)
		return sendInput(mouseEvent(mouseMove|mouseAbsolute|down, s.at, 0))
	case "move":
		return sendInput(mouseEvent(mouseMove|mouseAbsolute, s.at, 0))
	case "up", "cancel":
		if s.button == "" {
			return nil
		}
		_, up := buttonFlags(s.button)
		s.button = ""
		return sendInput(mouseEvent(mouseMove|mouseAbsolute|up, s.at, 0))
	}
	return nil
}

func (s *windowsScreen) Scroll(x, y, dx, dy float64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.at = s.point(x, y)
	events := []input{mouseEvent(mouseMove|mouseAbsolute, s.at, 0)}
	// A positive wheel scrolls up and a positive horizontal wheel right; dy > 0 reveals what is below.
	if dy != 0 {
		events = append(events, mouseEvent(mouseWheel, s.at, -wheelAmount(dy)))
	}
	if dx != 0 {
		events = append(events, mouseEvent(mouseHWheel, s.at, wheelAmount(dx)))
	}
	return sendInput(events...)
}

func wheelAmount(amount float64) int32 {
	delta := int32(notches(amount, notchesPerScreen) * wheelDelta)
	if amount < 0 {
		return -delta
	}
	return delta
}

func (s *windowsScreen) Key(down bool, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	events := s.keys[key]
	if len(events) == 0 {
		if named, ok := namedKeys[key]; ok {
			events = []input{virtualKey(named.win, true)}
		} else {
			runes := []rune(key)
			if len(runes) != 1 {
				return errorf(CodeUnsupported, "key %q is not supported", key)
			}
			// Shortcuts match virtual keys (Ctrl+C), not the characters a layout produces.
			if (s.keys["Control"] != nil || s.keys["Alt"] != nil || s.keys["Meta"] != nil) && runes[0] <= 0xffff {
				if scan, _, _ := procVkKeyScanW.Call(uintptr(runes[0])); int16(scan) != -1 {
					events = []input{virtualKey(uint16(scan&0xff), true)}
				}
			}
			if len(events) == 0 {
				events = unicodeKeys(nil, key, true)
			}
		}
	}
	if !down {
		events = keyReleases(nil, events)
	}
	if err := sendInput(events...); err != nil {
		return err
	}
	if down {
		if s.keys == nil {
			s.keys = map[string][]input{}
		}
		s.keys[key] = events
	} else {
		delete(s.keys, key)
	}
	return nil
}

func keyReleases(events, held []input) []input {
	for _, event := range held {
		(*keyboardInput)(unsafe.Pointer(&event.Mouse)).Flags |= keyUp
		events = append(events, event)
	}
	return events
}

func (s *windowsScreen) Text(text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var events []input
	for _, r := range text {
		if r == '\n' {
			enter := namedKeys["Enter"].win
			events = append(events, virtualKey(enter, true), virtualKey(enter, false))
			continue
		}
		events = unicodeKeys(events, string(r), true)
		events = unicodeKeys(events, string(r), false)
	}
	if len(events) == 0 {
		return nil
	}
	return sendInput(events...)
}

func (s *windowsScreen) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var events []input
	for _, held := range s.keys {
		events = keyReleases(events, held)
	}
	if s.button != "" {
		_, up := buttonFlags(s.button)
		events = append(events, mouseEvent(mouseMove|mouseAbsolute|up, s.at, 0))
	}
	if len(events) > 0 {
		if err := sendInput(events...); err != nil {
			return err
		}
	}
	s.button = ""
	clear(s.keys)
	return nil
}
