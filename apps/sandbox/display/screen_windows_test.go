//go:build windows

package display

import (
	"runtime"
	"testing"
	"unsafe"
)

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
}

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
