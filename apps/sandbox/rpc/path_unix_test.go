//go:build !windows

package rpc

import "testing"

func TestPathWithinFilesystemRoot(t *testing.T) {
	for _, c := range []struct {
		root, path string
		want       bool
	}{
		{"/", "/ws/a.txt", true},
		{"/ws", "/ws/a.txt", true},
		{"/ws", "/ws", true},
		{"/ws", "/wsx/a.txt", false},
	} {
		if got := pathWithin(c.root, c.path); got != c.want {
			t.Fatalf("pathWithin(%q, %q) = %v, want %v", c.root, c.path, got, c.want)
		}
	}
}
