package protocol

import (
	"math"
	"time"
)

// FileTimeMs matches Math.trunc(fs.Stats.mtimeMs) in Node, which computes it in float64.
func FileTimeMs(t time.Time) int64 {
	return TimespecMs(t.Unix(), int64(t.Nanosecond()))
}

func TimespecMs(sec, nsec int64) int64 {
	return int64(math.Trunc(float64(sec)*1e3 + float64(nsec)/1e6))
}
