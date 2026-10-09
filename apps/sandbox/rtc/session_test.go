package rtc

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/cohub/apps/sandbox/display"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

type syntheticProvider struct {
	inputs atomic.Int32
}

func (p *syntheticProvider) serve(ctx context.Context, rw io.ReadWriteCloser) {
	conn, err := display.NewProviderConn(rw, "synthetic")
	if err != nil {
		return
	}
	_ = conn.SetDisplays([]display.Info{{ID: "main", Name: "Synthetic", Width: 640, Height: 360, Stream: true, Capture: true, Input: true}})
	_ = conn.Serve(ctx, func(_ context.Context, method string, raw json.RawMessage) (any, error) {
		switch method {
		case "stream.start":
			var start display.StreamStart
			_ = json.Unmarshal(raw, &start)
			go func() {
				for frame := 0; ctx.Err() == nil; frame++ {
					data := []byte{0, 0, 0, 1, 0x41, byte(frame)}
					if frame%10 == 0 {
						data = []byte{0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 2, 0, 0, 0, 1, 0x65, byte(frame)}
					}
					if conn.WriteSample(start.Stream, display.Sample{Data: data, PTS: uint64(frame) * 33_000, Key: frame%10 == 0}) != nil {
						return
					}
					time.Sleep(10 * time.Millisecond)
				}
			}()
		case "input":
			var batch display.InputBatch
			_ = json.Unmarshal(raw, &batch)
			p.inputs.Add(int32(len(batch.Events)))
		}
		return nil, nil
	})
}

func newTestManager(t *testing.T) (*Manager, *syntheticProvider) {
	t.Helper()
	provider := &syntheticProvider{}
	hub := display.NewHub(func(ctx context.Context) (io.ReadWriteCloser, error) {
		local, remote := net.Pipe()
		go provider.serve(ctx, remote)
		return local, nil
	}, quiet)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go hub.Run(ctx)
	deadline := time.Now().Add(3 * time.Second)
	for len(hub.Displays()) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("provider never connected")
		}
		time.Sleep(5 * time.Millisecond)
	}
	return NewManager(hub, quiet), provider
}

type viewer struct {
	pc       *webrtc.PeerConnection
	control  *webrtc.DataChannel
	input    *webrtc.DataChannel
	messages chan controlMessage
	packets  atomic.Int32
}

func newViewer(t *testing.T) *viewer {
	t.Helper()
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	v := &viewer{pc: pc, messages: make(chan controlMessage, 32)}
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatal(err)
	}
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			if _, _, err := track.ReadRTP(); err != nil {
				return
			}
			v.packets.Add(1)
		}
	})
	if v.control, err = pc.CreateDataChannel(ControlChannel, nil); err != nil {
		t.Fatal(err)
	}
	v.control.OnMessage(func(message webrtc.DataChannelMessage) {
		var decoded controlMessage
		if json.Unmarshal(message.Data, &decoded) == nil {
			v.messages <- decoded
		}
	})
	if v.input, err = pc.CreateDataChannel(InputChannel, nil); err != nil {
		t.Fatal(err)
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	return v
}

func (v *viewer) expect(t *testing.T, kind string) controlMessage {
	t.Helper()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case message := <-v.messages:
			if message.Type == kind {
				return message
			}
		case <-timeout:
			t.Fatalf("no %q control message", kind)
		}
	}
}

func TestSessionStreamsAndAcceptsInput(t *testing.T) {
	manager, provider := newTestManager(t)
	v := newViewer(t)
	const id = "0b5f7c2e-8c1d-4a3e-9f6b-2d7a1c9e4b10"
	result, err := manager.Open(context.Background(), OpenParams{
		SessionID: id, Display: "main", Offer: v.pc.LocalDescription().SDP, Control: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := v.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: result.Answer}); err != nil {
		t.Fatal(err)
	}

	ready := v.expect(t, "ready")
	if ready.Display == nil || ready.Display.ID != "main" || ready.Control == nil || !*ready.Control {
		t.Fatalf("unexpected ready %+v", ready)
	}
	ping := int64(7)
	raw, _ := json.Marshal(controlMessage{Type: "ping", ID: &ping})
	if err := v.control.SendText(string(raw)); err != nil {
		t.Fatal(err)
	}
	if pong := v.expect(t, "pong"); pong.ID == nil || *pong.ID != 7 {
		t.Fatalf("unexpected pong %+v", pong)
	}

	x, y := 0.5, 0.5
	batch, _ := json.Marshal(display.InputBatch{Events: []display.InputEvent{
		{Type: "pointer", Action: "down", X: &x, Y: &y},
		{Type: "pointer", Action: "up", X: &x, Y: &y},
	}})
	if err := v.input.SendText(string(batch)); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(10 * time.Second)
	for v.packets.Load() < 5 || provider.inputs.Load() < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("packets=%d inputs=%d", v.packets.Load(), provider.inputs.Load())
		}
		time.Sleep(20 * time.Millisecond)
	}

	if !manager.Close(id, "") {
		t.Fatal("session should have been open")
	}
	if manager.Count() != 0 || manager.Close(id, "") {
		t.Fatal("session must be gone after close")
	}
}
