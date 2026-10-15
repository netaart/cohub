//go:build windows

package display

import (
	"errors"
	"reflect"
	"runtime"
	"testing"
	"unsafe"
)

type windowsProcFunc func(...uintptr) (uintptr, uintptr, error)

func (f windowsProcFunc) Call(args ...uintptr) (uintptr, uintptr, error) { return f(args...) }

func mockWindowsKeyboard(t *testing.T, send func([]keyboardInput) error) {
	t.Helper()
	previousSend, previousMap, previousScan := sendInput, procMapVirtualKeyW, procVkKeyScanW
	t.Cleanup(func() { sendInput, procMapVirtualKeyW, procVkKeyScanW = previousSend, previousMap, previousScan })
	procMapVirtualKeyW = windowsProcFunc(func(args ...uintptr) (uintptr, uintptr, error) { return args[0], 0, nil })
	procVkKeyScanW = windowsProcFunc(func(args ...uintptr) (uintptr, uintptr, error) {
		if args[0] == 'c' {
			return 0x43, 0, nil
		}
		return 0xffff, 0, nil
	})
	sendInput = func(events ...input) error {
		keys := make([]keyboardInput, len(events))
		for i := range events {
			keys[i] = *(*keyboardInput)(unsafe.Pointer(&events[i].Mouse))
		}
		return send(keys)
	}
}

func TestWindowsKeyReleaseKeepsOriginalEncoding(t *testing.T) {
	for _, c := range []struct {
		name, key string
		shortcut  bool
		want      []keyboardInput
	}{
		{"modifier released first", "c", true, []keyboardInput{{VK: 0x43, Scan: 0x43}}},
		{"modifier pressed later", "c", false, []keyboardInput{{Scan: 'c', Flags: keyUnicode}}},
		{"surrogate pair", "😀", false, []keyboardInput{{Scan: 0xd83d, Flags: keyUnicode}, {Scan: 0xde00, Flags: keyUnicode}}},
	} {
		t.Run(c.name, func(t *testing.T) {
			var sent [][]keyboardInput
			mockWindowsKeyboard(t, func(keys []keyboardInput) error { sent = append(sent, keys); return nil })
			s := &windowsScreen{}
			if c.shortcut {
				if err := s.Key(true, "Control"); err != nil {
					t.Fatal(err)
				}
			}
			if err := s.Key(true, c.key); err != nil {
				t.Fatal(err)
			}
			if got := sent[len(sent)-1]; !reflect.DeepEqual(got, c.want) {
				t.Fatalf("keydown = %+v, want %+v", got, c.want)
			}
			if err := s.Key(!c.shortcut, "Control"); err != nil {
				t.Fatal(err)
			}
			if err := s.Key(false, c.key); err != nil {
				t.Fatal(err)
			}
			want := append([]keyboardInput(nil), c.want...)
			for i := range want {
				want[i].Flags |= keyUp
			}
			if got := sent[len(sent)-1]; !reflect.DeepEqual(got, want) {
				t.Fatalf("keyup = %+v, want %+v", got, want)
			}
		})
	}
}

func TestWindowsKeyReleaseRetainsEncodingAfterFailure(t *testing.T) {
	for name, release := range map[string]func(*windowsScreen) error{
		"retry": func(s *windowsScreen) error { return s.Key(false, "c") },
		"close": (*windowsScreen).Close,
	} {
		t.Run(name, func(t *testing.T) {
			var sent []keyboardInput
			fail := false
			mockWindowsKeyboard(t, func(keys []keyboardInput) error {
				if fail {
					return errors.New("input rejected")
				}
				sent = keys
				return nil
			})
			s := &windowsScreen{}
			for _, key := range []string{"Control", "c"} {
				if err := s.Key(true, key); err != nil {
					t.Fatal(err)
				}
			}
			fail = true
			if err := s.Key(false, "c"); err == nil {
				t.Fatal("expected keyup failure")
			}
			fail = false
			if err := s.Key(false, "Control"); err != nil {
				t.Fatal(err)
			}
			if err := release(s); err != nil {
				t.Fatal(err)
			}
			if want := []keyboardInput{{VK: 0x43, Scan: 0x43, Flags: keyUp}}; !reflect.DeepEqual(sent, want) {
				t.Fatalf("retried keyup = %+v, want %+v", sent, want)
			}
		})
	}
}

func TestWindowsRejectedModifierDoesNotChangeEncoding(t *testing.T) {
	var sent []keyboardInput
	fail := true
	mockWindowsKeyboard(t, func(keys []keyboardInput) error {
		if fail {
			return errors.New("input rejected")
		}
		sent = keys
		return nil
	})
	s := &windowsScreen{}
	if err := s.Key(true, "Control"); err == nil {
		t.Fatal("expected modifier failure")
	}
	fail = false
	if err := s.Key(true, "c"); err != nil {
		t.Fatal(err)
	}
	if want := []keyboardInput{{Scan: 'c', Flags: keyUnicode}}; !reflect.DeepEqual(sent, want) {
		t.Fatalf("keydown = %+v, want %+v", sent, want)
	}
}

func TestWindowsInputLayout(t *testing.T) {
	// SendInput rejects a cbSize that differs from the native INPUT.
	want := map[string]uintptr{"amd64": 40, "arm64": 40, "386": 28}[runtime.GOARCH]
	if got := unsafe.Sizeof(input{}); got != want {
		t.Fatalf("sizeof(INPUT) = %d, want %d", got, want)
	}
	if unsafe.Sizeof(keyboardInput{}) > unsafe.Sizeof(mouseInput{}) {
		t.Fatal("KEYBDINPUT must fit the union sized by MOUSEINPUT")
	}
	event := keyEvent(0x41, 0x1e, keyUp|keyExtended)
	key := (*keyboardInput)(unsafe.Pointer(&event.Mouse))
	if event.Type != inputKeyboard || key.VK != 0x41 || key.Scan != 0x1e || key.Flags != keyUp|keyExtended {
		t.Fatalf("keyboard event = %+v %+v", event, *key)
	}
	key.ExtraInfo = ^uintptr(0)
	copied := copyWindowsInput(event)
	if got := *(*keyboardInput)(unsafe.Pointer(&copied.Mouse)); got != *key {
		t.Fatalf("copied keyboard event = %+v, want %+v", got, *key)
	}
}

//go:noinline
func copyWindowsInput(event input) input { return event }

func TestWindowsWheelAmount(t *testing.T) {
	for _, c := range []struct {
		amount float64
		want   int32
	}{{0.01, wheelDelta}, {-0.5, -10 * wheelDelta}, {1, notchesPerScreen * wheelDelta}} {
		if got := wheelAmount(c.amount); got != c.want {
			t.Fatalf("wheelAmount(%v) = %d, want %d", c.amount, got, c.want)
		}
	}
}
