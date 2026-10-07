package display

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"slices"
	"sync"
	"sync/atomic"
	"time"
)

type Dialer func(ctx context.Context) (io.ReadWriteCloser, error)

const (
	handshakeTimeout = 5 * time.Second
	callTimeout      = 10 * time.Second
	startTimeout     = 10 * time.Second
	streamLinger     = 2 * time.Second
	keyframeDebounce = 250 * time.Millisecond
	bitrateInterval  = 500 * time.Millisecond
	subscriberBuffer = 64

	DefaultBitrate = 2_000_000
	MinBitrate     = 150_000
	MaxBitrate     = 8_000_000
	DefaultFPS     = 30
	DefaultMaxSize = 1920
)

var reconnectDelays = []time.Duration{250 * time.Millisecond, time.Second, 2 * time.Second, 5 * time.Second}

var ErrStreamEnded = errors.New("display stream ended")

type Hub struct {
	dial   Dialer
	logger *slog.Logger

	mu         sync.Mutex
	conn       *providerConn
	displays   []Info
	streams    map[string]*stream
	byID       map[uint32]*stream
	nextStream uint32
	listeners  map[int]func([]Info)
	nextListen int
}

func NewHub(dial Dialer, logger *slog.Logger) *Hub {
	return &Hub{
		dial:      dial,
		logger:    logger.With(slog.String("component", "display")),
		streams:   map[string]*stream{},
		byID:      map[uint32]*stream{},
		listeners: map[int]func([]Info){},
	}
}

func (h *Hub) Run(ctx context.Context) {
	if h.dial == nil {
		return
	}
	attempt := 0
	for ctx.Err() == nil {
		started := time.Now()
		err := h.connect(ctx)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > time.Minute {
			attempt = 0
		}
		if err != nil && attempt == 0 {
			h.logger.Debug("display provider unavailable", slog.String("error", err.Error()))
		}
		delay := reconnectDelays[min(attempt, len(reconnectDelays)-1)]
		delay = delay/2 + time.Duration(rand.Int63n(int64(delay/2)+1))
		attempt++
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
	}
}

func (h *Hub) Displays() []Info {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]Info{}, h.displays...)
}

func (h *Hub) Display(id string) (Info, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.displayLocked(id)
}

func (h *Hub) displayLocked(id string) (Info, bool) {
	for _, info := range h.displays {
		if info.ID == id {
			return info, true
		}
	}
	return Info{}, false
}

// OnChange registers fn for every display snapshot change. It runs on the
// provider's read loop, so it must not block.
func (h *Hub) OnChange(fn func([]Info)) (cancel func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	id := h.nextListen
	h.nextListen++
	h.listeners[id] = fn
	return func() {
		h.mu.Lock()
		delete(h.listeners, id)
		h.mu.Unlock()
	}
}

func (h *Hub) setDisplays(displays []Info) {
	h.mu.Lock()
	if slices.EqualFunc(h.displays, displays, Info.equal) {
		h.mu.Unlock()
		return
	}
	h.displays = displays
	listeners := make([]func([]Info), 0, len(h.listeners))
	for _, fn := range h.listeners {
		listeners = append(listeners, fn)
	}
	h.mu.Unlock()
	for _, fn := range listeners {
		fn(slices.Clone(displays))
	}
}

func (h *Hub) connect(ctx context.Context) error {
	raw, err := h.dial(ctx)
	if err != nil {
		return err
	}
	conn := &providerConn{wire: newWireConn(raw), closer: raw, pending: map[uint64]chan wireMessage{}, done: make(chan struct{})}
	defer conn.close()
	stop := context.AfterFunc(ctx, conn.close)
	defer stop()

	hello, err := conn.handshake()
	if err != nil {
		return err
	}
	h.logger.Info("display provider connected", slog.String("provider", hello.Name), slog.Int("version", hello.Version))
	h.mu.Lock()
	h.conn = conn
	h.mu.Unlock()
	defer h.disconnected(conn)

	for {
		message, media, err := conn.wire.read()
		if err != nil {
			if !errors.Is(err, io.EOF) && ctx.Err() == nil {
				h.logger.Warn("display provider connection lost", slog.String("error", err.Error()))
			}
			return err
		}
		switch {
		case media != nil:
			h.deliver(media.stream, media.sample)
		case message != nil:
			h.handleMessage(conn, *message)
		}
	}
}

