package display

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type videoEncoder struct {
	name    string
	command func(ctx context.Context, fps, bitrate, maxSize int) *exec.Cmd
	live    bool
	failed  func()
}

const EncoderCommand = "__display-encoder"

type ffmpeg struct {
	path  string
	codec string // h264_videotoolbox or libx264
}

var (
	ffmpegOnce  sync.Once
	ffmpegFound *ffmpeg
)

func findFFmpeg() *ffmpeg {
	ffmpegOnce.Do(func() {
		path, err := exec.LookPath("ffmpeg")
		if err != nil {
			return
		}
		out, err := exec.Command(path, "-hide_banner", "-encoders").Output()
		if err != nil {
			return
		}
		encoders := string(out)
		switch {
		case runtime.GOOS == "darwin" && strings.Contains(encoders, " h264_videotoolbox "):
			ffmpegFound = &ffmpeg{path: path, codec: "h264_videotoolbox"}
		case strings.Contains(encoders, " libx264 "):
			ffmpegFound = &ffmpeg{path: path, codec: "libx264"}
		}
	})
	return ffmpegFound
}

const (
	// keyframeSeconds bounds how long a viewer that lost a packet, or joined
	// a running stream, waits: ffmpeg cannot insert a key frame on request.
	keyframeSeconds   = 2
	stillFrameSeconds = keyframeSeconds
)

func (f *ffmpeg) encoder(source func(fps int) []string) *videoEncoder {
	return &videoEncoder{name: "ffmpeg", command: func(ctx context.Context, fps, bitrate, maxSize int) *exec.Cmd {
		return exec.CommandContext(ctx, f.path, f.encodeArgs(source(fps), fps, bitrate, maxSize)...)
	}}
}

func (f *ffmpeg) encodeArgs(source []string, fps, bitrate, maxSize int) []string {
	rate := strconv.Itoa(bitrate)
	filters := fmt.Sprintf("scale='if(gte(iw,ih),min(%[1]d,iw),-2)':'if(gte(iw,ih),-2,min(%[1]d,ih))':flags=fast_bilinear,format=yuv420p,mpdecimate=max=%[2]d",
		maxSize, fps*stillFrameSeconds)
	args := append([]string{"-hide_banner", "-loglevel", "error", "-nostdin"}, source...)
	args = append(args, "-vf", filters, "-c:v", f.codec)
	if f.codec == "h264_videotoolbox" {
		args = append(args, "-realtime", "1", "-allow_sw", "1", "-profile:v", "baseline")
	} else {
		args = append(args, "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline")
	}
	return append(args,
		"-g", strconv.Itoa(fps*keyframeSeconds*5), "-bf", "0",
		"-force_key_frames", fmt.Sprintf("expr:gte(t,n_forced*%d)", keyframeSeconds),
		"-b:v", rate, "-maxrate", rate, "-bufsize", rate,
		"-flush_packets", "1", "-flvflags", "no_duration_filesize", "-f", "flv", "pipe:1",
	)
}

const (
	restartRatio    = 0.35
	restartInterval = 4 * time.Second
	stderrLimit     = 4 << 10
)

type encoderStream struct {
	encoders []*videoEncoder
	maxSize  int
	deliver  func(Sample) error
	logger   *slog.Logger

	mu         sync.Mutex
	bitrate    int
	fps        int
	runBitrate int
	runFPS     int
	startedAt  time.Time
	cancel     context.CancelFunc
	restart    *time.Timer
	control    io.Writer // the running live encoder's stdin
}

func (s *encoderStream) start(ctx context.Context, ended func(error)) {
	go func() {
		var err error
		for ctx.Err() == nil && len(s.encoders) > 0 {
			encoder := s.encoders[0]
			s.mu.Lock()
			runCtx, cancel := context.WithCancel(ctx)
			s.cancel, s.runBitrate, s.runFPS, s.startedAt = cancel, s.bitrate, s.fps, time.Now()
			bitrate, fps := s.bitrate, s.fps
			s.mu.Unlock()
			var frames int
			frames, err = s.run(runCtx, encoder, fps, bitrate)
			restarted := runCtx.Err() != nil && ctx.Err() == nil
			cancel()
			if restarted {
				continue
			}
			if frames == 0 && err != nil && encoder.failed != nil {
				encoder.failed()
			}
			if frames == 0 && err != nil && len(s.encoders) > 1 {
				s.logger.Warn("display encoder failed; trying the next", slog.String("encoder", encoder.name), slog.String("error", err.Error()))
				s.encoders = s.encoders[1:]
				continue
			}
			break
		}
		if ctx.Err() == nil {
			ended(err)
		}
	}()
}

func (s *encoderStream) run(ctx context.Context, encoder *videoEncoder, fps, bitrate int) (frames int, err error) {
	cmd := encoder.command(ctx, fps, bitrate, s.maxSize)
	stderr := &limitedBuffer{limit: stderrLimit}
	cmd.Stderr = stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 0, err
	}
	var control io.WriteCloser
	if encoder.live {
		if control, err = cmd.StdinPipe(); err != nil {
			return 0, err
		}
	}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	if control != nil {
		s.mu.Lock()
		s.control = control
		s.mu.Unlock()
		defer func() {
			s.mu.Lock()
			s.control = nil
			s.mu.Unlock()
		}()
	}
	reader := newFLVReader(stdout)
	for {
		sample, readErr := reader.next()
		if readErr != nil {
			break
		}
		frames++
		if err := s.deliver(sample); err != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			return frames, err
		}
	}
	if err := cmd.Wait(); err != nil && ctx.Err() == nil {
		return frames, fmt.Errorf("%s: %v %s", encoder.name, err, bytes.TrimSpace(stderr.Bytes()))
	}
	return frames, nil
}

func (s *encoderStream) tellLocked(format string, args ...any) bool {
	if s.control == nil {
		return false
	}
	_, _ = fmt.Fprintf(s.control, format+"\n", args...)
	return true
}

func (s *encoderStream) setBitrate(bps int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bitrate = bps
	if s.tellLocked("bitrate %d", bps) {
		return
	}
	change := float64(bps-s.runBitrate) / float64(max(1, s.runBitrate))
	if change > -restartRatio && change < restartRatio {
		return
	}
	s.scheduleRestartLocked()
}

func (s *encoderStream) setFPS(fps int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.fps = fps
	if !s.tellLocked("fps %d", fps) && fps != s.runFPS {
		s.scheduleRestartLocked()
	}
}

func (s *encoderStream) requestKeyframe() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tellLocked("keyframe")
}

func (s *encoderStream) scheduleRestartLocked() {
	if s.restart != nil || s.cancel == nil {
		return
	}
	wait := max(0, restartInterval-time.Since(s.startedAt))
	s.restart = time.AfterFunc(wait, func() {
		s.mu.Lock()
		s.restart = nil
		cancel := s.cancel
		s.mu.Unlock()
		cancel()
	})
}

func (s *encoderStream) reset() {
	s.mu.Lock()
	cancel := s.cancel
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *encoderStream) stop() {
	s.mu.Lock()
	if s.restart != nil {
		s.restart.Stop()
	}
	s.mu.Unlock()
}

type limitedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := b.limit - b.Len(); room > 0 {
		b.Buffer.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}
