package display

import "bytes"

const (
	nalSlice = 1
	nalIDR   = 5
	nalSPS   = 7
	nalPPS   = 8
	nalAUD   = 9
)

var startCode = []byte{0, 0, 0, 1}

func splitNALs(data []byte) [][]byte {
	var units [][]byte
	start := -1
	for i := 0; i+2 < len(data); {
		if data[i] == 0 && data[i+1] == 0 && data[i+2] == 1 {
			if start >= 0 {
				end := i
				if end > start && data[end-1] == 0 {
					end-- // the zero of a four-byte start code
				}
				if end > start {
					units = append(units, data[start:end])
				}
			}
			i += 3
			start = i
			continue
		}
		i++
	}
	if start >= 0 && start < len(data) {
		units = append(units, data[start:])
	}
	return units
}

func nalType(unit []byte) byte {
	if len(unit) == 0 {
		return 0
	}
	return unit[0] & 0x1f
}

type parameterSets struct {
	sps, pps []byte
}

func (p *parameterSets) observe(data []byte) (idr bool) {
	for _, unit := range splitNALs(data) {
		switch nalType(unit) {
		case nalSPS:
			p.sps = append(p.sps[:0], unit...)
		case nalPPS:
			p.pps = append(p.pps[:0], unit...)
		case nalIDR:
			idr = true
		}
	}
	return idr
}

func (p *parameterSets) complete(data []byte) []byte {
	if p.sps == nil || p.pps == nil {
		return data
	}
	hasSPS, hasPPS := false, false
	for _, unit := range splitNALs(data) {
		switch nalType(unit) {
		case nalSPS:
			hasSPS = true
		case nalPPS:
			hasPPS = true
		}
	}
	if hasSPS && hasPPS {
		return data
	}
	var out bytes.Buffer
	out.Grow(len(data) + len(p.sps) + len(p.pps) + 8)
	out.Write(startCode)
	out.Write(p.sps)
	out.Write(startCode)
	out.Write(p.pps)
	out.Write(data)
	return out.Bytes()
}

func onlyParameterSets(data []byte) bool {
	units := splitNALs(data)
	if len(units) == 0 {
		return false
	}
	for _, unit := range units {
		switch nalType(unit) {
		case nalSPS, nalPPS, nalAUD:
		default:
			return false
		}
	}
	return true
}

type accessUnitSplitter struct {
	pending []byte
}

func (s *accessUnitSplitter) push(data []byte) [][]byte {
	if len(s.pending)+len(data) > maxFrameBytes {
		s.pending = s.pending[:0]
	}
	s.pending = append(s.pending, data...)
	var units [][]byte
	for {
		first := audIndex(s.pending, 0)
		if first < 0 {
			return units
		}
		next := audIndex(s.pending, first+4)
		if next < 0 {
			if first > 0 {
				s.pending = append(s.pending[:0], s.pending[first:]...)
			}
			return units
		}
		unit := make([]byte, next-first)
		copy(unit, s.pending[first:next])
		units = append(units, unit)
		s.pending = append(s.pending[:0], s.pending[next:]...)
	}
}

func audIndex(data []byte, from int) int {
	for i := from; i+3 < len(data); i++ {
		if data[i] == 0 && data[i+1] == 0 && data[i+2] == 1 && data[i+3]&0x1f == nalAUD {
			if i > 0 && data[i-1] == 0 {
				return i - 1
			}
			return i
		}
	}
	return -1
}