func (h *Hub) handleMessage(conn *providerConn, message wireMessage) {
	switch message.Type {
	case "displays":
		if message.Displays == nil {
			return
		}
		valid := make([]Info, 0, len(*message.Displays))
		for _, info := range *message.Displays {
			if info.valid() && len(valid) < 16 {
				valid = append(valid, info.known())
			}
		}
		h.setDisplays(valid)
	case "reply":
		conn.resolve(message)
	case "ended":
		var reason error = ErrStreamEnded
		if message.Error != nil {
			reason = fmt.Errorf("%w: %s", ErrStreamEnded, message.Error.Message)
		}
		h.endStream(message.Stream, reason)
	}
}

func (h *Hub) disconnected(conn *providerConn) {
	h.mu.Lock()
	if h.conn != conn {
		h.mu.Unlock()
		return
	}
	h.conn = nil
	ids := make([]uint32, 0, len(h.byID))
	for id := range h.byID {
		ids = append(ids, id)
	}
	h.mu.Unlock()
	for _, id := range ids {
		h.endStream(id, fmt.Errorf("%w: provider disconnected", ErrStreamEnded))
	}
	h.setDisplays(nil)
}

func (h *Hub) currentConn() (*providerConn, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.conn == nil {
		return nil, errorf(CodeUnavailable, "no display provider is connected")
	}
	return h.conn, nil
}

func (h *Hub) Capture(ctx context.Context, params CaptureParams) (CaptureResult, error) {
	if err := params.normalize(); err != nil {
		return CaptureResult{}, err
	}
	if err := h.requireAbility(params.Display, func(info Info) bool { return info.Capture }, "capture"); err != nil {
		return CaptureResult{}, err
	}
	conn, err := h.currentConn()
	if err != nil {
		return CaptureResult{}, err
	}
	var result CaptureResult
	if err := conn.call(ctx, "capture", params, &result, callTimeout); err != nil {
		return CaptureResult{}, err
	}
	if result.Data == "" || (result.MimeType != "image/jpeg" && result.MimeType != "image/png") {
		return CaptureResult{}, errorf(CodeFailed, "provider returned no image")
	}
	return result, nil
}

func (h *Hub) Input(ctx context.Context, batch InputBatch) error {
	if err := batch.Validate(); err != nil {
		return err
	}
	if err := h.requireAbility(batch.Display, func(info Info) bool { return info.Input }, "input"); err != nil {
		return err
	}
	conn, err := h.currentConn()
	if err != nil {
		return err
	}
	timeout := callTimeout
	for _, event := range batch.Events {
		if event.T != nil {
			timeout = max(timeout, callTimeout+time.Duration(*event.T)*time.Millisecond)
		}
	}
	return conn.call(ctx, "input", batch, nil, timeout)
}

func (h *Hub) requireAbility(id string, has func(Info) bool, ability string) error {
	info, ok := h.Display(id)
	if !ok {
		return errorf(CodeNotFound, "display %q not found", id)
	}
	if !has(info) {
		return errorf(CodeUnavailable, "%s is not available on display %q", ability, id)
	}
	return nil
}

type stream struct {
	id      uint32
	display string
	conn    *providerConn
	subs    map[*Subscriber]struct{}
	params  parameterSets
	ready   chan struct{}
	err     error

	bitrate       int
	bitrateSentAt time.Time
	bitrateTimer  *time.Timer
	keyAskedAt    time.Time
	lingerTimer   *time.Timer
}

type Subscriber struct {
	hub     *Hub
	stream  *stream
	samples chan Sample
	done    chan struct{}
	err     error
	needKey bool
	bitrate int
	closed  atomic.Bool
}

func (s *Subscriber) Samples() <-chan Sample { return s.samples }

func (s *Subscriber) Done() <-chan struct{} { return s.done }

func (s *Subscriber) Err() error {
	select {
	case <-s.done:
		return s.err
	default:
		return nil
	}
}

func (s *Subscriber) Display() string { return s.stream.display }

