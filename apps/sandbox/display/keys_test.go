package display

import "testing"

func TestMacKey(t *testing.T) {
	for r, want := range map[rune]bool{'/': false, '?': true, 'A': true} {
		if _, shift, ok := macKey(r); !ok || shift != want {
			t.Errorf("macKey(%q) shift = %v, %v", r, shift, ok)
		}
	}
	if _, _, ok := macKey('é'); ok {
		t.Error("macKey('é') should not map")
	}
}
