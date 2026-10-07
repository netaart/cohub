package rtc

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/interceptor/pkg/cc"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"golang.org/x/time/rate"

	"github.com/cohub/apps/sandbox/display"
)

const (
	ControlChannel = "control"
	InputChannel   = "input"

	inputQueue        = 256
	relayMaxBitrate   = 6_000_000
	inputEventsPerSec = 600
	inputBurst        = 1200
	maxChannelMessage = 256 << 10
)

type controlMessage struct {
	Type    string        `json:"type"`
	ID      *int64        `json:"id,omitempty"`
	Display *display.Info `json:"display,omitempty"`
	Control *bool         `json:"control,omitempty"`
	Reason  string        `json:"reason,omitempty"`
	Code    string        `json:"code,omitempty"`
	Message string        `json:"message,omitempty"`
}

type session struct {
	id                   string
	display              string
	userID               string
	control              bool
	manager              *Manager
	logger               *slog.Logger
	pc                   *webrtc.PeerConnection
	track                *videoTrack
	sender               *webrtc.RTPSender
	ctx                  context.Context
	cancel               context.CancelFunc
	openedAt             time.Time
	subscribed, gathered time.Duration

	mediaMu sync.Mutex
	sub     *display.Subscriber
	paused  bool
	bitrate atomic.Int64

	connected atomic.Bool
	relayed   atomic.Bool
	lastPing  atomic.Int64
	channelMu sync.Mutex
	channel   *webrtc.DataChannel
	inputs    chan display.InputBatch
	limiter   *rate.Limiter
	closeOnce sync.Once
}

func openSession(ctx context.Context, manager *Manager, params OpenParams, servers []webrtc.ICEServer) (*session, string, error) {
	logger := manager.logger.With(slog.String("session", params.SessionID), slog.String("display", params.Display))
	api, estimators, err := newAPI(logger)
	if err != nil {
		return nil, "", err
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{ICEServers: servers})
	if err != nil {
		return nil, "", err
	}
	track, err := newVideoTrack()
	if err != nil {
		_ = pc.Close()
		return nil, "", err
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: params.Offer}); err != nil {
		_ = pc.Close()
		return nil, "", invalid("offer rejected: %v", err)
	}
	sender, err := pc.AddTrack(track)
	if err != nil {
		_ = pc.Close()
		return nil, "", invalid("offer has no video to receive: %v", err)
	}

	sessionCtx, cancel := context.WithCancel(context.Background())
	current := &session{
		id: params.SessionID, display: params.Display, userID: params.UserID, control: params.Control,
		manager: manager, logger: logger, pc: pc, track: track, sender: sender,
		ctx: sessionCtx, cancel: cancel, openedAt: time.Now(),
		inputs: make(chan display.InputBatch, inputQueue), limiter: rate.NewLimiter(inputEventsPerSec, inputBurst),
	}
	fail := func(err error) (*session, string, error) {
		current.close(ReasonFailed)
		return nil, "", err
	}
	current.lastPing.Store(time.Now().UnixMilli())
	pc.OnConnectionStateChange(current.onConnectionState)
	pc.OnDataChannel(current.onDataChannel)

	subscribed := make(chan error, 1)
	go func() { subscribed <- current.attach() }()
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return fail(invalid("cannot answer offer: %v", err))
	}
	gathered := gatheredWithin(pc, gatherTimeout)
	if err := pc.SetLocalDescription(answer); err != nil {
		return fail(err)
	}
	for subscribed != nil || gathered != nil {
		select {
		case err := <-subscribed:
			if err != nil {
				return fail(err)
			}
			subscribed, current.subscribed = nil, time.Since(current.openedAt)
		case <-gathered:
			gathered, current.gathered = nil, time.Since(current.openedAt)
		case <-ctx.Done():
			return fail(ctx.Err())
		}
	}

	select {
	case estimator := <-estimators:
		current.followEstimate(estimator)
	default:
	}
	return current, pc.LocalDescription().SDP, nil
}

func gatheredWithin(pc *webrtc.PeerConnection, wait time.Duration) <-chan struct{} {
	complete := webrtc.GatheringCompletePromise(pc)
	done := make(chan struct{})
	go func() {
		select {
		case <-complete:
		case <-time.After(wait):
		}
		close(done)
	}()
	return done
}

