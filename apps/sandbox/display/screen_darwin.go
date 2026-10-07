//go:build darwin

package display

import (
	"context"
	"fmt"
	"image"
	"image/jpeg"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unsafe"

	"github.com/ebitengine/purego"
)

func platformDialer(spec string, logger *slog.Logger) (Dialer, error) {
	if spec != "auto" && spec != "macos" {
		return nil, fmt.Errorf("unknown display spec %q", spec)
	}
	if err := loadQuartz(); err != nil {
		return nil, err
	}
	requestCaptureOnce.Do(func() {
		// Each request shows the system prompt once; grants apply after a restart.
		if !cg.preflightCapture() {
			cg.requestCapture()
			logger.Warn("allow Screen Recording for this terminal in System Settings → Privacy & Security, then restart the Runtime")
		}
		if !promptAccessibility() {
			logger.Warn("allow Accessibility for this terminal in System Settings → Privacy & Security so the Space can control this Mac")
		}
	})
	return screenDialer("macos", func() (Screen, error) { return newMacScreen(), nil }, logger), nil
}

var requestCaptureOnce sync.Once

type cgPoint struct{ X, Y float64 }

var cg struct {
	mainDisplay      func() uint32
	pixelsWide       func(uint32) uintptr
	pixelsHigh       func(uint32) uintptr
	mouseEvent       func(source uintptr, kind uint32, at cgPoint, button uint32) uintptr
	keyboardEvent    func(source uintptr, code uint16, down bool) uintptr
	setUnicodeString func(event uintptr, length uintptr, chars *uint16)
	scrollEvent      func(source uintptr, units uint32, count uint32, wheel1, wheel2, wheel3 int32) uintptr
	setFlags         func(event uintptr, flags uint64)
	setIntegerField  func(event uintptr, field uint32, value int64)
	post             func(tap uint32, event uintptr)
	preflightCapture func() bool
	requestCapture   func() bool
	trusted          func() bool
	trustedPrompt    func(options uintptr) bool
	dictionary       func(allocator uintptr, keys, values *uintptr, count int, keyCallbacks, valueCallbacks uintptr) uintptr
	release          func(uintptr)
}

var quartzLibs struct{ foundation, services uintptr }

var (
	quartzOnce sync.Once
	quartzErr  error
)

