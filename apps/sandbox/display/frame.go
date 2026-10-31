package display

import "encoding/binary"

func bgraToNV12(dst, src []byte, width, height int) {
	chroma := dst[width*height:]
	for y := 0; y < height; y++ {
		row := src[y*width*4 : (y+1)*width*4]
		luma := dst[y*width : (y+1)*width]
		for x := 0; x < width; x++ {
			b, g, r := int32(row[x*4]), int32(row[x*4+1]), int32(row[x*4+2])
			luma[x] = byte((66*r+129*g+25*b+128)>>8 + 16)
		}
		if y%2 != 0 {
			continue
		}
		plane := chroma[y/2*width : y/2*width+width]
		for x := 0; x < width; x += 2 {
			b, g, r := int32(row[x*4]), int32(row[x*4+1]), int32(row[x*4+2])
			plane[x] = byte((-38*r-74*g+112*b+128)>>8 + 128)
			plane[x+1] = byte((112*r-94*g-18*b+128)>>8 + 128)
		}
	}
}

func annexBFrame(data []byte) (avcc, sps, pps []byte, key bool) {
	avcc = make([]byte, 0, len(data)+16)
	for _, unit := range splitNALs(data) {
		switch nalType(unit) {
		case nalSPS:
			sps = unit
			continue
		case nalPPS:
			pps = unit
			continue
		case nalAUD:
			continue
		case nalIDR:
			key = true
		}
		avcc = binary.BigEndian.AppendUint32(avcc, uint32(len(unit)))
		avcc = append(avcc, unit...)
	}
	return avcc, sps, pps, key
}
