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
	createImage      func(display uint32) uintptr
	imageWidth       func(uintptr) uintptr
	imageHeight      func(uintptr) uintptr
	imageBytesPerRow func(uintptr) uintptr
	imageBitsPerPx   func(uintptr) uintptr
	imageProvider    func(uintptr) uintptr
	providerCopyData func(uintptr) uintptr
	dataBytes        func(uintptr) unsafe.Pointer
	dataLength       func(uintptr) int
	release          func(uintptr)
}

var quartzLibs struct{ graphics, services uintptr }

var (
	quartzOnce sync.Once
	quartzErr  error
)

func loadQuartz() error {
	quartzOnce.Do(func() {
		if quartzErr = loadCF(); quartzErr != nil {
			return
		}
		graphics, err := openFramework("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
		if err != nil {
			quartzErr = err
			return
		}
		services, err := openFramework("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
		if err != nil {
			quartzErr = err
			return
		}
		for name, fn := range map[string]any{
			"CGMainDisplayID": &cg.mainDisplay, "CGDisplayPixelsWide": &cg.pixelsWide, "CGDisplayPixelsHigh": &cg.pixelsHigh,
			"CGEventCreateMouseEvent": &cg.mouseEvent, "CGEventCreateKeyboardEvent": &cg.keyboardEvent,
			"CGEventKeyboardSetUnicodeString": &cg.setUnicodeString, "CGEventCreateScrollWheelEvent2": &cg.scrollEvent,
			"CGEventSetFlags": &cg.setFlags, "CGEventSetIntegerValueField": &cg.setIntegerField, "CGEventPost": &cg.post,
			"CGPreflightScreenCaptureAccess": &cg.preflightCapture, "CGRequestScreenCaptureAccess": &cg.requestCapture,
			"CGImageGetWidth": &cg.imageWidth, "CGImageGetHeight": &cg.imageHeight, "CGImageGetBytesPerRow": &cg.imageBytesPerRow, "CGImageGetBitsPerPixel": &cg.imageBitsPerPx,
			"CGImageGetDataProvider": &cg.imageProvider, "CGDataProviderCopyData": &cg.providerCopyData,
		} {
			purego.RegisterLibFunc(fn, graphics, name)
		}
		// Gone from newer SDKs; where the system still has it, stills skip a process.
		if symbolAddress(graphics, "CGDisplayCreateImage") != 0 {
			purego.RegisterLibFunc(&cg.createImage, graphics, "CGDisplayCreateImage")
		}
		purego.RegisterLibFunc(&cg.trusted, services, "AXIsProcessTrusted")
		purego.RegisterLibFunc(&cg.trustedPrompt, services, "AXIsProcessTrustedWithOptions")
		purego.RegisterLibFunc(&cg.dataBytes, cf.lib, "CFDataGetBytePtr")
		purego.RegisterLibFunc(&cg.dataLength, cf.lib, "CFDataGetLength")
		cg.release = cf.release
		quartzLibs.graphics, quartzLibs.services = graphics, services
	})
	return quartzErr
}

func promptAccessibility() bool {
	options := cfDictionary(global(quartzLibs.services, "kAXTrustedCheckOptionPrompt"), cf.yes)
	if options == 0 {
		return cg.trusted()
	}
	defer cf.release(options)
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
	tree    *axTree

	mu       sync.Mutex
	flags    uint64
	button   string
	at       cgPoint
	lastDown time.Time
	lastAt   cgPoint
	clicks   int64
}

func newMacScreen() *macScreen {
	s := &macScreen{display: cg.mainDisplay(), name: hostName()}
	s.tree = &axTree{screen: s}
	return s
}

func (s *macScreen) Tree(ctx context.Context, maxElements int) (Tree, error) {
	return s.tree.Tree(ctx, maxElements)
}

func (s *macScreen) Element(ref, action string, text *string) error {
	return s.tree.Element(ref, action, text)
}

func (s *macScreen) click(x, y float64) error {
	if err := s.Pointer("down", x, y, "primary"); err != nil {
		return err
	}
	return s.Pointer("up", x, y, "primary")
}

func (s *macScreen) replaceText(text string) error {
	err := s.Key(true, "Meta")
	if err == nil {
		err = s.Key(true, "a")
		_ = s.Key(false, "a")
	}
	_ = s.Key(false, "Meta")
	if err != nil {
		return err
	}
	if text == "" {
		if err := s.Key(true, "Delete"); err != nil {
			return err
		}
		return s.Key(false, "Delete")
	}
	return s.Text(text)
}

func (s *macScreen) size() (float64, float64) {
	return float64(cg.pixelsWide(s.display)), float64(cg.pixelsHigh(s.display))
}

func (s *macScreen) Info() (Info, error) {
	width, height := s.size()
	info := Info{
		ID: "screen", Name: s.name, Width: int(width), Height: int(height),
		Capture: cg.preflightCapture(), Input: cg.trusted(), Desktop: true, Tree: cg.trusted(),
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
	if img := s.captureInProcess(); img != nil {
		return img, nil
	}
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

func (s *macScreen) captureInProcess() image.Image {
	if cg.createImage == nil {
		return nil
	}
	ref := cg.createImage(s.display)
	if ref == 0 {
		return nil
	}
	defer cf.release(ref)
	width, height, stride := int(cg.imageWidth(ref)), int(cg.imageHeight(ref)), int(cg.imageBytesPerRow(ref))
	data := cg.providerCopyData(cg.imageProvider(ref))
	if data == 0 {
		return nil
	}
	defer cf.release(data)
	if width <= 0 || height <= 0 || cg.imageBitsPerPx(ref) != 32 || stride < width*4 || cg.dataLength(data) < stride*height {
		return nil
	}
	pixels := unsafe.Slice((*byte)(cg.dataBytes(data)), stride*height)
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := range height {
		row := pixels[y*stride : y*stride+width*4]
		out := img.Pix[y*img.Stride : y*img.Stride+width*4]
		for x := 0; x < width*4; x += 4 {
			out[x], out[x+1], out[x+2], out[x+3] = row[x+2], row[x+1], row[x], 0xff
		}
	}
	return img
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
	at := s.at
	if action != "cancel" {
		at = s.point(x, y)
		s.at = at
	}
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
