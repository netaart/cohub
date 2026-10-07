package display

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"io"
)

var errFLV = errors.New("invalid FLV stream")

const (
	flvTagVideo     = 9
	flvCodecAVC     = 7
	flvFrameKey     = 1
	flvFrameInter   = 2
	flvAVCHeader    = 0
	flvAVCNALU      = 1
	flvTagHeaderLen = 11
)

type flvReader struct {
	r          *bufio.Reader
	started    bool
	sps, pps   []byte
	lengthSize int
}

func newFLVReader(r io.Reader) *flvReader {
	return &flvReader{r: bufio.NewReaderSize(r, 256<<10), lengthSize: 4}
}

func (f *flvReader) next() (Sample, error) {
	if !f.started {
		var header [9]byte
		if _, err := io.ReadFull(f.r, header[:]); err != nil {
			return Sample{}, err
		}
		if string(header[:3]) != "FLV" {
			return Sample{}, errFLV
		}
		if _, err := f.r.Discard(int(binary.BigEndian.Uint32(header[5:9])) - 9 + 4); err != nil {
			return Sample{}, err
		}
		f.started = true
	}
	for {
		var header [flvTagHeaderLen]byte
		if _, err := io.ReadFull(f.r, header[:]); err != nil {
			return Sample{}, err
		}
		size := int(header[1])<<16 | int(header[2])<<8 | int(header[3])
		ms := uint64(header[4])<<16 | uint64(header[5])<<8 | uint64(header[6]) | uint64(header[7])<<24
		data := make([]byte, size+4) // the tag, then the size of the previous one
		if _, err := io.ReadFull(f.r, data); err != nil {
			return Sample{}, err
		}
		data = data[:size]
		if header[0]&0x1f != flvTagVideo || len(data) < 5 || data[0]&0x0f != flvCodecAVC {
			continue
		}
		key := data[0]>>4 == flvFrameKey
		switch data[1] {
		case flvAVCHeader:
			if err := f.configure(data[5:]); err != nil {
				return Sample{}, err
			}
		case flvAVCNALU:
			unit, err := f.annexB(data[5:], key)
			if err != nil {
				return Sample{}, err
			}
			if len(unit) > 0 {
				return Sample{Data: unit, PTS: ms * 1000, Key: key}, nil
			}
		}
	}
}

func (f *flvReader) configure(record []byte) error {
	if len(record) < 7 {
		return errFLV
	}
	f.lengthSize = int(record[4]&3) + 1
	rest := record[5:]
	read := func(count int) ([]byte, error) {
		var first []byte
		for range count {
			if len(rest) < 2 {
				return nil, errFLV
			}
			n := int(binary.BigEndian.Uint16(rest))
			if len(rest) < 2+n {
				return nil, errFLV
			}
			if first == nil {
				first = bytes.Clone(rest[2 : 2+n])
			}
			rest = rest[2+n:]
		}
		return first, nil
	}
	count := int(rest[0] & 0x1f)
	rest = rest[1:]
	sps, err := read(count)
	if err != nil {
		return err
	}
	if len(rest) < 1 {
		return errFLV
	}
	count = int(rest[0])
	rest = rest[1:]
	pps, err := read(count)
	if err != nil {
		return err
	}
	f.sps, f.pps = sps, pps
	return nil
}

func (f *flvReader) annexB(payload []byte, key bool) ([]byte, error) {
	var out bytes.Buffer
	out.Grow(len(payload) + len(f.sps) + len(f.pps) + 16)
	if key && f.sps != nil && f.pps != nil {
		out.Write(startCode)
		out.Write(f.sps)
		out.Write(startCode)
		out.Write(f.pps)
	}
	for len(payload) > 0 {
		if len(payload) < f.lengthSize {
			return nil, errFLV
		}
		n := 0
		for _, b := range payload[:f.lengthSize] {
			n = n<<8 | int(b)
		}
		payload = payload[f.lengthSize:]
		if n > len(payload) {
			return nil, errFLV
		}
		if t := nalType(payload[:n]); n > 0 && t != nalSPS && t != nalPPS && t != nalAUD {
			out.Write(startCode)
			out.Write(payload[:n])
		}
		payload = payload[n:]
	}
	return out.Bytes(), nil
}

type flvWriter struct {
	w        io.Writer
	started  bool
	sps, pps []byte
}

func (f *flvWriter) writeFrame(ms uint32, key bool, sps, pps, avcc []byte) error {
	if !f.started {
		header := []byte{'F', 'L', 'V', 1, 1, 0, 0, 0, 9, 0, 0, 0, 0}
		if _, err := f.w.Write(header); err != nil {
			return err
		}
		f.started = true
	}
	if sps != nil && pps != nil && (!bytes.Equal(sps, f.sps) || !bytes.Equal(pps, f.pps)) {
		f.sps, f.pps = bytes.Clone(sps), bytes.Clone(pps)
		if len(sps) < 4 {
			return errFLV
		}
		record := []byte{1, sps[1], sps[2], sps[3], 0xff, 0xe1, byte(len(sps) >> 8), byte(len(sps))}
		record = append(record, sps...)
		record = append(record, 1, byte(len(pps)>>8), byte(len(pps)))
		record = append(record, pps...)
		if err := f.tag(ms, append([]byte{flvFrameKey<<4 | flvCodecAVC, flvAVCHeader, 0, 0, 0}, record...)); err != nil {
			return err
		}
	}
	frame := byte(flvFrameInter)
	if key {
		frame = flvFrameKey
	}
	return f.tag(ms, append([]byte{frame<<4 | flvCodecAVC, flvAVCNALU, 0, 0, 0}, avcc...))
}

func (f *flvWriter) tag(ms uint32, data []byte) error {
	size := len(data)
	header := []byte{flvTagVideo, byte(size >> 16), byte(size >> 8), byte(size), byte(ms >> 16), byte(ms >> 8), byte(ms), byte(ms >> 24), 0, 0, 0}
	trailer := binary.BigEndian.AppendUint32(nil, uint32(size+flvTagHeaderLen))
	for _, part := range [][]byte{header, data, trailer} {
		if _, err := f.w.Write(part); err != nil {
			return err
		}
	}
	return nil
}