func loadQuartz() error {
	quartzOnce.Do(func() {
		open := func(path string) uintptr {
			if quartzErr != nil {
				return 0
			}
			lib, err := purego.Dlopen(path, purego.RTLD_NOW|purego.RTLD_GLOBAL)
			if err != nil {
				quartzErr = fmt.Errorf("load %s: %w", filepath.Base(path), err)
			}
			return lib
		}
		graphics := open("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
		foundation := open("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
		services := open("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
		if quartzErr != nil {
			return
		}
		purego.RegisterLibFunc(&cg.mainDisplay, graphics, "CGMainDisplayID")
		purego.RegisterLibFunc(&cg.pixelsWide, graphics, "CGDisplayPixelsWide")
		purego.RegisterLibFunc(&cg.pixelsHigh, graphics, "CGDisplayPixelsHigh")
		purego.RegisterLibFunc(&cg.mouseEvent, graphics, "CGEventCreateMouseEvent")
		purego.RegisterLibFunc(&cg.keyboardEvent, graphics, "CGEventCreateKeyboardEvent")
		purego.RegisterLibFunc(&cg.setUnicodeString, graphics, "CGEventKeyboardSetUnicodeString")
		purego.RegisterLibFunc(&cg.scrollEvent, graphics, "CGEventCreateScrollWheelEvent2")
		purego.RegisterLibFunc(&cg.setFlags, graphics, "CGEventSetFlags")
		purego.RegisterLibFunc(&cg.setIntegerField, graphics, "CGEventSetIntegerValueField")
		purego.RegisterLibFunc(&cg.post, graphics, "CGEventPost")
		purego.RegisterLibFunc(&cg.preflightCapture, graphics, "CGPreflightScreenCaptureAccess")
		purego.RegisterLibFunc(&cg.requestCapture, graphics, "CGRequestScreenCaptureAccess")
		purego.RegisterLibFunc(&cg.trusted, services, "AXIsProcessTrusted")
		purego.RegisterLibFunc(&cg.trustedPrompt, services, "AXIsProcessTrustedWithOptions")
		purego.RegisterLibFunc(&cg.dictionary, foundation, "CFDictionaryCreate")
		purego.RegisterLibFunc(&cg.release, foundation, "CFRelease")
		quartzLibs.foundation, quartzLibs.services = foundation, services
	})
	return quartzErr
}

func promptAccessibility() bool {
	symbol := func(lib uintptr, name string) uintptr {
		address, err := purego.Dlsym(lib, name)
		if err != nil {
			return 0
		}
		return address
	}
	prompt := symbol(quartzLibs.services, "kAXTrustedCheckOptionPrompt")
	yes := symbol(quartzLibs.foundation, "kCFBooleanTrue")
	keyCallbacks := symbol(quartzLibs.foundation, "kCFTypeDictionaryKeyCallBacks")
	valueCallbacks := symbol(quartzLibs.foundation, "kCFTypeDictionaryValueCallBacks")
	if prompt == 0 || yes == 0 || keyCallbacks == 0 || valueCallbacks == 0 {
		return cg.trusted()
	}
	// The option key and value are CF globals: read the pointers they hold.
	key, value := **(**uintptr)(unsafe.Pointer(&prompt)), **(**uintptr)(unsafe.Pointer(&yes))
	options := cg.dictionary(0, &key, &value, 1, keyCallbacks, valueCallbacks)
	if options == 0 {
		return cg.trusted()
	}
	defer cg.release(options)
	return cg.trustedPrompt(options)
}

const (
	cgHIDEventTap            = 0
	cgScrollUnitPixel        = 0
	cgMouseClickState        = 1
	cgFlagShift       uint64 = 0x00020000
	cgFlagControl     uint64 = 0x00040000
	cgFlagAlt         uint64 = 0x00080000
	cgFlagCommand     uint64 = 0x00100000

	doubleClickInterval = 400 * time.Millisecond
	doubleClickDistance = 4.0
	unicodeChunk        = 20
)

var cgMouseTypes = map[string][3]uint32{
	"primary":   {1, 2, 6},
	"secondary": {3, 4, 7},
	"middle":    {25, 26, 27},
}

var cgModifierFlags = map[string]uint64{"Shift": cgFlagShift, "Control": cgFlagControl, "Alt": cgFlagAlt, "Meta": cgFlagCommand}

type macScreen struct {
	display uint32
	name    string

	mu       sync.Mutex
	flags    uint64
	button   string
	at       cgPoint
	lastDown time.Time
	lastAt   cgPoint
	clicks   int64
}

func newMacScreen() *macScreen {
	return &macScreen{display: cg.mainDisplay(), name: hostName()}
}

func (s *macScreen) size() (float64, float64) {
	return float64(cg.pixelsWide(s.display)), float64(cg.pixelsHigh(s.display))
}

func (s *macScreen) Info() (Info, error) {
	width, height := s.size()
	info := Info{
		ID: "screen", Name: s.name, Width: int(width), Height: int(height),
		Capture: cg.preflightCapture(), Input: cg.trusted(), Desktop: true,
	}
	if !info.Capture {
		info.Needs = append(info.Needs, "screenRecording")
	}
	if !info.Input {
		info.Needs = append(info.Needs, "accessibility")
	}
	return info, nil
}

func (s *macScreen) Source(fps int) []string {
	if !cg.preflightCapture() {
		return nil
	}
	return []string{"-f", "avfoundation", "-capture_cursor", "1", "-pixel_format", "nv12", "-framerate", fmt.Sprint(fps), "-i", "Capture screen 0:none"}
}

func (s *macScreen) Capture(ctx context.Context) (image.Image, error) {
	file, err := os.CreateTemp("", "cohub-screen-*.jpg")
	if err != nil {
		return nil, err
	}
	path := file.Name()
	_ = file.Close()
	defer os.Remove(path)
	if out, err := exec.CommandContext(ctx, "/usr/sbin/screencapture", "-x", "-m", "-t", "jpg", path).CombinedOutput(); err != nil {
		return nil, errorf(CodeFailed, "screencapture: %v %s", err, strings.TrimSpace(string(out)))
	}
	file, err = os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	img, err := jpeg.Decode(file)
	if err != nil {
		return nil, errorf(CodeFailed, "read screenshot: %v", err)
	}
	return img, nil
}

func (s *macScreen) post(event uintptr) error {
	if event == 0 {
		return errorf(CodeFailed, "Quartz refused the event")
	}
	defer cg.release(event)
	if s.flags != 0 {
		cg.setFlags(event, s.flags)
	}
	cg.post(cgHIDEventTap, event)
	return nil
}

func (s *macScreen) point(x, y float64) cgPoint {
	width, height := s.size()
	return cgPoint{X: x * max(0, width-1), Y: y * max(0, height-1)}
}

func (s *macScreen) Pointer(action string, x, y float64, button string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	at := s.point(x, y)
	s.at = at
	switch action {
	case "down":
		if button == "" {
			button = "primary"
		}
		s.button = button
		near := at.X-s.lastAt.X < doubleClickDistance && s.lastAt.X-at.X < doubleClickDistance && at.Y-s.lastAt.Y < doubleClickDistance && s.lastAt.Y-at.Y < doubleClickDistance
		if near && time.Since(s.lastDown) < doubleClickInterval {
			s.clicks++
		} else {
			s.clicks = 1
		}
		s.lastDown, s.lastAt = time.Now(), at
		return s.mouse(cgMouseTypes[button][0], at, button)
	case "move":
		if s.button != "" {
			return s.mouse(cgMouseTypes[s.button][2], at, s.button)
		}
		return s.mouse(5, at, "primary")
	case "up", "cancel":
		if s.button == "" {
			return nil
		}
		button := s.button
		s.button = ""
		return s.mouse(cgMouseTypes[button][1], at, button)
	}
	return nil
}

func (s *macScreen) mouse(kind uint32, at cgPoint, button string) error {
	event := cg.mouseEvent(0, kind, at, uint32(map[string]int{"primary": 0, "secondary": 1, "middle": 2}[button]))
	if event != 0 && kind != 5 {
		cg.setIntegerField(event, cgMouseClickState, s.clicks)
	}
	return s.post(event)
}

func (s *macScreen) Scroll(x, y, dx, dy float64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	at := s.point(x, y)
	if err := s.mouse(5, at, "primary"); err != nil {
		return err
	}
	width, height := s.size()
	// Positive wheel values scroll content down; dy > 0 reveals what is below.
	return s.post(cg.scrollEvent(0, cgScrollUnitPixel, 2, int32(-dy*height), int32(-dx*width), 0))
}

func (s *macScreen) Key(down bool, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if flag, ok := cgModifierFlags[key]; ok {
		if down {
			s.flags |= flag
		} else {
			s.flags &^= flag
		}
		return s.post(cg.keyboardEvent(0, namedKeys[key].mac, down))
	}
	if named, ok := namedKeys[key]; ok {
		return s.post(cg.keyboardEvent(0, named.mac, down))
	}
	runes := []rune(key)
	if len(runes) != 1 {
		return errorf(CodeUnsupported, "key %q is not supported", key)
	}
	if code, ok := macCharKeys[runes[0]]; ok && s.flags&(cgFlagCommand|cgFlagControl|cgFlagAlt) != 0 {
		return s.post(cg.keyboardEvent(0, code, down))
	}
	return s.unicode(key, down)
}

func (s *macScreen) unicode(text string, down bool) error {
	chars := utf16.Encode([]rune(text))
	event := cg.keyboardEvent(0, 0, down)
	if event != 0 {
		cg.setUnicodeString(event, uintptr(len(chars)), &chars[0])
	}
	return s.post(event)
}

func (s *macScreen) Text(text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, line := range strings.SplitAfter(text, "\n") {
		body := strings.TrimSuffix(line, "\n")
		runes := []rune(body)
		for start := 0; start < len(runes); start += unicodeChunk {
			chunk := string(runes[start:min(len(runes), start+unicodeChunk)])
			if err := s.unicode(chunk, true); err != nil {
				return err
			}
			if err := s.unicode(chunk, false); err != nil {
				return err
			}
		}
		if body != line {
			enter := namedKeys["Enter"].mac
			if err := s.post(cg.keyboardEvent(0, enter, true)); err != nil {
				return err
			}
			if err := s.post(cg.keyboardEvent(0, enter, false)); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *macScreen) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.button != "" {
		_ = s.mouse(cgMouseTypes[s.button][1], s.at, s.button)
		s.button = ""
	}
	return nil
}
