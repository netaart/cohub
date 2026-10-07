package display

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/image/draw"
)

type Screen interface {
	Info() (Info, error)
	Source(fps int) []string
	Capture(ctx context.Context) (image.Image, error)
	Pointer(action string, x, y float64, button string) error
	Scroll(x, y, dx, dy float64) error
	Key(down bool, key string) error
	Text(text string) error
	Close() error
}

const screenPollInterval = 2 * time.Second

func ServeScreen(ctx context.Context, conn io.ReadWriteCloser, name string, screen Screen, logger *slog.Logger) {
	defer conn.Close()
	defer screen.Close()
	provider, err := NewProviderConn(conn, name)
	if err != nil {
		return
	}
	d := &desktop{provider: provider, screen: screen, ffmpeg: findFFmpeg(), logger: logger, streams: map[uint32]*desktopStream{}}
	defer d.stopAll()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	if !d.publish() {
		return
	}
	go d.watch(ctx, cancel)
	_ = provider.Serve(ctx, d.handle)
}

type desktop struct {
	provider *ProviderConn
	screen   Screen
	ffmpeg   *ffmpeg
	logger   *slog.Logger
	inputMu  sync.Mutex

	mu      sync.Mutex
	info    Info
	streams map[uint32]*desktopStream
}

type desktopStream struct {
	cancel  context.CancelFunc
	encoder *encoderStream
}

func (d *desktop) publish() bool {
	info, err := d.screen.Info()
	if err != nil {
		d.logger.Warn("display lost", slog.String("error", err.Error()))
		return false
	}
	info.Stream = d.ffmpeg != nil && d.screen.Source(DefaultFPS) != nil
	d.mu.Lock()
	changed := !info.equal(d.info)
	resized := d.info.Width != info.Width || d.info.Height != info.Height
	d.info = info
	streams := make([]*desktopStream, 0, len(d.streams))
	for _, stream := range d.streams {
		streams = append(streams, stream)
	}
	d.mu.Unlock()
	if !changed {
		return true
	}
	if resized {
		for _, stream := range streams {
			stream.encoder.reset()
		}
	}
	return d.provider.SetDisplays([]Info{info}) == nil
}

func (d *desktop) watch(ctx context.Context, cancel context.CancelFunc) {
	ticker := time.NewTicker(screenPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !d.publish() {
				cancel()
				return
			}
		}
	}
}

func (d *desktop) handle(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	d.mu.Lock()
	info := d.info
	d.mu.Unlock()
	switch method {
	case "stream.start":
		var params StreamStart
		if err := json.Unmarshal(raw, &params); err != nil || params.Display != info.ID {
			return nil, errorf(CodeNotFound, "unknown display")
		}
		if !info.Stream {
			return nil, errorf(CodeUnavailable, "streaming needs ffmpeg with an H.264 encoder")
		}
		d.startStream(ctx, params)
		return nil, nil
	case "stream.stop":
		var params StreamControl
		_ = json.Unmarshal(raw, &params)
		d.stopStream(params.Stream)
		return nil, nil
	case "stream.update":
		var params StreamControl
		_ = json.Unmarshal(raw, &params)
		d.mu.Lock()
		stream := d.streams[params.Stream]
		d.mu.Unlock()
		if stream != nil && params.Bitrate > 0 {
			stream.encoder.setBitrate(params.Bitrate)
		}
		return nil, nil
	case "stream.keyframe":
		// A one second GOP bounds recovery; restarting ffmpeg would take longer.
		return nil, nil
	case "capture":
		var params CaptureParams
		if err := json.Unmarshal(raw, &params); err != nil || params.normalize() != nil {
			return nil, errorf(CodeInvalid, "invalid capture params")
		}
		if !info.Capture {
			return nil, errorf(CodeUnavailable, "screen capture is not permitted")
		}
		img, err := d.screen.Capture(ctx)
		if err != nil {
			return nil, err
		}
		return encodeImage(img, params)
	case "input":
		var batch InputBatch
		if err := json.Unmarshal(raw, &batch); err != nil {
			return nil, errorf(CodeInvalid, "invalid input")
		}
		if !info.Input {
			return nil, errorf(CodeUnavailable, "input is not permitted")
		}
		return nil, d.input(ctx, batch.Events)
	default:
		return nil, errorf(CodeUnsupported, "unsupported method %q", method)
	}
}

