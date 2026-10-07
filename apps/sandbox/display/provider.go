package display

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
)

type ProviderConn struct {
	wire *wireConn

	mu    sync.Mutex
	calls map[uint64]context.CancelFunc
}

func NewProviderConn(rw io.ReadWriter, name string) (*ProviderConn, error) {
	conn := &ProviderConn{wire: newWireConn(rw), calls: map[uint64]context.CancelFunc{}}
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

// ProviderHandler answers one call. Its ctx ends with the answer, or when
// sandboxd cancels the call; work that outlives it needs its own.
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
		if message.Method == "cancel" {
			var cancel wireCancel
			if json.Unmarshal(message.Params, &cancel) == nil {
				p.mu.Lock()
				if stop := p.calls[cancel.ID]; stop != nil {
					stop()
				}
				p.mu.Unlock()
			}
			continue
		}
		callCtx, cancel := context.WithCancel(ctx)
		if message.ID != 0 {
			p.mu.Lock()
			p.calls[message.ID] = cancel
			p.mu.Unlock()
		}
		go p.answer(callCtx, cancel, *message, handle)
	}
}

func (p *ProviderConn) answer(ctx context.Context, cancel context.CancelFunc, call wireMessage, handle ProviderHandler) {
	defer func() {
		p.mu.Lock()
		delete(p.calls, call.ID)
		p.mu.Unlock()
		cancel()
	}()
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