func (h *Hub) Subscribe(ctx context.Context, display string) (*Subscriber, error) {
	h.mu.Lock()
	info, ok := h.displayLocked(display)
	switch {
	case h.conn == nil:
		h.mu.Unlock()
		return nil, errorf(CodeUnavailable, "no display provider is connected")
	case !ok:
		h.mu.Unlock()
		return nil, errorf(CodeNotFound, "display %q not found", display)
	case !info.Stream:
		h.mu.Unlock()
		return nil, errorf(CodeUnavailable, "streaming is not available on display %q", display)
	}
	current := h.streams[display]
	if current == nil {
		h.nextStream++
		current = &stream{id: h.nextStream, display: display, conn: h.conn, subs: map[*Subscriber]struct{}{}, ready: make(chan struct{}), bitrate: DefaultBitrate}
		h.streams[display] = current
		h.byID[current.id] = current
		go h.start(current)
	}
	if current.lingerTimer != nil {
		current.lingerTimer.Stop()
		current.lingerTimer = nil
	}
	sub := &Subscriber{hub: h, stream: current, samples: make(chan Sample, subscriberBuffer), done: make(chan struct{}), needKey: true}
	current.subs[sub] = struct{}{}
	h.mu.Unlock()

	select {
	case <-current.ready:
	case <-ctx.Done():
		sub.Close()
		return nil, ctx.Err()
	}
	if current.err != nil {
		sub.Close()
		return nil, current.err
	}
	h.requestKeyframe(current, true)
	return sub, nil
}

func (h *Hub) start(current *stream) {
	ctx, cancel := context.WithTimeout(context.Background(), startTimeout)
	defer cancel()
	err := current.conn.call(ctx, "stream.start", StreamStart{
		Stream: current.id, Display: current.display, Codec: "h264", Bitrate: current.bitrate, FPS: DefaultFPS, MaxSize: DefaultMaxSize,
	}, nil, startTimeout)
	if err != nil {
		h.logger.Warn("display stream failed to start", slog.String("display", current.display), slog.String("error", err.Error()))
		current.err = err
		close(current.ready)
		h.endStream(current.id, err)
		return
	}
	h.logger.Info("display stream started", slog.String("display", current.display), slog.Uint64("stream", uint64(current.id)))
	close(current.ready)
}

func (s *Subscriber) Close() {
	if s.closed.Swap(true) {
		return
	}
	h := s.hub
	h.mu.Lock()
	defer h.mu.Unlock()
	current := s.stream
	if _, ok := current.subs[s]; !ok {
		return
	}
	delete(current.subs, s)
	s.finish(nil)
	if len(current.subs) > 0 {
		h.scheduleBitrateLocked(current)
		return
	}
	current.lingerTimer = time.AfterFunc(streamLinger, func() {
		h.mu.Lock()
		if len(current.subs) > 0 || h.byID[current.id] != current {
			h.mu.Unlock()
			return
		}
		h.removeStreamLocked(current)
		h.mu.Unlock()
		_ = current.conn.notify("stream.stop", StreamControl{Stream: current.id})
		h.logger.Info("display stream stopped", slog.String("display", current.display), slog.Uint64("stream", uint64(current.id)))
	})
}

func (s *Subscriber) finish(err error) {
	select {
	case <-s.done:
	default:
		s.err = err
		close(s.done)
	}
}

func (s *Subscriber) SetBitrate(bps int) {
	h := s.hub
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := s.stream.subs[s]; !ok || s.bitrate == bps {
		return
	}
	s.bitrate = bps
	h.scheduleBitrateLocked(s.stream)
}

func (s *Subscriber) RequestKeyframe() {
	s.hub.requestKeyframe(s.stream, false)
}

func (h *Hub) scheduleBitrateLocked(current *stream) {
	target := 0
	for sub := range current.subs {
		if sub.bitrate > 0 && (target == 0 || sub.bitrate < target) {
			target = sub.bitrate
		}
	}
	if target == 0 {
		return
	}
	target = max(MinBitrate, min(MaxBitrate, target))
	if target == current.bitrate || current.bitrateTimer != nil {
		return
	}
	wait := bitrateInterval - time.Since(current.bitrateSentAt)
	current.bitrateTimer = time.AfterFunc(max(0, wait), func() {
		h.mu.Lock()
		current.bitrateTimer = nil
		if h.byID[current.id] != current {
			h.mu.Unlock()
			return
		}
		latest := 0
		for sub := range current.subs {
			if sub.bitrate > 0 && (latest == 0 || sub.bitrate < latest) {
				latest = sub.bitrate
			}
		}
		latest = max(MinBitrate, min(MaxBitrate, latest))
		if latest == current.bitrate || len(current.subs) == 0 {
			h.mu.Unlock()
			return
		}
		current.bitrate = latest
		current.bitrateSentAt = time.Now()
		h.mu.Unlock()
		_ = current.conn.notify("stream.update", StreamControl{Stream: current.id, Bitrate: latest})
	})
}

