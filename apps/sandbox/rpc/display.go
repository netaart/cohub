package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/cohub/apps/sandbox/display"
	"github.com/cohub/apps/sandbox/protocol"
	"github.com/cohub/apps/sandbox/rtc"
)

// rtcIdentityPrefix limits viewer sessions to the API, which authorizes the
// viewer and mints its TURN credentials. The identity is what an authenticated
// caller declares, so this keeps other callers on their own paths rather than
// being a security boundary.
const rtcIdentityPrefix = "api-"

func managesVirtualScreen(identity string) bool {
	return strings.HasPrefix(identity, rtcIdentityPrefix) || identity == LocalIdentity
}

func (d *Dispatcher) SetDisplays(hub *display.Hub, sessions *rtc.Manager, virtual *display.Virtual) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.displays = hub
	d.sessions = sessions
	d.virtual = virtual
}

func (d *Dispatcher) displayServices() (*display.Hub, *rtc.Manager, *display.Virtual) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.displays, d.sessions, d.virtual
}

const virtualStartTimeout = 5 * time.Second

type displayListResult struct {
	Displays []display.Info `json:"displays"`
	Virtual  string         `json:"virtual,omitempty"`
}

func listDisplays(hub *display.Hub, virtual *display.Virtual) displayListResult {
	result := displayListResult{Displays: hub.Displays(), Virtual: hub.Virtual()}
	if virtual != nil {
		result.Virtual = "available"
		if virtual.Running() {
			result.Virtual = "running"
		}
	}
	return result
}

type displayInterruptResult struct {
	Activity *display.Activity `json:"activity,omitempty"`
}

type displayInputResult struct {
	Applied int `json:"applied"`
}

func (d *Dispatcher) handleDisplay(ctx context.Context, request protocol.RPCRequest, identity string) interface{} {
	hub, sessions, virtual := d.displayServices()
	if hub == nil {
		return d.failed(request, "", "UNSUPPORTED_METHOD", "displays are not enabled")
	}
	var (
		result interface{}
		err    error
	)
	switch request.Method {
	case "display.list":
		result = listDisplays(hub, virtual)
	case "display.tree":
		var params display.TreeParams
		if err = json.Unmarshal(request.Params, &params); err == nil {
			result, err = hub.Tree(ctx, params)
		}
	case "display.start", "display.stop":
		if !managesVirtualScreen(identity) {
			return d.failed(request, "", "ACCESS_DENIED", "virtual screens are managed through the API")
		}
		starting := request.Method == "display.start"
		var params struct {
			Size string `json:"size"`
		}
		_ = json.Unmarshal(request.Params, &params)
		switch {
		case virtual != nil && starting:
			err = virtual.Start(params.Size)
		case virtual != nil:
			virtual.Stop()
		case hub.Virtual() == "":
			return d.failed(request, "", "UNAVAILABLE", "this machine cannot run a virtual screen")
		case starting:
			err = hub.StartVirtual(ctx, params.Size)
		default:
			err = hub.StopVirtual(ctx)
		}
		// Answer once the hub has followed, so the list matches the screen.
		running := func() bool {
			if virtual != nil {
				return len(hub.Displays()) > 0
			}
			return hub.Virtual() == "running"
		}
		deadline := time.Now().Add(virtualStartTimeout)
		for err == nil && running() != starting && time.Now().Before(deadline) {
			time.Sleep(50 * time.Millisecond)
		}
		result = listDisplays(hub, virtual)
	case "display.capture":
		var params display.CaptureParams
		if err = json.Unmarshal(request.Params, &params); err == nil {
			result, err = hub.Capture(ctx, params)
		}
	case "display.input":
		var batch display.InputBatch
		if err = json.Unmarshal(request.Params, &batch); err == nil {
			if err = hub.Input(ctx, batch, display.InputScripted); err == nil {
				result = displayInputResult{Applied: len(batch.Events)}
			}
		}
	case "display.act":
		var params display.ActParams
		if err = json.Unmarshal(request.Params, &params); err == nil {
			result, err = hub.Act(ctx, params)
		}
	case "display.apps":
		var params display.AppsParams
		if err = json.Unmarshal(request.Params, &params); err == nil {
			result, err = hub.Apps(ctx, params)
		}
	case "display.interrupt":
		var params struct {
			Display string `json:"display"`
			Plan    string `json:"plan"`
		}
		if err = json.Unmarshal(request.Params, &params); err == nil {
			if params.Plan != "" {
				hub.CancelPlan(params.Plan)
				result = displayInterruptResult{}
			} else {
				stopped := hub.Stop(params.Display)
				result = displayInterruptResult{Activity: &stopped}
			}
		}
	case "display.handover":
		var params display.HandoverParams
		if err = json.Unmarshal(request.Params, &params); err == nil {
			result, err = hub.Handover(ctx, params)
		}
	case "display.handback":
		var params struct {
			Display string `json:"display"`
		}
		if err = json.Unmarshal(request.Params, &params); err == nil {
			err = hub.Handback(params.Display)
			result = struct{}{}
		}
	case "display.windows":
		var params display.AppsParams
		if err = json.Unmarshal(request.Params, &params); err == nil {
			result, err = hub.Windows(ctx, params.Display)
		}
	case "display.record.start":
		var params struct {
			Display string           `json:"display"`
			By      display.Recorder `json:"by"`
			Auto    bool             `json:"auto"`
		}
		if err = json.Unmarshal(request.Params, &params); err == nil {
			result, err = hub.StartRecording(params.Display, params.By, params.Auto)
		}
	case "display.record.stop":
		var params struct {
			Display string `json:"display"`
			Auto    bool   `json:"auto"`
		}
		if err = json.Unmarshal(request.Params, &params); err == nil {
			result = hub.StopRecording(params.Display, params.Auto)
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
	case display.CodePreempted:
		return "PREEMPTED"
	default:
		return "INTERNAL_ERROR"
	}
}