func (d *desktop) startStream(parent context.Context, params StreamStart) {
	ctx, cancel := context.WithCancel(parent)
	fps := max(1, min(60, params.FPS))
	maxSize := params.MaxSize
	if maxSize <= 0 {
		maxSize = DefaultMaxSize
	}
	encoder := &encoderStream{
		ffmpeg:  d.ffmpeg,
		source:  func() []string { return d.screen.Source(fps) },
		fps:     fps,
		maxSize: maxSize,
		bitrate: max(MinBitrate, min(MaxBitrate, params.Bitrate)),
		deliver: func(sample Sample) error { return d.provider.WriteSample(params.Stream, sample) },
	}
	d.mu.Lock()
	if previous := d.streams[params.Stream]; previous != nil {
		previous.cancel()
	}
	d.streams[params.Stream] = &desktopStream{cancel: cancel, encoder: encoder}
	d.mu.Unlock()
	encoder.start(ctx, func(err error) {
		d.mu.Lock()
		owned := d.streams[params.Stream] != nil && d.streams[params.Stream].encoder == encoder
		if owned {
			delete(d.streams, params.Stream)
		}
		d.mu.Unlock()
		if !owned {
			return
		}
		var reason *Error
		if err != nil {
			d.logger.Warn("display encoder stopped", slog.String("error", err.Error()))
			reason = errorf(CodeFailed, "%v", err)
		}
		_ = d.provider.EndStream(params.Stream, reason)
	})
}

func (d *desktop) stopStream(id uint32) {
	d.mu.Lock()
	stream := d.streams[id]
	delete(d.streams, id)
	d.mu.Unlock()
	if stream != nil {
		stream.encoder.stop()
		stream.cancel()
	}
}

func (d *desktop) stopAll() {
	d.mu.Lock()
	ids := make([]uint32, 0, len(d.streams))
	for id := range d.streams {
		ids = append(ids, id)
	}
	d.mu.Unlock()
	for _, id := range ids {
		d.stopStream(id)
	}
}

func (d *desktop) input(ctx context.Context, events []InputEvent) error {
	d.inputMu.Lock()
	defer d.inputMu.Unlock()
	started := time.Now()
	for _, event := range events {
		if event.T != nil {
			if wait := time.Until(started.Add(time.Duration(*event.T) * time.Millisecond)); wait > 0 {
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(wait):
				}
			}
		}
		if err := d.apply(event); err != nil {
			return err
		}
	}
	return nil
}

func (d *desktop) apply(event InputEvent) error {
	switch event.Type {
	case "pointer":
		return d.screen.Pointer(event.Action, *event.X, *event.Y, event.Button)
	case "scroll":
		return d.screen.Scroll(*event.X, *event.Y, event.DX, event.DY)
	case "key":
		if event.Action != "up" {
			if err := d.screen.Key(true, event.Key); err != nil {
				return err
			}
		}
		if event.Action != "down" {
			return d.screen.Key(false, event.Key)
		}
		return nil
	case "text":
		return d.screen.Text(event.Text)
	case "system":
		return errorf(CodeUnsupported, "this display has no %s button", event.Action)
	default:
		return errorf(CodeInvalid, "unknown event type %q", event.Type)
	}
}

func encodeImage(img image.Image, params CaptureParams) (CaptureResult, error) {
	bounds := img.Bounds()
	width, height := fitSize(bounds.Dx(), bounds.Dy(), params.MaxSize)
	if width != bounds.Dx() || height != bounds.Dy() {
		scaled := image.NewRGBA(image.Rect(0, 0, width, height))
		draw.ApproxBiLinear.Scale(scaled, scaled.Bounds(), img, bounds, draw.Src, nil)
		img = scaled
	}
	var out bytes.Buffer
	mime := "image/jpeg"
	var err error
	if params.Format == "png" {
		mime = "image/png"
		err = (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&out, img)
	} else {
		err = jpeg.Encode(&out, img, &jpeg.Options{Quality: params.Quality})
	}
	if err != nil {
		return CaptureResult{}, errorf(CodeFailed, "encode image: %v", err)
	}
	return CaptureResult{MimeType: mime, Data: base64.StdEncoding.EncodeToString(out.Bytes()), Width: width, Height: height}, nil
}

func hostName() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		return "Screen"
	}
	host, _, _ = strings.Cut(host, ".")
	return host
}

func fitSize(width, height, limit int) (int, int) {
	if limit <= 0 || (width <= limit && height <= limit) {
		return width, height
	}
	if width >= height {
		return limit &^ 1, max(2, height*limit/width) &^ 1
	}
	return max(2, width*limit/height) &^ 1, limit &^ 1
}
