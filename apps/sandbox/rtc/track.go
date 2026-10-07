package rtc

import (
	"math/rand/v2"
	"sync"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

const (
	playoutDelayURI = "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay"

	videoClockRate = 90_000
	outboundMTU    = 1200
	maxClockSkew   = time.Second
)

var playoutNow, _ = rtp.PlayoutDelayExtension{}.Marshal()

// videoTrack stamps frames with capture time, asks for zero playout delay and
// starts on a key frame.
type videoTrack struct {
	*webrtc.TrackLocalStaticRTP

	bound     chan struct{}
	bindOnce  sync.Once
	mu        sync.Mutex
	keyed     bool
	playout   uint8
	payloader codecs.H264Payloader
	sequence  rtp.Sequencer
	clock     mediaClock
}

func newVideoTrack() (*videoTrack, error) {
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: videoClockRate}, "display", "cohub")
	if err != nil {
		return nil, err
	}
	return &videoTrack{TrackLocalStaticRTP: track, bound: make(chan struct{}), sequence: rtp.NewRandomSequencer()}, nil
}

func (t *videoTrack) Bind(ctx webrtc.TrackLocalContext) (webrtc.RTPCodecParameters, error) {
	codec, err := t.TrackLocalStaticRTP.Bind(ctx)
	if err != nil {
		return codec, err
	}
	t.mu.Lock()
	for _, extension := range ctx.HeaderExtensions() {
		if extension.URI == playoutDelayURI {
			t.playout = uint8(extension.ID)
		}
	}
	t.mu.Unlock()
	t.bindOnce.Do(func() { close(t.bound) })
	return codec, nil
}

func (t *videoTrack) Bound() <-chan struct{} { return t.bound }

func (t *videoTrack) WriteFrame(data []byte, pts uint64, key bool) error {
	select {
	case <-t.bound:
	default:
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.keyed = t.keyed || key
	if !t.keyed {
		return nil
	}
	timestamp := t.clock.timestamp(pts, time.Now())
	payloads := t.payloader.Payload(outboundMTU, data)
	for i, payload := range payloads {
		packet := rtp.Packet{
			Header: rtp.Header{
				Version: 2, Marker: i == len(payloads)-1,
				SequenceNumber: t.sequence.NextSequenceNumber(), Timestamp: timestamp,
			},
			Payload: payload,
		}
		if i == 0 && t.playout != 0 {
			_ = packet.Header.SetExtension(t.playout, playoutNow)
		}
		if err := t.WriteRTP(&packet); err != nil {
			return err
		}
	}
	return nil
}

// mediaClock follows capture time and bridges jumps with the wall clock.
type mediaClock struct {
	started   bool
	base      uint32
	basePTS   uint64
	lastPTS   uint64
	lastAt    time.Time
	lastStamp uint32
}

func (c *mediaClock) timestamp(pts uint64, now time.Time) uint32 {
	switch {
	case !c.started:
		c.started, c.base, c.basePTS = true, rand.Uint32(), pts
	case pts < c.lastPTS || absDuration(time.Duration(pts-c.lastPTS)*time.Microsecond-now.Sub(c.lastAt)) > maxClockSkew:
		c.base, c.basePTS = c.lastStamp+ticks(max(0, now.Sub(c.lastAt))), pts
	}
	c.lastPTS, c.lastAt = pts, now
	c.lastStamp = c.base + ticks(time.Duration(pts-c.basePTS)*time.Microsecond)
	return c.lastStamp
}

func ticks(d time.Duration) uint32 {
	return uint32(d * videoClockRate / time.Second)
}

func absDuration(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}
