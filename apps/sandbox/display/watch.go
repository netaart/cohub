package display

import (
	"context"
	"time"
)

const (
	activityLinger = 30 * time.Second
	appsTimeout    = 15 * time.Second
	launchTimeout  = 15 * time.Second
)

type changeLog struct {
	watchers int
	seq      uint64
	at       time.Time
	signal   chan struct{}
}

func (h *Hub) changed(display string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	log := h.changes[display]
	if log == nil {
		return
	}
	log.seq++
	log.at = time.Now()
	close(log.signal)
	log.signal = make(chan struct{})
}

func (h *Hub) watchChanges(ctx context.Context, display string) (stop func()) {
	h.mu.Lock()
	log := h.changes[display]
	if log == nil {
		log = &changeLog{at: time.Now(), signal: make(chan struct{})}
		h.changes[display] = log
	}
	log.watchers++
	first, conn := log.watchers == 1, h.conn
	h.mu.Unlock()
	if first && conn != nil {
		_ = conn.call(ctx, "changes", changesParams{Display: display, Watch: true}, nil, callTimeout)
	}
	return func() {
		h.mu.Lock()
		log.watchers--
		last, conn := log.watchers == 0, h.conn
		if last {
			delete(h.changes, display)
		}
		h.mu.Unlock()
		if last && conn != nil {
			_ = conn.notify("changes", changesParams{Display: display, Watch: false})
		}
	}
}

type changesParams struct {
	Display string `json:"display"`
	Watch   bool   `json:"watch"`
}

func (h *Hub) changeState(display string) (seq uint64, at time.Time, signal <-chan struct{}) {
	h.mu.Lock()
	defer h.mu.Unlock()
	log := h.changes[display]
	if log == nil {
		return 0, time.Time{}, nil
	}
	return log.seq, log.at, log.signal
}

type activityState struct {
	activity Activity
	linger   *time.Timer
}

func (h *Hub) beginActivity(display string, activity Activity) {
	h.mu.Lock()
	current := h.activity[display]
	if current != nil && current.linger != nil {
		current.linger.Stop()
		current.linger = nil
	}
	if current != nil && current.activity == activity {
		h.mu.Unlock()
		return
	}
	h.activity[display] = &activityState{activity: activity}
	conn := h.conn
	h.publishUnlock()
	if conn != nil {
		_ = conn.notify("activity", activityParams{Display: display, Activity: &activity})
	}
}

func (h *Hub) endActivity(display string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	current := h.activity[display]
	if current == nil {
		return
	}
	if current.linger != nil {
		current.linger.Stop()
	}
	current.linger = time.AfterFunc(activityLinger, func() {
		h.mu.Lock()
		if h.activity[display] != current {
			h.mu.Unlock()
			return
		}
		delete(h.activity, display)
		conn := h.conn
		h.publishUnlock()
		if conn != nil {
			_ = conn.notify("activity", activityParams{Display: display})
		}
	})
}

type activityParams struct {
	Display  string    `json:"display"`
	Activity *Activity `json:"activity,omitempty"`
}

func (h *Hub) resume(conn *providerConn) {
	h.mu.Lock()
	var watched []string
	for display, log := range h.changes {
		if log.watchers > 0 {
			watched = append(watched, display)
		}
	}
	activities := make([]activityParams, 0, len(h.activity))
	for display, current := range h.activity {
		activity := current.activity
		activities = append(activities, activityParams{Display: display, Activity: &activity})
	}
	h.mu.Unlock()
	for _, display := range watched {
		_ = conn.notify("changes", changesParams{Display: display, Watch: true})
	}
	for _, params := range activities {
		_ = conn.notify("activity", params)
	}
}

func (h *Hub) acquire(ctx context.Context, display string) (release func(), err error) {
	h.mu.Lock()
	turn := h.acting[display]
	if turn == nil {
		turn = make(chan struct{}, 1)
		h.acting[display] = turn
	}
	h.mu.Unlock()
	select {
	case turn <- struct{}{}:
		return func() { <-turn }, nil
	case <-ctx.Done():
		return nil, errorf(CodeBusy, "another agent is acting on display %q", display)
	}
}

func (h *Hub) Virtual() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.virtual
}

func (h *Hub) StartVirtual(ctx context.Context, size string) error {
	conn, err := h.currentConn()
	if err != nil {
		return err
	}
	if h.Virtual() == "" {
		return errorf(CodeUnavailable, "this machine cannot start a virtual screen")
	}
	return conn.call(ctx, "virtual.start", struct {
		Size string `json:"size,omitempty"`
	}{size}, nil, startTimeout)
}

func (h *Hub) StopVirtual(ctx context.Context) error {
	conn, err := h.currentConn()
	if err != nil {
		return err
	}
	return conn.call(ctx, "virtual.stop", struct{}{}, nil, startTimeout)
}

type AppsParams struct {
	Display string `json:"display"`
}

type App struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type AppsResult struct {
	Apps []App `json:"apps"`
}

func (h *Hub) Apps(ctx context.Context, params AppsParams) (AppsResult, error) {
	if err := h.requireAbility(params.Display, func(info Info) bool { return info.Apps }, "apps"); err != nil {
		return AppsResult{}, err
	}
	conn, err := h.currentConn()
	if err != nil {
		return AppsResult{}, err
	}
	var result AppsResult
	if err := conn.call(ctx, "apps", params, &result, appsTimeout); err != nil {
		return AppsResult{}, err
	}
	apps := result.Apps[:0]
	for _, app := range result.Apps {
		if appIDPattern.MatchString(app.ID) && len(apps) < MaxApps {
			app.Name = clip(app.Name)
			apps = append(apps, app)
		}
	}
	return AppsResult{Apps: apps}, nil
}
