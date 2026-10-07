package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/cohub/apps/sandbox/display"
	"github.com/cohub/apps/sandbox/protocol"
	"github.com/cohub/apps/sandbox/rtc"
)

// rtcIdentityPrefix limits viewer sessions to the API, which authorizes
// the viewer and mints its TURN credentials. The identity is what an
// authenticated caller declares, so this keeps other callers on their own
// paths rather than being a security boundary.
const rtcIdentityPrefix = "api-"

func (d *Dispatcher) SetDisplays(hub *display.Hub, sessions *rtc.Manager) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.displays = hub
	d.sessions = sessions
}

func (d *Dispatcher) displayServices() (*display.Hub, *rtc.Manager) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.displays, d.sessions
}

type displayListResult struct {
	Displays []display.Info `json:"displays"`
}

type displayInputResult struct {
	Applied int `json:"applied"`
}

func (d *Dispatcher) handleDisplay(request protocol.RPCRequest, identity string) interface{} {
	hub, sessions := d.displayServices()
	if hub == nil {
		return d.failed(request, "", "UNSUPPORTED_METHOD", "displays are not enabled")
	}
	ctx := context.Background()
	var (
		result interface{}
		err    error
	)
	switch request.Method {
	case "display.list":
		result = displayListResult{Displays: hub.Displays()}
	case "display.capture":
		var params display.CaptureParams
		if err = json.Unmarshal(request.Params, &params); err == nil {
			result, err = hub.Capture(ctx, params)
		}
	case "display.input":
		var batch display.InputBatch
		if err = json.Unmarshal(request.Params, &batch); err == nil {
			if err = hub.Input(ctx, batch); err == nil {
				result = displayInputResult{Applied: len(batch.Events)}
			}
		}
	case "rtc.open", "rtc.close":
		if !strings.HasPrefix(identity, rtcIdentityPrefix) {
			return d.failed(request, "", "ACCESS_DENIED", "viewer sessions are opened through the API")
		}
		result, err = sessions.Handle(ctx, request.Method, request.Params)
	}
	if err != nil {
		return d.failed(request, "", displayRPCCode(err), err.Error())
	}
	return result
}

func displayRPCCode(err error) string {
	var syntaxErr *json.SyntaxError
	var typeErr *json.UnmarshalTypeError
	if errors.As(err, &syntaxErr) || errors.As(err, &typeErr) {
		return "BAD_REQUEST"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "TIMEOUT"
	}
	switch display.ErrorCode(err) {
	case display.CodeInvalid:
		return "BAD_REQUEST"
	case display.CodeNotFound:
		return "NOT_FOUND"
	case display.CodeUnavailable, display.CodeUnsupported:
		return "UNAVAILABLE"
	case display.CodeBusy:
		return "BUSY"
	case display.CodeTimeout:
		return "TIMEOUT"
	default:
		return "INTERNAL_ERROR"
	}
}
