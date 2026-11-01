package display

import (
	"context"
	"image"
	"time"

	"golang.org/x/image/draw"
)

const (
	changePollInterval = 300 * time.Millisecond
	changeLookShare    = 5
	thumbWidth         = 96
	thumbLevels        = 24    // a pixel changed when its grey moves this far
	thumbChanged       = 0.004 // the share of pixels that makes a change
)

func thumbnail(img image.Image) *image.Gray {
	bounds := img.Bounds()
	height := max(1, bounds.Dy()*thumbWidth/max(1, bounds.Dx()))
	thumb := image.NewGray(image.Rect(0, 0, thumbWidth, height))
	draw.ApproxBiLinear.Scale(thumb, thumb.Bounds(), img, bounds, draw.Src, nil)
	return thumb
}

func differs(a, b *image.Gray) bool {
	if a == nil || b == nil || a.Rect != b.Rect {
		return true
	}
	changed := 0
	for i := range a.Pix {
		delta := int(a.Pix[i]) - int(b.Pix[i])
		if delta > thumbLevels || delta < -thumbLevels {
			changed++
		}
	}
	return float64(changed) > float64(len(a.Pix))*thumbChanged
}

func (d *desktop) watchChanges(ctx context.Context, display string, last *image.Gray) {
	for {
		started := time.Now()
		if img, err := d.screen.Capture(ctx); err == nil {
			if thumb := thumbnail(img); last == nil {
				last = thumb
			} else if differs(last, thumb) {
				if d.provider.Changed(display) != nil {
					return
				}
				last = thumb
			}
		}
		timer := time.NewTimer(max(changePollInterval, time.Since(started)*changeLookShare))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