func (h *Hub) requestKeyframe(current *stream, force bool) {
	h.mu.Lock()
	if h.byID[current.id] != current || (!force && time.Since(current.keyAskedAt) < keyframeDebounce) {
		h.mu.Unlock()
		return
	}
	current.keyAskedAt = time.Now()
	h.mu.Unlock()
	_ = current.conn.notify("stream.keyframe", StreamControl{Stream: current.id})
}

func (h *Hub) deliver(id uint32, sample Sample) {
	h.mu.Lock()
	current := h.byID[id]
	if current == nil {
		h.mu.Unlock()
		return
	}
	idr := current.params.observe(sample.Data)
	if onlyParameterSets(sample.Data) {
		h.mu.Unlock()
		return
	}
	sample.Key = sample.Key || idr
	if sample.Key {
		sample.Data = current.params.complete(sample.Data)
	}
	starved := false
	for sub := range current.subs {
		if sub.needKey && !sample.Key {
			continue
		}
		select {
		case sub.samples <- sample:
			sub.needKey = false
		default:
			sub.needKey = true
			starved = true
		}
	}
	h.mu.Unlock()
	if starved {
		// Off the read loop: a provider that stops reading must not stall it.
		go h.requestKeyframe(current, false)
	}
}

func (h *Hub) endStream(id uint32, reason error) {
	h.mu.Lock()
	current := h.byID[id]
	if current == nil {
		h.mu.Unlock()
		return
	}
	h.removeStreamLocked(current)
	for sub := range current.subs {
		sub.finish(reason)
	}
	current.subs = map[*Subscriber]struct{}{}
	h.mu.Unlock()
	h.logger.Info("display stream ended", slog.String("display", current.display), slog.String("reason", reason.Error()))
}

func (h *Hub) removeStreamLocked(current *stream) {
	delete(h.byID, current.id)
	if h.streams[current.display] == current {
		delete(h.streams, current.display)
	}
	if current.lingerTimer != nil {
		current.lingerTimer.Stop()
	}
	if current.bitrateTimer != nil {
		current.bitrateTimer.Stop()
	}
}

type providerConn struct {
	wire      *wireConn
	closer    io.Closer
	nextID    atomic.Uint64
	mu        sync.Mutex
	pending   map[uint64]chan wireMessage
	done      chan struct{}
	closeOnce sync.Once
}

func (p *providerConn) close() {
	p.closeOnce.Do(func() {
		close(p.done)
		_ = p.closer.Close()
	})
}

func (p *providerConn) handshake() (*wireMessage, error) {
	type result struct {
		message *wireMessage
		err     error
	}
	got := make(chan result, 1)
	go func() {
		message, _, err := p.wire.read()
		got <- result{message, err}
	}()
	select {
	case r := <-got:
		if r.err != nil {
			return nil, r.err
		}
		if r.message == nil || r.message.Type != "hello" {
			return nil, errors.New("display provider did not say hello")
		}
		if r.message.Version != WireVersion {
			return nil, fmt.Errorf("display provider speaks version %d, want %d", r.message.Version, WireVersion)
		}
		return r.message, nil
	case <-time.After(handshakeTimeout):
		return nil, errors.New("display provider handshake timed out")
	}
}

func (p *providerConn) notify(method string, params any) error {
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return p.wire.writeJSON(wireMessage{Type: "call", Method: method, Params: raw})
}

func (p *providerConn) call(ctx context.Context, method string, params any, result any, timeout time.Duration) error {
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	id := p.nextID.Add(1)
	reply := make(chan wireMessage, 1)
	p.mu.Lock()
	p.pending[id] = reply
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		delete(p.pending, id)
		p.mu.Unlock()
	}()
	if err := p.wire.writeJSON(wireMessage{Type: "call", ID: id, Method: method, Params: raw}); err != nil {
		p.close()
		return errorf(CodeUnavailable, "display provider unreachable: %v", err)
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case message := <-reply:
		if message.Error != nil {
			return message.Error
		}
		if result != nil && len(message.Result) > 0 {
			if err := json.Unmarshal(message.Result, result); err != nil {
				return errorf(CodeFailed, "invalid %s result: %v", method, err)
			}
		}
		return nil
	case <-p.done:
		return errorf(CodeUnavailable, "display provider disconnected")
	case <-timer.C:
		return errorf(CodeTimeout, "%s timed out", method)
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *providerConn) resolve(message wireMessage) {
	p.mu.Lock()
	reply := p.pending[message.ID]
	p.mu.Unlock()
	if reply != nil {
		select {
		case reply <- message:
		default:
		}
	}
}
