package display

import (
	"cmp"
	"slices"
	"time"

	"github.com/google/uuid"
)

type Point struct {
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Kind string  `json:"kind"`
}

type AgentPointer struct {
	SessionID string `json:"sessionId,omitempty"`
	Point
	Seq uint64 `json:"seq"`
}

type LoggedStep struct {
	Type  string `json:"type"`
	Label string `json:"label,omitempty"`
	At    int64  `json:"at"`
	Point *Point `json:"point,omitempty"`
	StepResult
}

type PlanLog struct {
	Plan      string       `json:"plan"`
	Display   string       `json:"display"`
	SessionID string       `json:"sessionId,omitempty"`
	TurnID    string       `json:"turnId"`
	At        int64        `json:"at"`
	EndedAt   int64        `json:"endedAt"`
	Width     int          `json:"width"`
	Height    int          `json:"height"`
	Steps     []LoggedStep `json:"steps"`
	Stopped   *LoggedStop  `json:"stopped,omitempty"`
	Image     string       `json:"image,omitempty"`
	Recording string       `json:"recording,omitempty"`
}

type LoggedStop struct {
	Step    int    `json:"step"`
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

func (r *actRun) pointOf(step Step, batch []InputEvent) *Point {
	if step.Type == "element" && r.tree != nil {
		ref := ""
		if len(batch) > 0 {
			ref = batch[0].Ref
		}
		if index := r.indexOf(ref); index >= 0 {
			kind := "click"
			switch step.Action {
			case "setText", "focus":
				kind = "type"
			case "scrollForward", "scrollBackward":
				kind = "scroll"
			}
			b := r.tree.Elements[index].Bounds
			return &Point{X: unit(b[0] + b[2]/2), Y: unit(b[1] + b[3]/2), Kind: kind}
		}
	}
	for _, event := range batch {
		switch {
		case event.Type == "pointer" && event.Action == "down" && event.X != nil:
			return &Point{X: *event.X, Y: *event.Y, Kind: "click"}
		case event.Type == "scroll" && event.X != nil:
			return &Point{X: *event.X, Y: *event.Y, Kind: "scroll"}
		case event.Type == "text" || event.Type == "key":
			if focus := r.hub.Focus(r.info.ID); focus != nil {
				b := focus.Bounds
				return &Point{X: unit(b[0] + b[2]/2), Y: unit(b[1] + b[3]/2), Kind: "type"}
			}
			return nil
		}
	}
	return nil
}

func readBack(step Step, target *StepTarget, after *Tree) bool {
	if step.Type != "element" || step.Action != "setText" || step.Text == nil || target == nil || after == nil {
		return false
	}
	return slices.ContainsFunc(after.Elements, func(e Element) bool {
		return e.Role == target.Role && e.Bounds == target.Bounds && !slices.Contains(e.States, "password") && e.Value == *step.Text
	})
}

func (r *actRun) logPlan(params ActParams) {
	store := r.hub.store
	if store == nil || len(r.logged) == 0 && r.result.Stopped == nil || r.actor.TurnID == "" {
		return
	}
	entry := PlanLog{
		Plan: cmp.Or(params.Plan, uuid.NewString()), Display: r.info.ID, SessionID: r.actor.SessionID, TurnID: r.actor.TurnID,
		At: r.started.UnixMilli(), EndedAt: time.Now().UnixMilli(), Width: r.info.Width, Height: r.info.Height, Steps: r.logged,
		Recording: r.hub.recordingID(r.info.ID),
	}
	if stopped := r.result.Stopped; stopped != nil {
		entry.Stopped = &LoggedStop{Step: stopped.Step, Reason: stopped.Reason, Message: stopped.Message}
	}
	image := r.result.Screen.Image
	if r.window != nil {
		image = nil
	}
	go store.logPlan(entry, image)
}

func (h *Hub) OnPointer(fn func(display string, pointer AgentPointer)) (cancel func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	id := h.nextListen
	h.nextListen++
	h.pointerTo[id] = fn
	return func() {
		h.mu.Lock()
		delete(h.pointerTo, id)
		h.mu.Unlock()
	}
}

func (h *Hub) point(display, session string, point Point) {
	h.mu.Lock()
	h.pointerSeq++
	pointer := AgentPointer{SessionID: session, Point: point, Seq: h.pointerSeq}
	listeners := make([]func(string, AgentPointer), 0, len(h.pointerTo))
	for _, fn := range h.pointerTo {
		listeners = append(listeners, fn)
	}
	h.mu.Unlock()
	for _, fn := range listeners {
		fn(display, pointer)
	}
}
