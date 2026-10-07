package rtc

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/interceptor/pkg/cc"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"golang.org/x/time/rate"

	"github.com/cohub/apps/sandbox/display"
)

const (
	ControlChannel = "control"
	InputChannel   = "input"

	inputQueue        = 256
	inputEventsPerSec = 600
	inputBurst        = 1200
	maxChannelMessage = 256 << 10
	defaultFrameTime  = 33 * time.Millisecond
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
	id       string
	display  string
	userID   string
	control  bool
	manager  *Manager
	logger   *slog.Logger
	pc       *webrtc.PeerConnection
	track    *webrtc.TrackLocalStaticSample
	sender   *webrtc.RTPSender
	sub      *display.Subscriber
	ctx      context.Context
	cancel   context.CancelFunc
	openedAt time.Time

	connected atomic.Bool
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
	sub, err := manager.hub.Subscribe(ctx, params.Display)
	if err != nil {
		return nil, "", err
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{ICEServers: servers})
	if err != nil {
		sub.Close()
		return nil, "", err
	}
	fail := func(err error) (*session, string, error) {
		sub.Close()
		_ = pc.Close()
		return nil, "", err
	}
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000}, "display", "cohub")
	if err != nil {
		return fail(err)
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: params.Offer}); err != nil {
		return fail(invalid("offer rejected: %v", err))
	}
	sender, err := pc.AddTrack(track)
	if err != nil {
		return fail(invalid("offer has no video to receive: %v", err))
	}

	sessionCtx, cancel := context.WithCancel(context.Background())
	current := &session{
		id: params.SessionID, display: params.Display, userID: params.UserID, control: params.Control,
		manager: manager, logger: logger, pc: pc, track: track, sender: sender, sub: sub,
		ctx: sessionCtx, cancel: cancel, openedAt: time.Now(),
		inputs: make(chan display.InputBatch, inputQueue), limiter: rate.NewLimiter(inputEventsPerSec, inputBurst),
	}
	current.lastPing.Store(time.Now().UnixMilli())
	pc.OnConnectionStateChange(current.onConnectionState)
	pc.OnDataChannel(current.onDataChannel)

	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		cancel()
		return fail(invalid("cannot answer offer: %v", err))
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		cancel()
		return fail(err)
	}
	select {
	case <-gathered:
	case <-time.After(gatherTimeout):
		logger.Debug("ICE gathering incomplete; answering with partial candidates")
	case <-ctx.Done():
		cancel()
		return fail(ctx.Err())
	}

	select {
	case estimator := <-estimators:
		current.followEstimate(estimator)
	default:
	}
	return current, pc.LocalDescription().SDP, nil
}

func (s *session) followEstimate(estimator cc.BandwidthEstimator) {
	s.sub.SetBitrate(estimator.GetTargetBitrate())
	estimator.OnTargetBitrateChange(func(bitrate int) { s.sub.SetBitrate(bitrate) })
}

func (s *session) run() {
	s.logger.Info("rtc session opened", slog.String("userId", s.userID), slog.Bool("control", s.control))
	go s.readRTCP()
	if s.control {
		go s.applyInput()
	}
	go s.watch()
	stopWatch := s.manager.hub.OnChange(s.onDisplays)
	defer stopWatch()

	var lastPTS uint64
	written := false
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-s.sub.Done():
			s.close(ReasonDisplayEnded)
			return
		case sample := <-s.sub.Samples():
			duration := defaultFrameTime
			if written && sample.PTS > lastPTS {
				duration = min(time.Second, time.Duration(sample.PTS-lastPTS)*time.Microsecond)
			}
			lastPTS, written = sample.PTS, true
			if err := s.track.WriteSample(media.Sample{Data: sample.Data, Duration: duration}); err != nil && !errors.Is(err, context.Canceled) {
				s.logger.Debug("rtc write failed", slog.String("error", err.Error()))
			}
		}
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
				s.sub.RequestKeyframe()
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
		s.sub.RequestKeyframe()
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
		path, sent := s.route()
		s.cancel()
		s.sub.Close()
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
