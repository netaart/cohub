package display

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func h264Frames(t *testing.T, size string) [][]byte {
	t.Helper()
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("needs ffmpeg")
	}
	out, err := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size="+size+":rate=30",
		"-frames:v", "60", "-c:v", "libx264", "-profile:v", "baseline", "-g", "10", "-bsf:v", "h264_metadata=aud=insert", "-f", "h264", "pipe:1").Output()
	if err != nil {
		t.Skipf("ffmpeg cannot encode H.264: %v", err)
	}
	var splitter accessUnitSplitter
	frames := splitter.push(append(out, 0, 0, 0, 1, 0x09, 0xf0))
	if len(frames) < 50 {
		t.Fatalf("encoded %d frames", len(frames))
	}
	return frames
}

type clipProvider struct {
	frames [][]byte
	focus  chan *Focus
}

func (p *clipProvider) serve(ctx context.Context, rw io.ReadWriteCloser) {
	conn, err := NewProviderConn(rw, "clip")
	if err != nil {
		return
	}
	_ = conn.SetDisplays([]Info{{ID: "main", Width: 320, Height: 240, Stream: true, Capture: true, Focus: true}})
	go func() {
		for focus := range p.focus {
			_ = conn.SetFocus("main", focus)
		}
	}()
	_ = conn.Serve(ctx, func(_ context.Context, method string, raw json.RawMessage) (any, error) {
		if method == "stream.start" {
			var start StreamStart
			_ = json.Unmarshal(raw, &start)
			go func() {
				for i, frame := range p.frames {
					if ctx.Err() != nil || conn.WriteSample(start.Stream, Sample{Data: frame, PTS: uint64(i) * 33_333}) != nil {
						return
					}
					time.Sleep(15 * time.Millisecond)
				}
			}()
		}
		return nil, nil
	})
}

func recordingHub(t *testing.T, provider *clipProvider) (*Hub, string) {
	t.Helper()
	hub := NewHub(func(ctx context.Context) (io.ReadWriteCloser, error) {
		local, remote := net.Pipe()
		go provider.serve(ctx, remote)
		return local, nil
	}, slog.New(slog.DiscardHandler))
	workspace := t.TempDir()
	hub.SetStore(NewStore(workspace, nil))
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
	return hub, filepath.Join(workspace, filepath.FromSlash(storeDir), "recordings")
}

func probe(t *testing.T, path string) (frames int, seconds float64) {
	t.Helper()
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("needs ffprobe")
	}
	out, err := exec.Command(ffprobe, "-v", "error", "-count_frames", "-select_streams", "v:0",
		"-show_entries", "stream=nb_read_frames:format=duration", "-of", "default=nw=1:nk=1", path).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", path, err)
	}
	fields := strings.Fields(string(out))
	frames, _ = strconv.Atoi(fields[0])
	seconds, _ = strconv.ParseFloat(fields[len(fields)-1], 64)
	return frames, seconds
}

func TestRecordingPlaysAndSkipsPasswords(t *testing.T) {
	provider := &clipProvider{frames: h264Frames(t, "320x240"), focus: make(chan *Focus, 1)}
	t.Cleanup(func() { close(provider.focus) })
	hub, dir := recordingHub(t, provider)
	state, err := hub.StartRecording("main", Recorder{UserID: "ada"}, false)
	if err != nil || state.ID == "" {
		t.Fatalf("start: %+v %v", state, err)
	}
	if info, _ := hub.Display("main"); info.Recording == nil || info.Recording.ID != state.ID || info.Viewers != nil {
		t.Fatalf("snapshot %+v", info)
	}
	time.Sleep(400 * time.Millisecond)
	provider.focus <- &Focus{Bounds: [4]float64{0.1, 0.1, 0.2, 0.05}, Password: true}
	time.Sleep(200 * time.Millisecond)
	provider.focus <- nil
	time.Sleep(600 * time.Millisecond)
	hub.StopRecordings()

	var meta RecordingMeta
	raw, err := os.ReadFile(filepath.Join(dir, state.ID, "meta.json"))
	if err != nil || json.Unmarshal(raw, &meta) != nil {
		t.Fatalf("meta: %v", err)
	}
	if meta.EndedAt == 0 || meta.Stop != "stopped" || len(meta.Files) != 1 || meta.Width != 320 || len(meta.Pauses) != 1 || meta.Pauses[0][1] == nil {
		t.Fatalf("meta %+v", meta)
	}
	frames, seconds := probe(t, filepath.Join(dir, state.ID, meta.Files[0].Name))
	if frames < 20 || frames >= 60 || seconds < 0.5 {
		t.Errorf("recorded %d frames over %.2fs", frames, seconds)
	}
	if info, _ := hub.Display("main"); info.Recording != nil {
		t.Errorf("a stopped recording still shows: %+v", info.Recording)
	}
}
