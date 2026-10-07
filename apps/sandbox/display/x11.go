//go:build linux && !android

package display

import (
	"context"
	"fmt"
	"image"
	"io"
	"log"
	"os"
	"sync"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
	"github.com/jezek/xgb/xtest"
)

const (
	xKeyPress      = 2
	xKeyRelease    = 3
	xButtonPress   = 4
	xButtonRelease = 5
	xMotionNotify  = 6
)

const x11NotchesPerScreen = 20

type x11Screen struct {
	display string
	name    string
	conn    *xgb.Conn
	root    xproto.Window
	xtest   bool
	lsb32   bool
	atspi   *atspi

	mu       sync.Mutex
	keys     map[uint32]x11Key
	borrowed map[uint32]x11Key
	scratch  []xproto.Keycode
	next     int
	perCode  int
	shift    xproto.Keycode
	pressed  byte
}

type x11Key struct {
	code  xproto.Keycode
	shift bool
}

func init() {
	// xgb logs to stderr, which a managed sandboxd reserves for its supervisor.
	xgb.Logger = log.New(io.Discard, "", 0)
}

func openX11(display, name string) (*x11Screen, error) {
	if display == "" {
		display = os.Getenv("DISPLAY")
	}
	conn, err := xgb.NewConnDisplay(display)
	if err != nil {
		return nil, fmt.Errorf("connect to X display %q: %w", display, err)
	}
	setup := xproto.Setup(conn)
	s := &x11Screen{display: display, name: name, conn: conn, root: setup.DefaultScreen(conn).Root, xtest: xtest.Init(conn) == nil}
	s.atspi = &atspi{screen: s}
	for _, format := range setup.PixmapFormats {
		if format.Depth == setup.DefaultScreen(conn).RootDepth {
			s.lsb32 = format.BitsPerPixel == 32 && setup.ImageByteOrder == xproto.ImageOrderLSBFirst
		}
	}
	if err := s.loadKeymap(setup); err != nil {
		conn.Close()
		return nil, err
	}
	return s, nil
}

func (s *x11Screen) size() (int, int, error) {
	geometry, err := xproto.GetGeometry(s.conn, xproto.Drawable(s.root)).Reply()
	if err != nil {
		return 0, 0, fmt.Errorf("X display %s: %w", s.display, err)
	}
	return int(geometry.Width), int(geometry.Height), nil
}

func (s *x11Screen) Info() (Info, error) {
	width, height, err := s.size()
	if err != nil {
		return Info{}, err
	}
	return Info{
		ID: "screen", Name: s.name, Width: width, Height: height,
		Capture: s.lsb32, Input: s.xtest, Desktop: true, Tree: atspiAvailable(),
	}, nil
}

func (s *x11Screen) Tree(ctx context.Context, maxElements int) (Tree, error) {
	return s.atspi.Tree(ctx, maxElements)
}

func (s *x11Screen) Element(ref, action string, text *string) error {
	return s.atspi.Element(ref, action, text)
}

func (s *x11Screen) Source(fps int) []string {
	width, height, err := s.size()
	if err != nil {
		return nil
	}
	return []string{"-f", "x11grab", "-draw_mouse", "1", "-framerate", fmt.Sprint(fps), "-video_size", fmt.Sprintf("%dx%d", width, height), "-i", s.display}
}

func (s *x11Screen) Capture(context.Context) (image.Image, error) {
	width, height, err := s.size()
	if err != nil {
		return nil, errorf(CodeUnavailable, "%v", err)
	}
	reply, err := xproto.GetImage(s.conn, xproto.ImageFormatZPixmap, xproto.Drawable(s.root), 0, 0, uint16(width), uint16(height), 0xffffffff).Reply()
	if err != nil {
		return nil, errorf(CodeFailed, "capture X display: %v", err)
	}
	if len(reply.Data) < width*height*4 {
		return nil, errorf(CodeFailed, "X display returned a short image")
	}
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for i := 0; i < width*height; i++ {
		img.Pix[i*4], img.Pix[i*4+1], img.Pix[i*4+2], img.Pix[i*4+3] = reply.Data[i*4+2], reply.Data[i*4+1], reply.Data[i*4], 0xff
	}
	return img, nil
}

func (s *x11Screen) fake(kind, detail byte, x, y int16) error {
	if err := xtest.FakeInputChecked(s.conn, kind, detail, 0, s.root, x, y, 0).Check(); err != nil {
		return errorf(CodeFailed, "X input: %v", err)
	}
	return nil
}

func (s *x11Screen) point(x, y float64) (int16, int16, error) {
	width, height, err := s.size()
	if err != nil {
		return 0, 0, errorf(CodeUnavailable, "%v", err)
	}
	return int16(x * float64(max(0, width-1))), int16(y * float64(max(0, height-1))), nil
}

func x11Button(button string) byte {
	switch button {
	case "secondary":
		return 3
	case "middle":
		return 2
	default:
		return 1
	}
}

