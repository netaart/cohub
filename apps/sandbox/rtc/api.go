package rtc

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/cc"
	"github.com/pion/interceptor/pkg/gcc"
	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"

	"github.com/cohub/apps/sandbox/display"
)

type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

func (s *ICEServer) UnmarshalJSON(data []byte) error {
	var raw struct {
		URLs       json.RawMessage `json:"urls"`
		Username   string          `json:"username"`
		Credential string          `json:"credential"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	var one string
	if err := json.Unmarshal(raw.URLs, &one); err == nil {
		s.URLs = []string{one}
	} else if err := json.Unmarshal(raw.URLs, &s.URLs); err != nil {
		return errors.New("urls must be a string or a list of strings")
	}
	s.Username, s.Credential = raw.Username, raw.Credential
	return nil
}

const (
	maxICEServers = 8
	maxICEURLs    = 16
)

func toWebRTCServers(servers []ICEServer) ([]webrtc.ICEServer, error) {
	if len(servers) > maxICEServers {
		return nil, fmt.Errorf("at most %d ICE servers", maxICEServers)
	}
	out := make([]webrtc.ICEServer, 0, len(servers))
	for _, server := range servers {
		if len(server.URLs) == 0 || len(server.URLs) > maxICEURLs {
			return nil, errors.New("each ICE server needs 1..16 urls")
		}
		for _, url := range server.URLs {
			if !strings.HasPrefix(url, "stun:") && !strings.HasPrefix(url, "turn:") && !strings.HasPrefix(url, "turns:") {
				return nil, fmt.Errorf("unsupported ICE url %q", url)
			}
		}
		entry := webrtc.ICEServer{URLs: relayURLs(server.URLs)}
		if server.Username != "" || server.Credential != "" {
			entry.Username = server.Username
			entry.Credential = server.Credential
			entry.CredentialType = webrtc.ICECredentialTypePassword
		}
		out = append(out, entry)
	}
	return out, nil
}

// relayURLs keeps STUN plus one UDP and one TLS relay (TCP only as a fallback).
func relayURLs(urls []string) []string {
	kept := make([]string, 0, len(urls))
	var udp, tls, tcp string
	for _, url := range urls {
		switch {
		case strings.HasPrefix(url, "stun:"):
			kept = append(kept, url)
		case strings.HasPrefix(url, "turns:"):
			tls = cmp.Or(tls, url)
		case strings.Contains(url, "transport=tcp"):
			tcp = cmp.Or(tcp, url)
		default:
			udp = cmp.Or(udp, url)
		}
	}
	if udp == "" && tls == "" {
		udp = tcp
	}
	for _, url := range []string{udp, tls} {
		if url != "" {
			kept = append(kept, url)
		}
	}
	return kept
}

var h264Profiles = []string{"42e01f", "42001f"}

var videoFeedback = []webrtc.RTCPFeedback{
	{Type: webrtc.TypeRTCPFBNACK},
	{Type: webrtc.TypeRTCPFBNACK, Parameter: "pli"},
	{Type: webrtc.TypeRTCPFBCCM, Parameter: "fir"},
	{Type: webrtc.TypeRTCPFBTransportCC},
}

func newAPI(logger *slog.Logger) (*webrtc.API, <-chan cc.BandwidthEstimator, error) {
	media := &webrtc.MediaEngine{}
	for index, profile := range h264Profiles {
		if err := media.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{
				MimeType:     webrtc.MimeTypeH264,
				ClockRate:    90000,
				SDPFmtpLine:  "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=" + profile,
				RTCPFeedback: videoFeedback,
			},
			PayloadType: webrtc.PayloadType(102 + index),
		}, webrtc.RTPCodecTypeVideo); err != nil {
			return nil, nil, err
		}
	}

	if err := media.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: playoutDelayURI}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, nil, err
	}

	registry := &interceptor.Registry{}
	congestion, err := cc.NewInterceptor(func() (cc.BandwidthEstimator, error) {
		return gcc.NewSendSideBWE(
			gcc.SendSideBWEInitialBitrate(display.DefaultBitrate),
			gcc.SendSideBWEMinBitrate(display.MinBitrate),
			gcc.SendSideBWEMaxBitrate(display.MaxBitrate),
			// Pacing bursty screen frames only adds latency.
			gcc.SendSideBWEPacer(gcc.NewNoOpPacer()),
		)
	})
	if err != nil {
		return nil, nil, err
	}
	estimators := make(chan cc.BandwidthEstimator, 1)
	congestion.OnNewPeerConnection(func(_ string, estimator cc.BandwidthEstimator) {
		select {
		case estimators <- estimator:
		default:
		}
	})
	registry.Add(congestion)
	if err := webrtc.ConfigureTWCCHeaderExtensionSender(media, registry); err != nil {
		return nil, nil, err
	}
	if err := webrtc.RegisterDefaultInterceptors(media, registry); err != nil {
		return nil, nil, err
	}

	settings := webrtc.SettingEngine{LoggerFactory: pionLoggers{logger}}
	settings.SetICETimeouts(iceDisconnectedTimeout, iceFailedTimeout, iceKeepAlive)
	return webrtc.NewAPI(webrtc.WithMediaEngine(media), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings)), estimators, nil
}

// pionLoggers routes pion's logs into slog: its errors become warnings, its
// warnings debug lines, the rest is dropped. Pion never writes to stderr,
// which Android uses as the control pipe.
type pionLoggers struct{ logger *slog.Logger }

func (f pionLoggers) NewLogger(scope string) logging.LeveledLogger {
	return pionLogger{f.logger.With(slog.String("pion", scope))}
}

type pionLogger struct{ logger *slog.Logger }

func (l pionLogger) Trace(string)                  {}
func (l pionLogger) Tracef(string, ...any)         {}
func (l pionLogger) Debug(string)                  {}
func (l pionLogger) Debugf(string, ...any)         {}
func (l pionLogger) Info(string)                   {}
func (l pionLogger) Infof(string, ...any)          {}
func (l pionLogger) Warn(msg string)               { l.logger.Debug(msg) }
func (l pionLogger) Warnf(format string, a ...any) { l.logger.Debug(fmt.Sprintf(format, a...)) }
func (l pionLogger) Error(msg string)              { l.logger.Warn(msg) }
func (l pionLogger) Errorf(format string, a ...any) {
	l.logger.Warn(fmt.Sprintf(format, a...))
}
