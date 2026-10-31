//go:build !darwin && !windows

package power

func platformAssert() (func(), error) {
	return func() {}, nil
}
