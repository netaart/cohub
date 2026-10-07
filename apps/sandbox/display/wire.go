package display

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

// Provider wire protocol, version 1.
//
// A provider is a server (a Unix socket, or an in-process pipe); sandboxd
// connects to it. Every frame is
//
//	u32 BE length of what follows | u8 kind | payload
//
// kind 1 carries one JSON message. kind 2 carries one encoded access unit:
//
//	u32 BE stream | u64 BE pts (µs) | u8 flags (1 = key frame) | H.264 Annex-B
//
// JSON messages:
//
//	provider → sandboxd  {"type":"hello","version":1,"name":"android"}   first frame
//	                     {"type":"displays","displays":[Info…]}          full snapshot, any time
//	                     {"type":"ended","stream":N,"error":{…}?}        a stream stopped on its own
//	                     {"type":"reply","id":N,"result":…|"error":{…}}  answers a call
//	sandboxd → provider  {"type":"call","id":N,"method":…,"params":…}    id 0 expects no reply
//
// Methods: stream.start {stream, display, codec, bitrate, fps, maxSize};
// stream.stop {stream}; stream.update {stream, bitrate}; stream.keyframe
// {stream}; capture CaptureParams → CaptureResult; input InputBatch.
const (
	WireVersion = 1

	frameJSON  byte = 1
	frameMedia byte = 2

	maxFrameBytes   = 16 << 20
	mediaHeaderSize = 4 + 8 + 1
	flagKey         = 1
)

type wireMessage struct {
	Type     string          `json:"type"`
	ID       uint64          `json:"id,omitempty"`
	Method   string          `json:"method,omitempty"`
	Params   json.RawMessage `json:"params,omitempty"`
	Result   json.RawMessage `json:"result,omitempty"`
	Error    *Error          `json:"error,omitempty"`
	Version  int             `json:"version,omitempty"`
	Name     string          `json:"name,omitempty"`
	Displays *[]Info         `json:"displays,omitempty"`
	Stream   uint32          `json:"stream,omitempty"`
}

type mediaFrame struct {
	stream uint32
	sample Sample
}

type wireConn struct {
	reader  *bufio.Reader
	writeMu sync.Mutex
	writer  io.Writer
	header  [5]byte
}

func newWireConn(rw io.ReadWriter) *wireConn {
	return &wireConn{reader: bufio.NewReaderSize(rw, 64<<10), writer: rw}
}

// write sends one piece of a frame. A failed write may leave half a frame
// behind, so it closes the connection rather than garble the next one.
func (c *wireConn) write(data []byte) error {
	_, err := c.writer.Write(data)
	if err != nil {
		if closer, ok := c.writer.(io.Closer); ok {
			_ = closer.Close()
		}
	}
	return err
}

const frameWriteTimeout = 10 * time.Second

func (c *wireConn) writeFrame(kind byte, parts ...[]byte) error {
	size := 1
	for _, part := range parts {
		size += len(part)
	}
	if size > maxFrameBytes {
		return fmt.Errorf("frame of %d bytes exceeds the limit", size)
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if conn, ok := c.writer.(interface{ SetWriteDeadline(time.Time) error }); ok {
		_ = conn.SetWriteDeadline(time.Now().Add(frameWriteTimeout))
	}
	binary.BigEndian.PutUint32(c.header[:4], uint32(size))
	c.header[4] = kind
	if err := c.write(c.header[:]); err != nil {
		return err
	}
	for _, part := range parts {
		if err := c.write(part); err != nil {
			return err
		}
	}
	return nil
}

func (c *wireConn) writeJSON(message wireMessage) error {
	raw, err := json.Marshal(message)
	if err != nil {
		return err
	}
	return c.writeFrame(frameJSON, raw)
}

func (c *wireConn) writeMedia(stream uint32, sample Sample) error {
	var header [mediaHeaderSize]byte
	binary.BigEndian.PutUint32(header[0:4], stream)
	binary.BigEndian.PutUint64(header[4:12], sample.PTS)
	if sample.Key {
		header[12] = flagKey
	}
	return c.writeFrame(frameMedia, header[:], sample.Data)
}

func (c *wireConn) read() (*wireMessage, *mediaFrame, error) {
	var header [5]byte
	if _, err := io.ReadFull(c.reader, header[:]); err != nil {
		return nil, nil, err
	}
	size := binary.BigEndian.Uint32(header[:4])
	if size < 1 || size > maxFrameBytes {
		return nil, nil, fmt.Errorf("invalid frame size %d", size)
	}
	payload := make([]byte, size-1)
	if _, err := io.ReadFull(c.reader, payload); err != nil {
		return nil, nil, err
	}
	switch header[4] {
	case frameJSON:
		var message wireMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			return nil, nil, fmt.Errorf("invalid message: %w", err)
		}
		return &message, nil, nil
	case frameMedia:
		if len(payload) < mediaHeaderSize {
			return nil, nil, errors.New("short media frame")
		}
		return nil, &mediaFrame{
			stream: binary.BigEndian.Uint32(payload[0:4]),
			sample: Sample{
				PTS:  binary.BigEndian.Uint64(payload[4:12]),
				Key:  payload[12]&flagKey != 0,
				Data: payload[mediaHeaderSize:],
			},
		}, nil
	default:
		// Unknown kinds are skipped so a newer provider can add some.
		return nil, nil, nil
	}
}

type StreamStart struct {
	Stream  uint32 `json:"stream"`
	Display string `json:"display"`
	Codec   string `json:"codec"`
	Bitrate int    `json:"bitrate"`
	FPS     int    `json:"fps"`
	MaxSize int    `json:"maxSize,omitempty"`
}

type StreamControl struct {
	Stream  uint32 `json:"stream"`
	Bitrate int    `json:"bitrate,omitempty"`
}
