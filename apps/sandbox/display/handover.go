package display

import (
	"context"
	"time"
)

const (
	handoverWaiting  = "waiting"
	handoverReturned = "returned"
	handoverStopped  = "stopped"
	handoverExpired  = "expired"
	handoverGone     = "gone"

	handoverLeaseGrace  = 15 * time.Second
	cancelledPlanMemory = time.Minute
)

type Handover struct {
	Reason    string `json:"reason"`
	SessionID string `json:"sessionId,omitempty"`
	TurnID    string `json:"turnId,omitempty"`
}

func (a *Handover) equal(b *Handover) bool {
	return a == b || a != nil && b != nil && *a == *b
}

type HandoverParams struct {
	Display   string `json:"display"`
	ID        string `json:"id"`
	Reason    string `json:"reason"`
	TimeoutMs int    `json:"timeoutMs,omitempty"`
	WaitMs    int    `json:"waitMs,omitempty"`
	Actor     *Actor `json:"actor,omitempty"`
}

type HandoverResult struct {
	State string `json:"state"`
	Held  bool   `json:"held,omitempty"`
}

func (p HandoverParams) validate() error {
	switch {
	case !actorIDPattern.MatchString(p.ID):
		return errorf(CodeInvalid, "a handover needs a UUID id")
	case p.Reason == "" || textLen(p.Reason) > MaxLabelLen:
		return errorf(CodeInvalid, "a handover needs a reason of at most %d characters", MaxLabelLen)
	case p.TimeoutMs < 0 || p.TimeoutMs > MaxHandoverMs:
		return errorf(CodeInvalid, "timeoutMs must be within 1..%d", MaxHandoverMs)
	case p.WaitMs < 0 || p.WaitMs > MaxHandoverWaitMs:
		return errorf(CodeInvalid, "waitMs must be within 0..%d", MaxHandoverWaitMs)
	case p.Actor != nil && (!actorIDPattern.MatchString(p.Actor.SessionID) || p.Actor.TurnID != "" && !actorIDPattern.MatchString(p.Actor.TurnID)):
		return errorf(CodeInvalid, "actor needs a session id and an optional Turn id, both UUIDs")
	}
	return nil
}

type handover struct {
	id       string
	info     Handover
	deadline time.Time
	lease    time.Time
	timer    *time.Timer
	done     chan struct{}
}

type finishedHandover struct {
	id     string
	result HandoverResult
}

type handoverParams struct {
	Display  string    `json:"display"`
	Handover *Handover `json:"handover,omitempty"`
}

func (h *Hub) Handover(ctx context.Context, params HandoverParams) (HandoverResult, error) {
	if err := params.validate(); err != nil {
		return HandoverResult{}, err
	}
	h.mu.Lock()
	if _, known := h.displayLocked(params.Display); !known {
		h.mu.Unlock()
		return HandoverResult{}, errorf(CodeNotFound, "display %q not found", params.Display)
	}
	if last := h.handedOver[params.Display]; last.id == params.ID {
		h.mu.Unlock()
		return last.result, nil
	}
	current := h.handovers[params.Display]
	if current != nil && current.id != params.ID {
		h.mu.Unlock()
		return HandoverResult{}, errorf(CodeBusy, "display %q is already waiting for a person", params.Display)
	}
	created := current == nil
	if created {
		timeout := DefaultHandoverMs
		if params.TimeoutMs > 0 {
			timeout = params.TimeoutMs
		}
		current = &handover{id: params.ID, info: Handover{Reason: clip(params.Reason)}, deadline: time.Now().Add(time.Duration(timeout) * time.Millisecond), done: make(chan struct{})}
		if params.Actor != nil {
			current.info.SessionID, current.info.TurnID = params.Actor.SessionID, params.Actor.TurnID
		}
		h.handovers[params.Display] = current
	}
	wait := time.Duration(params.WaitMs) * time.Millisecond
	if wait > 0 {
		current.lease = time.Now().Add(wait + handoverLeaseGrace)
	}
	h.armHandoverLocked(params.Display, current)
	done := current.done
	if created {
		conn, info := h.conn, current.info
		h.publishUnlock()
		h.interrupt(params.Display, errWaiting)
		if conn != nil {
			_ = conn.notify("handover", handoverParams{Display: params.Display, Handover: &info})
		}
	} else {
		h.mu.Unlock()
	}
	if wait > 0 {
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case <-done:
		case <-timer.C:
		case <-ctx.Done():
		}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if last := h.handedOver[params.Display]; last.id == params.ID {
		return last.result, nil
	}
	return HandoverResult{State: handoverWaiting, Held: h.held[params.Display]}, nil
}

func (c *handover) end() time.Time {
	if !c.lease.IsZero() && c.lease.Before(c.deadline) {
		return c.lease
	}
	return c.deadline
}

func (h *Hub) armHandoverLocked(display string, current *handover) {
	if current.timer != nil {
		current.timer.Stop()
	}
	current.timer = time.AfterFunc(time.Until(current.end()), func() {
		h.mu.Lock()
		if h.handovers[display] != current || time.Now().Before(current.end()) {
			h.mu.Unlock()
			return
		}
		h.finishHandoverLocked(display, current, handoverExpired)
		conn := h.conn
		h.publishUnlock()
		if conn != nil {
			_ = conn.notify("handover", handoverParams{Display: display})
		}
	})
}

func (h *Hub) finishHandoverLocked(display string, current *handover, state string) {
	if current.timer != nil {
		current.timer.Stop()
	}
	delete(h.handovers, display)
	h.handedOver[display] = finishedHandover{id: current.id, result: HandoverResult{State: state, Held: h.held[display]}}
	close(current.done)
}

func (h *Hub) Handback(display string) error {
	h.mu.Lock()
	current := h.handovers[display]
	if current == nil {
		h.mu.Unlock()
		return nil
	}
	if h.held[display] {
		h.mu.Unlock()
		return errorf(CodeUnavailable, "a person holds display %q; they hand it back there", display)
	}
	h.finishHandoverLocked(display, current, handoverReturned)
	conn := h.conn
	h.publishUnlock()
	if conn != nil {
		_ = conn.notify("handover", handoverParams{Display: display})
	}
	return nil
}

func (h *Hub) CancelPlan(plan string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if cancel, running := h.plans[plan]; running {
		if cancel != nil {
			cancel(errCancelled)
		}
		return
	}
	h.plans[plan] = nil
	time.AfterFunc(cancelledPlanMemory, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.plans[plan] == nil {
			delete(h.plans, plan)
		}
	})
}
