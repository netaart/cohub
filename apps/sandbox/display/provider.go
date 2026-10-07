package display

import (
	"context"
	"encoding/json"
	"errors"
	"io"
)

type ProviderConn struct {
	wire *wireConn
}

func NewProviderConn(rw io.ReadWriter, name string) (*ProviderConn, error) {
	conn := &ProviderConn{wire: newWireConn(rw)}
	if err := conn.wire.writeJSON(wireMessage{Type: "hello", Version: WireVersion, Name: name}); err != nil {
		return nil, err
	}
	return conn, nil
}

func (p *ProviderConn) SetDisplays(displays []Info) error {
	snapshot := append([]Info{}, displays...)
	return p.wire.writeJSON(wireMessage{Type: "displays", Displays: &snapshot})
}

func (p *ProviderConn) WriteSample(stream uint32, sample Sample) error {
	return p.wire.writeMedia(stream, sample)
}

func (p *ProviderConn) EndStream(stream uint32, reason *Error) error {
	return p.wire.writeJSON(wireMessage{Type: "ended", Stream: stream, Error: reason})
}

type ProviderHandler func(ctx context.Context, method string, params json.RawMessage) (any, error)

func (p *ProviderConn) Serve(ctx context.Context, handle ProviderHandler) error {
	for {
		message, _, err := p.wire.read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if message == nil || message.Type != "call" {
			continue
		}
		go p.answer(ctx, *message, handle)
	}
}

func (p *ProviderConn) answer(ctx context.Context, call wireMessage, handle ProviderHandler) {
	result, err := handle(ctx, call.Method, call.Params)
	if call.ID == 0 {
		return
	}
	reply := wireMessage{Type: "reply", ID: call.ID}
	if err != nil {
		var displayErr *Error
		if !errors.As(err, &displayErr) {
			displayErr = errorf(CodeFailed, "%v", err)
		}
		reply.Error = displayErr
	} else if result != nil {
		raw, marshalErr := json.Marshal(result)
		if marshalErr != nil {
			reply.Error = errorf(CodeFailed, "%v", marshalErr)
		} else {
			reply.Result = raw
		}
	}
	if err := p.wire.writeJSON(reply); err != nil && reply.Error == nil {
		_ = p.wire.writeJSON(wireMessage{Type: "reply", ID: call.ID, Error: errorf(CodeFailed, "the %s result could not be sent: %v", call.Method, err)})
	}
}
