package display

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"fmt"
	"os"

	"github.com/Eyevinn/mp4ff/avc"
	"github.com/Eyevinn/mp4ff/mp4"
)

const (
	mp4Timescale     = 1000
	mp4FragmentMs    = 2000
	mp4FinalSampleMs = 100
)

type mp4Writer struct {
	file    *os.File
	out     *bufio.Writer
	init    *mp4.InitSegment
	width   int
	height  int
	seq     uint32
	held    *mp4.FullSample
	samples []mp4.FullSample
	bytes   int64
}

type avcFrame struct {
	data          []byte
	sps, pps      []byte
	key           bool
	width, height int
}

func parseFrame(data []byte) (avcFrame, bool) {
	var frame avcFrame
	var out bytes.Buffer
	for _, unit := range splitNALs(data) {
		switch nalType(unit) {
		case nalAUD:
			continue
		case nalSPS:
			frame.sps = unit
		case nalPPS:
			frame.pps = unit
		case nalIDR:
			frame.key = true
		}
		_ = binary.Write(&out, binary.BigEndian, uint32(len(unit)))
		out.Write(unit)
	}
	if frame.sps != nil {
		sps, err := avc.ParseSPSNALUnit(frame.sps, false)
		if err != nil {
			return frame, false
		}
		frame.width, frame.height = int(sps.Width), int(sps.Height)
	}
	frame.data = out.Bytes()
	return frame, out.Len() > 0
}

func createMP4(path string, key avcFrame) (*mp4Writer, error) {
	if key.sps == nil || key.pps == nil {
		return nil, fmt.Errorf("a recording starts at a key frame with its parameter sets")
	}
	init := mp4.CreateEmptyInit()
	init.Moov.Mvex.AddChild(&mp4.MehdBox{Version: 1})
	init.Moov.Mvhd.Timescale = mp4Timescale
	trak := init.AddEmptyTrack(mp4Timescale, "video", "und")
	if err := trak.SetAVCDescriptor("avc1", [][]byte{key.sps}, [][]byte{key.pps}, true); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, err
	}
	w := &mp4Writer{file: file, out: bufio.NewWriterSize(file, 256<<10), init: init, width: key.width, height: key.height}
	if err := init.Encode(w.out); err != nil {
		file.Close()
		return nil, err
	}
	w.bytes = int64(init.Size())
	return w, nil
}

func (w *mp4Writer) add(frame avcFrame, ms uint64) error {
	if w.held != nil {
		w.held.Dur = uint32(max(1, since(ms, w.held.DecodeTime)))
		w.samples = append(w.samples, *w.held)
		if frame.key || since(ms, w.samples[0].DecodeTime) >= mp4FragmentMs {
			if err := w.flush(); err != nil {
				return err
			}
		}
	}
	flags := mp4.NonSyncSampleFlags
	if frame.key {
		flags = mp4.SyncSampleFlags
	}
	w.held = &mp4.FullSample{Sample: mp4.Sample{Flags: flags, Size: uint32(len(frame.data))}, DecodeTime: ms, Data: frame.data}
	return nil
}

func (w *mp4Writer) flush() error {
	if len(w.samples) == 0 {
		return nil
	}
	w.seq++
	fragment, err := mp4.CreateFragment(w.seq, 1)
	if err != nil {
		return err
	}
	for _, sample := range w.samples {
		fragment.AddFullSample(sample)
	}
	w.samples = w.samples[:0]
	if err := fragment.Encode(w.out); err != nil {
		return err
	}
	w.bytes += int64(fragment.Size())
	return w.out.Flush()
}

func (w *mp4Writer) close(ms uint64) error {
	if w.held != nil {
		w.held.Dur = uint32(max(mp4FinalSampleMs, since(ms, w.held.DecodeTime)))
		w.samples = append(w.samples, *w.held)
		ms = w.held.DecodeTime + uint64(w.held.Dur)
		w.held = nil
	}
	err := w.flush()
	if err == nil {
		err = w.writeDuration(ms)
	}
	if closeErr := w.file.Close(); err == nil {
		err = closeErr
	}
	return err
}

func (w *mp4Writer) writeDuration(ms uint64) error {
	w.init.Moov.Mvex.Mehd.FragmentDuration = int64(ms)
	var init bytes.Buffer
	if err := w.init.Encode(&init); err != nil {
		return err
	}
	_, err := w.file.WriteAt(init.Bytes(), 0)
	return err
}

func since(now, then uint64) uint64 {
	if now > then {
		return now - then
	}
	return 0
}
