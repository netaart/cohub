package display

import (
	"cmp"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"time"
)

const (
	recordBitrate      = 1_500_000
	recordFPS          = 15
	recordBuffer       = 128
	passiveKeyPatience = 5 * time.Second
	recordMaxDuration  = 2 * time.Hour
	recordMaxBytes     = 2 << 30
	recordMinFree      = 1 << 30
	recordCheckEvery   = 15 * time.Second
	recordMaxGap       = 10 * time.Second
	autoRecordTail     = 15 * time.Second
)

type Recorder struct {
	UserID    string `json:"userId,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	TurnID    string `json:"turnId,omitempty"`
}

type Recording struct {
	ID     string `json:"id,omitempty"`
	Since  int64  `json:"since,omitempty"`
	Paused bool   `json:"paused,omitempty"`
	Auto   bool   `json:"auto,omitempty"`
}

func (r *Recording) equal(other *Recording) bool {
	if r == nil || other == nil {
		return r == other
	}
	return *r == *other
}

type recordingParams struct {
	Display   string     `json:"display"`
	Recording *Recording `json:"recording,omitempty"`
}

type RecordingFile struct {
	Name   string `json:"name"`
	At     int64  `json:"at"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

type RecordingMeta struct {
	ID       string          `json:"id"`
	Display  string          `json:"display"`
	Name     string          `json:"name,omitempty"`
	Platform string          `json:"platform,omitempty"`
	Width    int             `json:"width"`
	Height   int             `json:"height"`
	Since    int64           `json:"since"`
	EndedAt  int64           `json:"endedAt,omitempty"`
	By       *Recorder       `json:"by,omitempty"`
	Auto     bool            `json:"auto,omitempty"`
	Files    []RecordingFile `json:"files"`
	Pauses   [][2]*int64     `json:"pauses"`
	Turns    []string        `json:"turns"`
	Bytes    int64           `json:"bytes"`
	Stop     string          `json:"stop,omitempty"`
}

type recordControl struct {
	turn string
	stop string
}

type recording struct {
	hub     *Hub
	display string
	ctl     chan recordControl
	done    chan struct{}
	logger  *slog.Logger

	state     Recording
	automatic bool
	timer     *time.Timer
}

func newRecordingID() string {
	suffix := make([]byte, 3)
	_, _ = rand.Read(suffix)
	return time.Now().UTC().Format("20060102-150405") + "-" + hex.EncodeToString(suffix)
}

func (r *recording) send(control recordControl) {
	select {
	case r.ctl <- control:
	case <-r.done:
	}
}

func (h *Hub) StartRecording(display string, by Recorder, auto bool) (Recording, error) {
	h.mu.Lock()
	info, ok := h.displayLocked(display)
	switch {
	case !ok:
		h.mu.Unlock()
		return Recording{}, errorf(CodeNotFound, "display %q not found", display)
	case h.store == nil:
		h.mu.Unlock()
		return Recording{}, errorf(CodeUnsupported, "this machine keeps no recordings")
	case !info.Stream:
		h.mu.Unlock()
		return Recording{}, errorf(CodeUnavailable, "display %q has no video to record", display)
	}
	who := by
	if auto {
		h.autoRecord[display] = &who
	} else if current := h.recordings[display]; current != nil {
		current.automatic = false
		if current.timer != nil {
			current.timer.Stop()
			current.timer = nil
		}
	} else {
		h.startRecordingLocked(info, &who, false)
	}
	state := h.recordingLocked(display)
	h.publishUnlock()
	return *state, nil
}

func (h *Hub) StopRecording(display string, auto bool) Recording {
	h.mu.Lock()
	if auto {
		delete(h.autoRecord, display)
	}
	if current := h.recordings[display]; current != nil && (!auto || current.automatic) {
		h.endRecordingLocked(current, "stopped")
	}
	h.publishUnlock()
	return Recording{}
}

func (h *Hub) StopRecordings() {
	h.mu.Lock()
	current := make([]*recording, 0, len(h.recordings))
	for _, rec := range h.recordings {
		current = append(current, rec)
		h.endRecordingLocked(rec, "stopped")
	}
	h.publishUnlock()
	for _, rec := range current {
		select {
		case <-rec.done:
		case <-time.After(5 * time.Second):
		}
	}
}

func (h *Hub) startRecordingLocked(info Info, by *Recorder, auto bool) *recording {
	now := time.Now()
	rec := &recording{
		hub: h, display: info.ID, ctl: make(chan recordControl, 8), done: make(chan struct{}),
		logger:    h.logger.With(slog.String("display", info.ID)),
		state:     Recording{ID: newRecordingID(), Since: now.UnixMilli()},
		automatic: auto,
	}
	h.recordings[info.ID] = rec
	meta := RecordingMeta{
		ID: rec.state.ID, Display: info.ID, Name: info.Name, Platform: info.Platform, Width: info.Width, Height: info.Height,
		Since: rec.state.Since, By: by, Auto: auto, Files: []RecordingFile{}, Pauses: [][2]*int64{}, Turns: []string{},
	}
	go rec.run(h.store, meta)
	return rec
}

func (h *Hub) endRecordingLocked(rec *recording, reason string) {
	if h.recordings[rec.display] == rec {
		delete(h.recordings, rec.display)
	}
	if rec.timer != nil {
		rec.timer.Stop()
		rec.timer = nil
	}
	go rec.send(recordControl{stop: reason})
}

func (h *Hub) recordingLocked(display string) *Recording {
	by := h.autoRecord[display]
	if rec := h.recordings[display]; rec != nil {
		state := rec.state
		state.Auto = by != nil
		return &state
	}
	if by != nil {
		return &Recording{Auto: true}
	}
	return nil
}

func (h *Hub) recordingID(display string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if rec := h.recordings[display]; rec != nil {
		return rec.state.ID
	}
	return ""
}

func (h *Hub) planStarted(display, turn string) {
	h.mu.Lock()
	rec := h.recordings[display]
	if by := h.autoRecord[display]; rec == nil && by != nil && h.store != nil {
		if info, ok := h.displayLocked(display); ok && info.Stream {
			rec = h.startRecordingLocked(info, by, true)
		}
	}
	if rec == nil {
		h.mu.Unlock()
		return
	}
	if rec.timer != nil {
		rec.timer.Stop()
		rec.timer = nil
	}
	h.publishUnlock()
	if turn != "" {
		go rec.send(recordControl{turn: turn})
	}
}

func (h *Hub) planEnded(display string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	rec := h.recordings[display]
	if rec == nil || !rec.automatic {
		return
	}
	rec.timer = time.AfterFunc(autoRecordTail, func() {
		h.mu.Lock()
		if h.recordings[display] == rec && rec.timer != nil {
			h.endRecordingLocked(rec, "stopped")
		}
		h.publishUnlock()
	})
}

func (h *Hub) setRecordingPaused(rec *recording, paused bool) {
	h.mu.Lock()
	if h.recordings[rec.display] != rec || rec.state.Paused == paused {
		h.mu.Unlock()
		return
	}
	rec.state.Paused = paused
	h.publishUnlock()
}

func (h *Hub) private(display string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	focus := h.focus[display]
	return focus != nil && focus.Password || h.handovers[display] != nil || h.held[display]
}

type recordRun struct {
	rec    *recording
	store  *Store
	dir    string
	meta   RecordingMeta
	sub    *Subscriber
	writer *mp4Writer
	fileAt uint64

	clock    uint64
	lastPTS  uint64
	lastWall time.Time
	needKey  bool
	private  bool
	reason   string
}

func (r *recording) run(store *Store, meta RecordingMeta) {
	defer close(r.done)
	run := &recordRun{rec: r, store: store, meta: meta, needKey: true, reason: "stopped"}
	defer run.finish()
	dir, err := store.dir("recordings", meta.ID)
	if err != nil {
		r.logger.Warn("display recording unavailable", slog.String("error", err.Error()))
		run.reason = "failed"
		return
	}
	run.dir = dir
	store.pruneRecordings(meta.ID, 0)
	run.saveMeta()
	ctx, cancel := context.WithTimeout(context.Background(), startTimeout)
	run.sub, err = r.hub.subscribe(ctx, r.display, Viewer{}, true)
	cancel()
	if err != nil {
		r.logger.Warn("display recording cannot watch", slog.String("error", err.Error()))
		run.reason = "failed"
		return
	}
	check := time.NewTicker(recordCheckEvery)
	defer check.Stop()
	for {
		select {
		case control := <-r.ctl:
			if !run.control(control) {
				return
			}
		case sample := <-run.sub.Samples():
			if !run.sample(sample) {
				return
			}
		case <-run.sub.Done():
			run.reason = "display_ended"
			return
		case <-check.C:
			if !run.check() {
				return
			}
		}
	}
}

func (run *recordRun) control(control recordControl) bool {
	if control.stop != "" {
		run.reason = control.stop
		return false
	}
	if !slices.Contains(run.meta.Turns, control.turn) {
		run.meta.Turns = append(run.meta.Turns, control.turn)
		run.saveMeta()
	}
	return true
}

func (run *recordRun) sample(sample Sample) bool {
	now := time.Now()
	run.tick(sample.PTS, now)
	private := run.rec.hub.private(run.rec.display)
	if private != run.private {
		run.private = private
		run.pause(private)
		if !private {
			run.needKey = true
			run.sub.RequestKeyframe()
		}
	}
	if private || run.needKey && !sample.Key {
		return true
	}
	frame, ok := parseFrame(sample.Data)
	if !ok {
		return true
	}
	if frame.key && frame.sps != nil && (run.writer == nil || frame.width != run.writer.width || frame.height != run.writer.height) {
		if !run.open(frame) {
			return false
		}
	}
	if run.writer == nil {
		return true
	}
	run.needKey = false
	if err := run.writer.add(frame, run.clock-run.fileAt); err != nil {
		run.rec.logger.Warn("display recording write failed", slog.String("error", err.Error()))
		run.reason = "failed"
		return false
	}
	return true
}

func (run *recordRun) tick(pts uint64, now time.Time) {
	step := now.Sub(run.lastWall)
	if !run.lastWall.IsZero() && pts > run.lastPTS && time.Duration(pts-run.lastPTS)*time.Microsecond <= recordMaxGap {
		step = time.Duration(pts-run.lastPTS) * time.Microsecond
	}
	if !run.lastWall.IsZero() {
		run.clock += uint64(max(time.Millisecond, step).Milliseconds())
	} else {
		run.clock = uint64(now.UnixMilli() - run.meta.Since)
	}
	run.lastPTS, run.lastWall = pts, now
}

func (run *recordRun) open(frame avcFrame) bool {
	if run.writer != nil {
		run.closeFile()
	}
	name := filepathName(len(run.meta.Files))
	writer, err := createMP4(filepath.Join(run.dir, name), frame)
	if err != nil {
		run.rec.logger.Warn("display recording cannot start a file", slog.String("error", err.Error()))
		run.reason = "failed"
		return false
	}
	run.writer, run.fileAt = writer, run.clock
	run.meta.Files = append(run.meta.Files, RecordingFile{Name: name, At: run.meta.Since + int64(run.clock), Width: frame.width, Height: frame.height})
	run.meta.Width, run.meta.Height = frame.width, frame.height
	run.saveMeta()
	return true
}

func filepathName(index int) string {
	return fmt.Sprintf("%03d.mp4", index)
}

func (run *recordRun) closeFile() {
	if run.writer == nil {
		return
	}
	if err := run.writer.close(run.clock - run.fileAt); err != nil {
		run.rec.logger.Warn("display recording close failed", slog.String("error", err.Error()))
	}
	run.meta.Bytes += run.writer.bytes
	run.writer = nil
}

func (run *recordRun) pause(paused bool) {
	at := time.Now().UnixMilli()
	count := len(run.meta.Pauses)
	open := count > 0 && run.meta.Pauses[count-1][1] == nil
	switch {
	case paused && !open:
		run.meta.Pauses = append(run.meta.Pauses, [2]*int64{&at, nil})
	case !paused && open:
		run.meta.Pauses[count-1][1] = &at
	default:
		return
	}
	run.saveMeta()
	run.rec.hub.setRecordingPaused(run.rec, paused)
}

func (run *recordRun) bytes() int64 {
	total := run.meta.Bytes
	if run.writer != nil {
		total += run.writer.bytes
	}
	return total
}

func (run *recordRun) check() bool {
	if time.Since(time.UnixMilli(run.meta.Since)) > recordMaxDuration {
		run.reason = "limit"
		return false
	}
	if free, ok := freeBytes(run.dir); ok && free < recordMinFree {
		run.reason = "disk"
		return false
	}
	// Others may be recording at once, so what they hold is counted again each time.
	if run.store.pruneRecordings(run.meta.ID, run.bytes())+run.bytes() > recordMaxBytes {
		run.reason = "limit"
		return false
	}
	return true
}

func (run *recordRun) finish() {
	if run.sub != nil {
		run.sub.Close()
	}
	run.closeFile()
	if run.dir == "" {
		run.endState()
		return
	}
	now := time.Now().UnixMilli()
	if count := len(run.meta.Pauses); count > 0 && run.meta.Pauses[count-1][1] == nil {
		run.meta.Pauses[count-1][1] = &now
	}
	run.meta.EndedAt, run.meta.Stop = now, run.reason
	if len(run.meta.Files) == 0 {
		_ = os.RemoveAll(run.dir)
	} else {
		run.saveMeta()
	}
	run.rec.logger.Info("display recording ended", slog.String("id", run.meta.ID), slog.String("reason", run.reason), slog.Int64("bytes", run.meta.Bytes))
	run.endState()
}

func (run *recordRun) endState() {
	h := run.rec.hub
	h.mu.Lock()
	if h.recordings[run.rec.display] == run.rec {
		delete(h.recordings, run.rec.display)
	}
	h.publishUnlock()
}

func (run *recordRun) saveMeta() {
	meta := run.meta
	meta.Bytes = run.bytes()
	if err := writeJSON(filepath.Join(run.dir, "meta.json"), meta); err != nil {
		run.rec.logger.Warn("display recording meta failed", slog.String("error", err.Error()))
	}
}

func (s *Store) pruneRecordings(keep string, adding int64) int64 {
	dir, err := s.dir("recordings")
	if err != nil {
		return 0
	}
	entries, _ := os.ReadDir(dir)
	type held struct {
		path     string
		since    int64
		bytes    int64
		finished bool
	}
	var all []held
	var total int64
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == keep {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		bytes, _ := dirBytes(path)
		item := held{path: path, bytes: bytes}
		var meta RecordingMeta
		if raw, err := os.ReadFile(filepath.Join(path, "meta.json")); err == nil && json.Unmarshal(raw, &meta) == nil {
			item.since, item.finished = meta.Since, meta.EndedAt > 0
		}
		all = append(all, item)
		total += item.bytes
	}
	slices.SortFunc(all, func(a, b held) int { return cmp.Compare(a.since, b.since) })
	for _, item := range all {
		if total+adding <= recordMaxBytes {
			break
		}
		if item.finished && os.RemoveAll(item.path) == nil {
			total -= item.bytes
		}
	}
	return total
}

func (s *Store) recover() {
	dir := filepath.Join(s.root, "recordings")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name(), "meta.json")
		raw, err := os.ReadFile(path)
		var meta RecordingMeta
		if err != nil || json.Unmarshal(raw, &meta) != nil || meta.EndedAt > 0 {
			continue
		}
		meta.Stop = "failed"
		meta.Bytes, meta.EndedAt = dirBytes(filepath.Dir(path))
		meta.EndedAt = max(meta.EndedAt, meta.Since)
		_ = writeJSON(path, meta)
	}
}

func dirBytes(dir string) (total, modified int64) {
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if info, err := entry.Info(); err == nil && !entry.IsDir() {
			total += info.Size()
			modified = max(modified, info.ModTime().UnixMilli())
		}
	}
	return total, modified
}
