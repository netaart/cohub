//go:build !darwin

package display

import (
	"fmt"
	"os"
)

func RunEncoder([]string) int {
	fmt.Fprintln(os.Stderr, "this platform has no native display encoder")
	return 2
}