func (s *x11Screen) Pointer(action string, x, y float64, button string) error {
	if action != "cancel" {
		px, py, err := s.point(x, y)
		if err != nil {
			return err
		}
		if err := s.fake(xMotionNotify, 0, px, py); err != nil {
			return err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch action {
	case "down":
		s.pressed = x11Button(button)
		return s.fake(xButtonPress, s.pressed, 0, 0)
	case "up", "cancel":
		if s.pressed == 0 {
			return nil
		}
		pressed := s.pressed
		s.pressed = 0
		return s.fake(xButtonRelease, pressed, 0, 0)
	}
	return nil
}

func (s *x11Screen) Scroll(x, y, dx, dy float64) error {
	px, py, err := s.point(x, y)
	if err != nil {
		return err
	}
	if err := s.fake(xMotionNotify, 0, px, py); err != nil {
		return err
	}
	for _, axis := range []struct {
		amount             float64
		negative, positive byte
	}{{dy, 4, 5}, {dx, 6, 7}} {
		button := axis.positive
		if axis.amount < 0 {
			button = axis.negative
		}
		for range notches(axis.amount, x11NotchesPerScreen) {
			if err := s.fake(xButtonPress, button, 0, 0); err != nil {
				return err
			}
			if err := s.fake(xButtonRelease, button, 0, 0); err != nil {
				return err
			}
		}
	}
	return nil
}

func notches(amount float64, perScreen int) int {
	if amount == 0 {
		return 0
	}
	if amount < 0 {
		amount = -amount
	}
	return max(1, int(amount*float64(perScreen)+0.5))
}

func (s *x11Screen) Key(down bool, key string) error {
	keysym, ok := x11Keysym(key)
	if !ok {
		return errorf(CodeUnsupported, "key %q is not supported", key)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.press(keysym, down)
}

func (s *x11Screen) Text(text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range text {
		keysym := runeKeysym(r)
		if r == '\n' {
			keysym = namedKeys["Enter"].x11
		}
		if err := s.press(keysym, true); err != nil {
			return err
		}
		if err := s.press(keysym, false); err != nil {
			return err
		}
	}
	return nil
}

func (s *x11Screen) replaceText(text string) error {
	s.mu.Lock()
	err := s.press(namedKeys["Control"].x11, true)
	if err == nil {
		err = s.press(runeKeysym('a'), true)
		_ = s.press(runeKeysym('a'), false)
	}
	_ = s.press(namedKeys["Control"].x11, false)
	if err == nil && text == "" {
		err = s.press(namedKeys["Delete"].x11, true)
		_ = s.press(namedKeys["Delete"].x11, false)
	}
	s.mu.Unlock()
	if err != nil || text == "" {
		return err
	}
	return s.Text(text)
}

func (s *x11Screen) press(keysym uint32, down bool) error {
	key, ok := s.keys[keysym]
	if !ok {
		key, ok = s.borrowed[keysym]
	}
	if !ok {
		var err error
		if key, err = s.borrow(keysym); err != nil {
			return err
		}
	}
	if !down {
		return s.fake(xKeyRelease, byte(key.code), 0, 0)
	}
	if key.shift {
		if err := s.fake(xKeyPress, byte(s.shift), 0, 0); err != nil {
			return err
		}
	}
	if err := s.fake(xKeyPress, byte(key.code), 0, 0); err != nil {
		return err
	}
	if key.shift {
		return s.fake(xKeyRelease, byte(s.shift), 0, 0)
	}
	return nil
}

func (s *x11Screen) loadKeymap(setup *xproto.SetupInfo) error {
	count := int(setup.MaxKeycode) - int(setup.MinKeycode) + 1
	reply, err := xproto.GetKeyboardMapping(s.conn, setup.MinKeycode, byte(count)).Reply()
	if err != nil {
		return fmt.Errorf("read X keyboard mapping: %w", err)
	}
	s.perCode = int(reply.KeysymsPerKeycode)
	s.keys, s.borrowed = map[uint32]x11Key{}, map[uint32]x11Key{}
	for i := 0; i < count; i++ {
		code := xproto.Keycode(int(setup.MinKeycode) + i)
		syms := reply.Keysyms[i*s.perCode : (i+1)*s.perCode]
		empty := true
		for level, sym := range syms {
			if sym != 0 {
				empty = false
			}
			if level > 1 || sym == 0 {
				continue
			}
			if _, seen := s.keys[uint32(sym)]; !seen {
				s.keys[uint32(sym)] = x11Key{code: code, shift: level == 1}
			}
		}
		if empty {
			s.scratch = append(s.scratch, code)
		}
	}
	shift, ok := s.keys[namedKeys["Shift"].x11]
	if !ok {
		return fmt.Errorf("X keyboard has no Shift key")
	}
	s.shift = shift.code
	return nil
}

// borrow maps keysym onto the next spare keycode. Spare codes rotate, so a
// client still reading the previous mapping is not caught out by the next.
func (s *x11Screen) borrow(keysym uint32) (x11Key, error) {
	if len(s.scratch) == 0 {
		return x11Key{}, errorf(CodeUnsupported, "the X keyboard has no spare key to type %U", rune(keysym&0xffffff))
	}
	code := s.scratch[s.next%len(s.scratch)]
	s.next++
	for previous, key := range s.borrowed {
		if key.code == code {
			delete(s.borrowed, previous)
		}
	}
	syms := make([]xproto.Keysym, s.perCode)
	syms[0], syms[1%s.perCode] = xproto.Keysym(keysym), xproto.Keysym(keysym)
	if err := xproto.ChangeKeyboardMappingChecked(s.conn, 1, code, byte(s.perCode), syms).Check(); err != nil {
		return x11Key{}, errorf(CodeFailed, "map X key: %v", err)
	}
	s.borrowed[keysym] = x11Key{code: code}
	return s.borrowed[keysym], nil
}

func (s *x11Screen) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pressed != 0 {
		_ = s.fake(xButtonRelease, s.pressed, 0, 0)
	}
	s.conn.Close()
	s.atspi.Close()
	return nil
}
