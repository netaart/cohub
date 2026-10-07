package display

import (
	"bytes"
	"cmp"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"maps"
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

type ElementScreen interface {
	Screen
	Tree(ctx context.Context, maxElements int) (Tree, error)
	Element(ref, action string, text *string) error
}

type nativeVideoScreen interface {
	nativeEncoder() *videoEncoder
}

const screenPollInterval = 2 * time.Second

func ServeScreen(ctx context.Context, conn io.ReadWriteCloser, name string, screen Screen, logger *slog.Logger) {
	defer conn.Close()
	defer screen.Close()
	provider, err := NewProviderConn(conn, name)
	if err != nil {
		return
	}
	d := &desktop{provider: provider, screen: screen, ffmpeg: findFFmpeg(), logger: logger, streams: map[uint32]*desktopStream{}, keys: map[string]bool{}}
	defer d.releaseAll()
	defer d.stopAll()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	d.ctx = ctx
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	if !d.publish() {
		return
	}
	go d.watch(ctx, cancel)
	_ = provider.Serve(ctx, d.handle)
}

type desktop struct {
	ctx      context.Context // the connection's; a call's ends with its answer
	provider *ProviderConn
	screen   Screen
	ffmpeg   *ffmpeg
	logger   *slog.Logger

	inputMu sync.Mutex
	keys    map[string]bool // held down, guarded by inputMu
	button  string

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
	info.Stream = len(d.encoders()) > 0
	if _, ok := d.screen.(ElementScreen); !ok {
		info.Tree = false
	}
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

func (d *desktop) encoders() []*videoEncoder {
	var encoders []*videoEncoder
	if native, ok := d.screen.(nativeVideoScreen); ok {
		if encoder := native.nativeEncoder(); encoder != nil {
			encoders = append(encoders, encoder)
		}
	}
	if d.ffmpeg != nil && d.screen.Source(DefaultFPS) != nil {
		encoders = append(encoders, d.ffmpeg.encoder(d.screen.Source))
	}
	return encoders
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
			return nil, errorf(CodeUnavailable, "live video needs ffmpeg with an H.264 encoder")
		}
		d.startStream(params)
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
		if stream != nil && params.FPS > 0 {
			stream.encoder.setFPS(max(1, min(MaxFPS, params.FPS)))
		}
		return nil, nil
	case "stream.keyframe":
		var params StreamControl
		_ = json.Unmarshal(raw, &params)
		d.mu.Lock()
		stream := d.streams[params.Stream]
		d.mu.Unlock()
		if stream != nil {
			stream.encoder.requestKeyframe()
		}
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
	case "tree":
		screen, ok := d.screen.(ElementScreen)
		if !ok {
			return nil, errorf(CodeUnsupported, "this display has no element tree")
		}
		var params TreeParams
		if err := json.Unmarshal(raw, &params); err != nil || params.normalize() != nil {
			return nil, errorf(CodeInvalid, "invalid tree params")
		}
		return screen.Tree(ctx, params.MaxElements)
	case "input":
		var batch InputBatch
		if err := json.Unmarshal(raw, &batch); err != nil {
			return nil, errorf(CodeInvalid, "invalid input")
		}
		if !info.Input {
			return nil, errorf(CodeUnavailable, "input is not permitted")
		}
		return nil, d.input(ctx, batch)
	default:
		return nil, errorf(CodeUnsupported, "unsupported method %q", method)
	}
}

func (d *desktop) startStream(params StreamStart) {
	ctx, cancel := context.WithCancel(d.ctx)
	maxSize := params.MaxSize
	if maxSize <= 0 {
		maxSize = DefaultMaxSize
	}
	encoder := &encoderStream{
		encoders: d.encoders(),
		maxSize:  maxSize,
		fps:      max(1, min(MaxFPS, params.FPS)),
		bitrate:  max(MinBitrate, min(MaxBitrate, params.Bitrate)),
		deliver:  func(sample Sample) error { return d.provider.WriteSample(params.Stream, sample) },
		logger:   d.logger,
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

func (d *desktop) input(ctx context.Context, batch InputBatch) error {
	d.inputMu.Lock()
	defer d.inputMu.Unlock()
	if batch.StartBy > 0 && time.Now().UnixMilli() > batch.StartBy {
		return errorf(CodeTimeout, "the input waited too long to start")
	}
	started := time.Now()
	pressed := map[string]bool{}
	pointer := false
	for _, event := range batch.Events {
		if event.T != nil {
			if wait := time.Until(started.Add(time.Duration(*event.T) * time.Millisecond)); wait > 0 {
				select {
				case <-ctx.Done():
				case <-time.After(wait):
				}
			}
		}
		err := ctx.Err()
		if err == nil {
			err = d.apply(event)
		}
		if err != nil {
			d.release(pressed, pointer)
			return err
		}
		switch {
		case event.Type == "key" && event.Action == "down":
			pressed[event.Key] = true
		case event.Type == "pointer" && event.Action == "down":
			pointer = true
		}
	}
	return nil
}

func (d *desktop) release(keys map[string]bool, pointer bool) {
	if pointer && d.button != "" {
		_ = d.apply(InputEvent{Type: "pointer", Action: "cancel", X: new(float64), Y: new(float64)})
	}
	for key := range keys {
		if d.keys[key] {
			_ = d.apply(InputEvent{Type: "key", Action: "up", Key: key})
		}
	}
}

func (d *desktop) releaseAll() {
	d.inputMu.Lock()
	defer d.inputMu.Unlock()
	d.release(maps.Clone(d.keys), true)
}

func (d *desktop) apply(event InputEvent) error {
	switch event.Type {
	case "pointer":
		if err := d.screen.Pointer(event.Action, *event.X, *event.Y, event.Button); err != nil {
			return err
		}
		switch event.Action {
		case "down":
			d.button = cmp.Or(event.Button, "primary")
		case "up", "cancel":
			d.button = ""
		}
		return nil
	case "scroll":
		return d.screen.Scroll(*event.X, *event.Y, event.DX, event.DY)
	case "key":
		if event.Action != "up" {
			if err := d.screen.Key(true, event.Key); err != nil {
				return err
			}
			d.keys[event.Key] = true
		}
		if event.Action != "down" {
			delete(d.keys, event.Key)
			return d.screen.Key(false, event.Key)
		}
		return nil
	case "text":
		return d.screen.Text(*event.Text)
	case "element":
		screen, ok := d.screen.(ElementScreen)
		if !ok {
			return errorf(CodeUnsupported, "this display has no element tree")
		}
		return screen.Element(event.Ref, event.Action, event.Text)
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