// followEstimate feeds congestion control to the encoder. A direct path,
// e.g. on a LAN, may use the hub's full range; TURN traffic is billed, so
// a relayed one stays below relayMaxBitrate.
func (s *session) followEstimate(estimator cc.BandwidthEstimator) {
	follow := func(bitrate int) {
		if s.relayed.Load() {
			bitrate = min(bitrate, relayMaxBitrate)
		}
		s.bitrate.Store(int64(bitrate))
		if sub := s.subscription(); sub != nil {
			sub.SetBitrate(bitrate)
		}
	}
	follow(estimator.GetTargetBitrate())
	estimator.OnTargetBitrateChange(follow)
}

func (s *session) run() {
	s.logger.Info("rtc session opened",
		slog.String("userId", s.userID), slog.Bool("control", s.control),
		slog.Duration("subscribed", s.subscribed), slog.Duration("gathered", s.gathered),
	)
	go s.readRTCP()
	if s.control {
		go s.applyInput()
	}
	go s.resyncOnBind()
	stopWatch := s.manager.hub.OnChange(s.onDisplays)
	defer stopWatch()
	s.watch()
}

func (s *session) subscription() *display.Subscriber {
	s.mediaMu.Lock()
	defer s.mediaMu.Unlock()
	return s.sub
}

func (s *session) attach() error {
	sub, err := s.manager.hub.Subscribe(s.ctx, s.display)
	if err != nil {
		return err
	}
	s.mediaMu.Lock()
	if s.paused || s.sub != nil || s.ctx.Err() != nil {
		s.mediaMu.Unlock()
		sub.Close()
		return nil
	}
	s.sub = sub
	s.mediaMu.Unlock()
	if bitrate := s.bitrate.Load(); bitrate > 0 {
		sub.SetBitrate(int(bitrate))
	}
	go s.forward(sub)
	return nil
}

func (s *session) forward(sub *display.Subscriber) {
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-sub.Done():
			if sub.Err() != nil {
				s.close(ReasonDisplayEnded)
			}
			return
		case sample := <-sub.Samples():
			if err := s.track.WriteFrame(sample.Data, sample.PTS, sample.Key); err != nil && !errors.Is(err, context.Canceled) {
				s.logger.Debug("rtc write failed", slog.String("error", err.Error()))
			}
		}
	}
}

func (s *session) resyncOnBind() {
	select {
	case <-s.track.Bound():
		if sub := s.subscription(); sub != nil {
			sub.Resync()
		}
	case <-s.ctx.Done():
	}
}

func (s *session) pause() {
	s.mediaMu.Lock()
	s.paused = true
	sub := s.sub
	s.sub = nil
	s.mediaMu.Unlock()
	if sub != nil {
		sub.Close()
	}
}

func (s *session) resume() {
	s.mediaMu.Lock()
	paused := s.paused
	s.paused = false
	s.mediaMu.Unlock()
	if !paused {
		return
	}
	if err := s.attach(); err != nil && s.ctx.Err() == nil {
		s.logger.Info("rtc session could not resume", slog.String("error", err.Error()))
		reason := ReasonFailed
		if code := display.ErrorCode(err); code == display.CodeNotFound || code == display.CodeUnavailable {
			reason = ReasonDisplayEnded
		}
		s.close(reason)
	}
}

func (s *session) requestKeyframe() {
	if sub := s.subscription(); sub != nil {
		sub.RequestKeyframe()
	}
}

func (s *session) readRTCP() {
	for {
		packets, _, err := s.sender.ReadRTCP()
		if err != nil {
			return
		}
		for _, packet := range packets {
			switch packet.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				s.requestKeyframe()
			}
		}
	}
}

func (s *session) watch() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			age := time.Since(s.openedAt)
			switch {
			case age > maxLifetime:
				s.close(ReasonExpired)
			case !s.connected.Load() && age > connectTimeout:
				s.close(ReasonConnectTimeout)
			case s.connected.Load() && time.Since(time.UnixMilli(s.lastPing.Load())) > idleTimeout:
				s.close(ReasonIdle)
			}
		}
	}
}

func (s *session) onConnectionState(state webrtc.PeerConnectionState) {
	switch state {
	case webrtc.PeerConnectionStateConnected:
		if !s.connected.Swap(true) {
			s.lastPing.Store(time.Now().UnixMilli())
			path, _ := s.route()
			s.relayed.Store(strings.Contains(path, "relay"))
			s.logger.Info("rtc session connected", slog.String("path", path), slog.Duration("after", time.Since(s.openedAt)))
		}
	case webrtc.PeerConnectionStateFailed:
		// Pion may hold its own locks while calling back; close off this stack.
		go s.close(ReasonFailed)
	case webrtc.PeerConnectionStateClosed:
		go s.close(ReasonClosed)
	}
}

