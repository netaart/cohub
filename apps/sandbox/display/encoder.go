package display

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

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

func (f *ffmpeg) encodeArgs(source []string, fps, bitrate, maxSize int) []string {
	rate := strconv.Itoa(bitrate)
	gop := strconv.Itoa(fps)
	limit := strconv.Itoa(maxSize)
	scale := fmt.Sprintf("scale='if(gte(iw,ih),min(%[1]s,iw),-2)':'if(gte(iw,ih),-2,min(%[1]s,ih))':flags=fast_bilinear,format=yuv420p", limit)
	args := append([]string{"-hide_banner", "-loglevel", "error", "-nostdin"}, source...)
	args = append(args, "-vf", scale, "-c:v", f.codec)
	if f.codec == "h264_videotoolbox" {
		args = append(args, "-realtime", "1", "-allow_sw", "1", "-profile:v", "baseline")
	} else {
		args = append(args, "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline")
	}
	return append(args,
		"-g", gop, "-keyint_min", gop, "-bf", "0",
		"-b:v", rate, "-maxrate", rate, "-bufsize", rate,
		"-bsf:v", "h264_metadata=aud=insert", "-f", "h264", "pipe:1",
	)
}

func (f *ffmpeg) encode(ctx context.Context, args []string, deliver func(Sample) error) error {
	cmd := exec.CommandContext(ctx, f.path, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	started := time.Now()
	var splitter accessUnitSplitter
	buffer := make([]byte, 64<<10)
	for {
		n, readErr := stdout.Read(buffer)
		for _, unit := range splitter.push(buffer[:n]) {
			if err := deliver(Sample{Data: unit, PTS: uint64(time.Since(started).Microseconds())}); err != nil {
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
				return err
			}
		}
		if readErr != nil {
			break
		}
	}
	if err := cmd.Wait(); err != nil && ctx.Err() == nil {
		return fmt.Errorf("ffmpeg: %v %s", err, bytes.TrimSpace(stderr.Bytes()))
	}
	return nil
}

const (
	restartRatio    = 0.35
	restartInterval = 4 * time.Second
)

type encoderStream struct {
	ffmpeg  *ffmpeg
	source  func() []string
	fps     int
	maxSize int
	deliver func(Sample) error

	mu        sync.Mutex
	bitrate   int
	running   int
	startedAt time.Time
	cancel    context.CancelFunc
	restart   *time.Timer
}

func (s *encoderStream) start(ctx context.Context, ended func(error)) {
	go func() {
		var err error
		for ctx.Err() == nil {
			s.mu.Lock()
			runCtx, cancel := context.WithCancel(ctx)
			s.cancel, s.running, s.startedAt = cancel, s.bitrate, time.Now()
			args := s.ffmpeg.encodeArgs(s.source(), s.fps, s.bitrate, s.maxSize)
			s.mu.Unlock()
			err = s.ffmpeg.encode(runCtx, args, s.deliver)
			restarted := runCtx.Err() != nil && ctx.Err() == nil
			cancel()
			if !restarted {
				break
			}
		}
		if ctx.Err() == nil {
			ended(err)
		}
	}()
}

func (s *encoderStream) setBitrate(bps int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bitrate = bps
	if s.restart != nil || s.cancel == nil {
		return
	}
	change := float64(bps-s.running) / float64(max(1, s.running))
	if change > -restartRatio && change < restartRatio {
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