func (s *session) onDataChannel(channel *webrtc.DataChannel) {
	switch channel.Label() {
	case ControlChannel:
		s.channelMu.Lock()
		s.channel = channel
		s.channelMu.Unlock()
		channel.OnOpen(func() {
			info, _ := s.manager.hub.Display(s.display)
			control := s.control
			s.send(controlMessage{Type: "ready", Display: &info, Control: &control})
		})
		channel.OnMessage(s.onControl)
	case InputChannel:
		if !s.control {
			_ = channel.Close()
			return
		}
		channel.OnMessage(s.onInput)
	default:
		_ = channel.Close()
	}
}

func (s *session) onControl(message webrtc.DataChannelMessage) {
	if !message.IsString || len(message.Data) > maxChannelMessage {
		return
	}
	var incoming controlMessage
	if json.Unmarshal(message.Data, &incoming) != nil {
		return
	}
	s.lastPing.Store(time.Now().UnixMilli())
	switch incoming.Type {
	case "ping":
		s.send(controlMessage{Type: "pong", ID: incoming.ID})
	case "keyframe":
		s.requestKeyframe()
	case "pause":
		s.pause()
	case "resume":
		go s.resume()
	}
}

func (s *session) onInput(message webrtc.DataChannelMessage) {
	if len(message.Data) > maxChannelMessage {
		return
	}
	var batch display.InputBatch
	if json.Unmarshal(message.Data, &batch) != nil {
		return
	}
	batch.Display = s.display
	if !s.limiter.AllowN(time.Now(), len(batch.Events)) {
		s.send(controlMessage{Type: "error", Code: "rate_limited", Message: "input is arriving too fast"})
		return
	}
	select {
	case s.inputs <- batch:
	default:
		s.send(controlMessage{Type: "error", Code: display.CodeBusy, Message: "input queue is full"})
	}
}

func (s *session) applyInput() {
	for {
		select {
		case <-s.ctx.Done():
			return
		case batch := <-s.inputs:
			if err := s.manager.hub.Input(s.ctx, batch); err != nil && s.ctx.Err() == nil {
				s.send(controlMessage{Type: "error", Code: display.ErrorCode(err), Message: err.Error()})
			}
		}
	}
}

func (s *session) onDisplays(displays []display.Info) {
	for _, info := range displays {
		if info.ID == s.display {
			s.send(controlMessage{Type: "display", Display: &info})
			return
		}
	}
}

func (s *session) send(message controlMessage) {
	s.channelMu.Lock()
	channel := s.channel
	s.channelMu.Unlock()
	if channel == nil || channel.ReadyState() != webrtc.DataChannelStateOpen {
		return
	}
	raw, err := json.Marshal(message)
	if err == nil {
		_ = channel.SendText(string(raw))
	}
}

func (s *session) close(reason string) {
	s.closeOnce.Do(func() {
		s.send(controlMessage{Type: "closed", Reason: reason})
		var path string
		var sent uint64
		// Pion races its own teardown against GetStats once closed.
		if s.pc.ConnectionState() != webrtc.PeerConnectionStateClosed {
			path, sent = s.route()
		}
		s.cancel()
		s.pause()
		_ = s.pc.Close()
		s.manager.forget(s)
		s.logger.Info("rtc session closed",
			slog.String("reason", reason), slog.String("path", path),
			slog.Duration("duration", time.Since(s.openedAt)), slog.Uint64("bytesSent", sent),
		)
	})
}

func (s *session) route() (path string, bytesSent uint64) {
	stats := s.pc.GetStats()
	path = "none"
	for _, value := range stats {
		switch entry := value.(type) {
		case webrtc.TransportStats:
			bytesSent += entry.BytesSent
		case webrtc.ICECandidatePairStats:
			if entry.Nominated && entry.State == webrtc.StatsICECandidatePairStateSucceeded {
				local, _ := stats[entry.LocalCandidateID].(webrtc.ICECandidateStats)
				remote, _ := stats[entry.RemoteCandidateID].(webrtc.ICECandidateStats)
				path = local.CandidateType.String() + "/" + remote.CandidateType.String()
			}
		}
	}
	return path, bytesSent
}
