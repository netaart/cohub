package display

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"math"
	"net/url"
	"slices"
	"strings"
	"time"
)

const (
	settleQuiet      = 300 * time.Millisecond
	settleMax        = 3 * time.Second
	settleBlind      = 500 * time.Millisecond // without change reports
	readGap          = 200 * time.Millisecond // between tree reads, however fast the screen moves
	pollWatched      = 250 * time.Millisecond
	pollBlind        = 500 * time.Millisecond
	actImageSize     = 1280
	actImageJPEG     = 80
	poorNamedLimit   = 3
	findPatience     = 3 * time.Second
	queuePatience    = 5 * time.Second
	maxTargetScrolls = 20
)

var pressMs = map[string]int{"click": 60, "longPress": 800}

type ActParams struct {
	Display string   `json:"display"`
	Plan    string   `json:"plan,omitempty"`
	Steps   []Step   `json:"steps"`
	Observe *Observe `json:"observe,omitempty"`
	Actor   *Actor   `json:"actor,omitempty"`
	Window  string   `json:"window,omitempty"`
}

type Actor struct {
	SessionID string `json:"sessionId"`
	TurnID    string `json:"turnId,omitempty"`
}

type Step struct {
	Type   string       `json:"type"`
	Target *Target      `json:"target,omitempty"`
	Action string       `json:"action,omitempty"`
	Text   *string      `json:"text,omitempty"`
	Events []InputEvent `json:"events,omitempty"`
	App    string       `json:"app,omitempty"`
	URL    string       `json:"url,omitempty"`
	MS     int          `json:"ms,omitempty"`
	Until  *Until       `json:"until,omitempty"`
	Label  string       `json:"label,omitempty"`
}

type Until struct {
	Text      string `json:"text,omitempty"`
	Gone      string `json:"gone,omitempty"`
	App       string `json:"app,omitempty"`
	Stable    bool   `json:"stable,omitempty"`
	TimeoutMs int    `json:"timeoutMs,omitempty"`
}

type Observe struct {
	Tree        string `json:"tree,omitempty"`  // actionable (default), full or none
	Image       string `json:"image,omitempty"` // auto (default), always or never
	MaxSize     int    `json:"maxSize,omitempty"`
	MaxElements int    `json:"maxElements,omitempty"`
}

type ActResult struct {
	Steps   []StepResult `json:"steps"`
	Stopped *ActStop     `json:"stopped,omitempty"`
	Screen  ActScreen    `json:"screen"`
	Window  *Window      `json:"window,omitempty"`
}

type StepResult struct {
	Effect   string      `json:"effect"`
	Target   *StepTarget `json:"target,omitempty"`
	ReadBack bool        `json:"readBack,omitempty"`
	FindMs   int         `json:"findMs"`
	ActMs    int         `json:"actMs"`
	WaitedMs int         `json:"waitedMs"`
}

type ActStop struct {
	Step       int       `json:"step"`
	Reason     string    `json:"reason"`
	Message    string    `json:"message"`
	Candidates []Element `json:"candidates,omitempty"`
	Hint       string    `json:"hint,omitempty"`
	Next       string    `json:"next,omitempty"`
}

type ActScreen struct {
	App       string         `json:"app,omitempty"`
	Quality   string         `json:"quality,omitempty"`
	Tree      *Tree          `json:"tree,omitempty"`
	Unchanged bool           `json:"unchanged,omitempty"`
	Image     *CaptureResult `json:"image,omitempty"`
}

type observation struct {
	session string
	tree    string
	screen  uint64
	shown   *Tree
}

func (p *ActParams) Validate() error {
	if len(p.Steps) > MaxActSteps {
		return errorf(CodeInvalid, "at most %d steps per plan", MaxActSteps)
	}
	for index, step := range p.Steps {
		if err := step.validate(); err != nil {
			return errorf(CodeInvalid, "step %d: %s", index+1, err.(*Error).Message)
		}
	}
	if p.Actor != nil && (!actorIDPattern.MatchString(p.Actor.SessionID) || p.Actor.TurnID != "" && !actorIDPattern.MatchString(p.Actor.TurnID)) {
		return errorf(CodeInvalid, "actor needs a session id and an optional Turn id, both UUIDs")
	}
	if p.Plan != "" && !actorIDPattern.MatchString(p.Plan) {
		return errorf(CodeInvalid, "plan must be a UUID")
	}
	if p.Window != "" && !windowIDPattern.MatchString(p.Window) {
		return errorf(CodeInvalid, "window must be a window id")
	}
	if p.Observe == nil {
		p.Observe = &Observe{}
	}
	o := p.Observe
	o.Tree, o.Image = cmp.Or(o.Tree, "compact"), cmp.Or(o.Image, "auto")
	switch {
	case !slices.Contains([]string{"compact", "full", "none"}, o.Tree):
		return errorf(CodeInvalid, "observe.tree must be compact, full or none")
	case !slices.Contains([]string{"auto", "always", "never"}, o.Image):
		return errorf(CodeInvalid, "observe.image must be auto, always or never")
	case o.MaxSize < 0 || o.MaxSize > MaxDimension:
		return errorf(CodeInvalid, "observe.maxSize must be within 1..%d", MaxDimension)
	case o.MaxElements < 0 || o.MaxElements > MaxTreeElements:
		return errorf(CodeInvalid, "observe.maxElements must be within 1..%d", MaxTreeElements)
	}
	return nil
}

func (s Step) validate() error {
	if textLen(s.Label) > MaxLabelLen {
		return errorf(CodeInvalid, "a label has at most %d characters", MaxLabelLen)
	}
	if s.Until != nil {
		if err := s.Until.validate(); err != nil {
			return err
		}
	}
	switch s.Type {
	case "element":
		if s.Target == nil {
			return errorf(CodeInvalid, "an element step needs a target")
		}
		if err := s.Target.validate(); err != nil {
			return err
		}
		if !elementActions[s.Action] {
			return errorf(CodeInvalid, "element action is not supported")
		}
		if (s.Action == "setText") != (s.Text != nil) || s.Text != nil && !validText(*s.Text) {
			return errorf(CodeInvalid, "text goes with setText only, of at most %d characters", MaxInputTextLen)
		}
	case "input":
		if err := (InputBatch{Events: s.Events}).Validate(); err != nil {
			return err
		}
	case "launch":
		if !appIDPattern.MatchString(s.App) {
			return errorf(CodeInvalid, "launch needs an app id")
		}
	case "open":
		parsed, err := url.Parse(s.URL)
		if err != nil || parsed.Scheme == "" || textLen(s.URL) > MaxUrlLen || strings.ContainsAny(s.URL, " \t\n") {
			return errorf(CodeInvalid, "open needs a URL of at most %d characters", MaxUrlLen)
		}
		if blockedSchemes[strings.ToLower(parsed.Scheme)] {
			return errorf(CodeInvalid, "open does not take file, content, data, javascript or intent URLs")
		}
	case "wait":
		if s.MS < 0 || s.MS > MaxWaitMs {
			return errorf(CodeInvalid, "wait ms must be within 1..%d", MaxWaitMs)
		}
	default:
		return errorf(CodeInvalid, "unknown step type %q", s.Type)
	}
	return nil
}

func (u Until) validate() error {
	switch {
	case u.Text == "" && u.Gone == "" && u.App == "" && !u.Stable:
		return errorf(CodeInvalid, "until needs text, gone, app or stable")
	case textLen(u.Text) > MaxElementText || textLen(u.Gone) > MaxElementText:
		return errorf(CodeInvalid, "until text has at most %d characters", MaxElementText)
	case u.App != "" && !appIDPattern.MatchString(u.App):
		return errorf(CodeInvalid, "until app must be an app id")
	case u.TimeoutMs < 0 || u.TimeoutMs > MaxUntilMs:
		return errorf(CodeInvalid, "until timeoutMs must be within 1..%d", MaxUntilMs)
	}
	return nil
}

func (u Until) needsTree() bool { return u.Text != "" || u.Gone != "" || u.App != "" }

func (h *Hub) Act(ctx context.Context, params ActParams) (ActResult, error) {
	if err := params.Validate(); err != nil {
		return ActResult{}, err
	}
	if _, ok := h.Display(params.Display); !ok {
		return ActResult{}, errorf(CodeNotFound, "display %q not found", params.Display)
	}
	ctx, cancelled := context.WithCancelCause(ctx)
	defer cancelled(nil)
	if params.Plan != "" {
		h.mu.Lock()
		if _, gone := h.plans[params.Plan]; gone {
			h.mu.Unlock()
			return ActResult{}, errCancelled
		}
		h.plans[params.Plan] = cancelled
		h.mu.Unlock()
		defer func() {
			h.mu.Lock()
			delete(h.plans, params.Plan)
			h.mu.Unlock()
		}()
	}
	waiting, stopWaiting := context.WithTimeout(ctx, queuePatience)
	release, err := h.acquire(waiting, params.Display)
	stopWaiting()
	if err != nil {
		return ActResult{}, err
	}
	defer release()
	info, err := h.runnable(params)
	if err != nil {
		return ActResult{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, MaxActMs*time.Millisecond)
	defer cancel()
	run := &actRun{hub: h, info: info, result: ActResult{Steps: []StepResult{}}, started: time.Now()}
	if params.Window != "" {
		window, err := h.window(ctx, info, params.Window)
		if err != nil {
			return ActResult{}, err
		}
		run.window = &window
		params.Steps = window.steps(params.Steps)
	}
	if info.Changes {
		defer h.watchChanges(ctx, params.Display)()
	}
	if params.Actor != nil {
		run.actor = Activity{SessionID: params.Actor.SessionID, TurnID: params.Actor.TurnID}
	}
	if len(params.Steps) > 0 {
		scripted, done, err := h.script(ctx, params.Display, params.Actor)
		if err != nil {
			run.stop(0, err)
		} else {
			defer done()
			defer h.endActivity(params.Display)
			h.planStarted(params.Display, run.actor.TurnID)
			defer h.planEnded(params.Display)
			run.ctx = scripted
			run.steps(params.Steps)
		}
	}
	observing, done := context.WithTimeout(context.WithoutCancel(ctx), callTimeout)
	defer done()
	run.ctx = observing
	if err := run.observe(*params.Observe, len(params.Steps) > 0); err != nil && len(run.result.Steps) == 0 && run.result.Stopped == nil {
		return ActResult{}, err
	}
	run.hint()
	run.inWindow()
	run.logPlan(params)
	return run.result, nil
}

func (h *Hub) runnable(params ActParams) (Info, error) {
	info, ok := h.Display(params.Display)
	switch {
	case !ok:
		return Info{}, errorf(CodeNotFound, "display %q not found", params.Display)
	case !info.Input && slices.ContainsFunc(params.Steps, func(step Step) bool { return step.Type != "wait" }):
		return Info{}, errorf(CodeUnavailable, "input is not available on display %q", params.Display)
	}
	for index, step := range params.Steps {
		byText := step.Target != nil && step.Target.Ref == ""
		if !info.Tree && (byText || step.Until != nil && step.Until.needsTree()) {
			return Info{}, errorf(CodeInvalid, "step %d: display %q has no element tree to find text on; use coordinates and until stable", index+1, params.Display)
		}
		if !info.Apps && (step.Type == "launch" || step.Type == "open") {
			return Info{}, errorf(CodeInvalid, "step %d: display %q does not launch apps or open links", index+1, params.Display)
		}
	}
	return info, nil
}

type actRun struct {
	hub     *Hub
	ctx     context.Context
	info    Info
	actor   Activity
	result  ActResult
	tree    *Tree // as last read: after the previous step
	readAt  time.Time
	changed bool
	window  *Window
	started time.Time
	logged  []LoggedStep
}

func (r *actRun) read() (*Tree, error) {
	r.readAt = time.Now()
	tree, err := r.hub.Tree(r.ctx, TreeParams{Display: r.info.ID, MaxElements: MaxTreeElements})
	if err != nil {
		r.tree = nil
		return nil, err
	}
	r.tree = &tree
	return r.tree, nil
}

func (r *actRun) current() (*Tree, error) {
	if r.tree != nil {
		return r.tree, nil
	}
	return r.read()
}

func (r *actRun) next(deadline time.Time) bool {
	_, _, signal := r.hub.changeState(r.info.ID)
	poll := pollBlind
	if signal != nil {
		poll = pollWatched
	}
	timer := time.NewTimer(min(poll, time.Until(deadline)))
	defer timer.Stop()
	select {
	case <-signal:
		sleep(r.ctx, min(time.Until(r.readAt.Add(readGap)), time.Until(deadline)))
	case <-timer.C:
	case <-r.ctx.Done():
		return false
	}
	return r.ctx.Err() == nil && time.Now().Before(deadline)
}

func (r *actRun) settle(limit time.Duration) bool {
	if !r.info.Changes {
		sleep(r.ctx, min(settleBlind, limit))
		return true
	}
	deadline := time.Now().Add(limit)
	started := time.Now()
	var last uint64
	for {
		_, at, signal := r.hub.changeState(r.info.ID)
		wait := time.Until(maxTime(at, started).Add(settleQuiet))
		if wait <= 0 {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		if r.info.Tree && time.Since(started) >= settleQuiet && time.Since(r.readAt) >= readGap {
			if tree, err := r.read(); err == nil {
				if now := signature(tree); now == last {
					return true
				} else {
					last = now
				}
			}
		}
		timer := time.NewTimer(min(wait, time.Until(deadline)))
		select {
		case <-signal:
		case <-timer.C:
		case <-r.ctx.Done():
			timer.Stop()
			return false
		}
		timer.Stop()
	}
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

func sleep(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
	}
}

func (r *actRun) steps(steps []Step) {
	for index, step := range steps {
		if step.Label != "" {
			r.actor.Label = step.Label
		}
		if r.ctx.Err() == nil {
			r.hub.beginActivity(r.info.ID, r.actor)
		}
		var before *Tree
		if r.info.Tree {
			before, _ = r.current()
		}
		seq, _, _ := r.hub.changeState(r.info.ID)
		started := time.Now()
		ref, ok := r.locate(index, step)
		if !ok {
			return
		}
		target, batch := r.aim(step, ref)
		if !r.changed && r.moved(index, step, target) {
			return
		}
		found := time.Now()
		point := r.pointOf(step, batch)
		if point != nil {
			r.hub.point(r.info.ID, r.actor.SessionID, *point)
		}
		if !r.perform(index, step, batch) {
			return
		}
		acted := time.Now()
		met := r.wait(step)
		result := StepResult{
			Target:   target,
			FindMs:   int(found.Sub(started).Milliseconds()),
			ActMs:    int(acted.Sub(found).Milliseconds()),
			WaitedMs: int(time.Since(acted).Milliseconds()),
		}
		var after *Tree
		if r.info.Tree {
			after, _ = r.read()
		}
		now, _, _ := r.hub.changeState(r.info.ID)
		pixels := r.info.Changes && now != seq && (step.Type != "element" || after == nil || quality(*after) != "good")
		result.Effect = effectOf(before, after, pixels)
		result.ReadBack = readBack(step, target, after)
		r.changed = r.changed || result.Effect != "none"
		r.result.Steps = append(r.result.Steps, result)
		r.logged = append(r.logged, LoggedStep{Type: step.Type, Label: step.Label, At: found.UnixMilli(), Point: point, StepResult: result})
		if err := context.Cause(r.ctx); err != nil {
			r.stop(index, err)
			return
		}
		if !met {
			r.result.Stopped = &ActStop{Step: index, Reason: "timeout", Message: fmt.Sprintf("step %d: %s did not come within %s", index+1, describeUntil(*step.Until), untilTimeout(*step.Until))}
			return
		}
		if index+1 < len(steps) && before != nil && after != nil && r.surprised(index, step, steps[index+1], before, after) {
			return
		}
	}
}

func (r *actRun) locate(index int, step Step) (string, bool) {
	if step.Type != "element" {
		return "", true
	}
	if step.Target.Ref != "" {
		return step.Target.Ref, true
	}
	element, err := r.find(index, step)
	if err != nil {
		r.stop(index, err)
		return "", false
	}
	return element.Ref, element.Ref != ""
}

// Touch screens get a real tap where the element shows: apps may ignore an accessibility click.
func (r *actRun) aim(step Step, ref string) (*StepTarget, []InputEvent) {
	switch step.Type {
	case "element":
		events := []InputEvent{{Type: "element", Ref: ref, Action: step.Action, Text: step.Text}}
		index := r.indexOf(ref)
		if index < 0 {
			return nil, events
		}
		if hold, ok := pressMs[step.Action]; ok && !r.info.Desktop && !typing(r.tree) {
			if x, y, ok := reachable(r.tree, index); ok {
				events = []InputEvent{pointerAt("down", x, y, 0), pointerAt("up", x, y, hold)}
			}
		}
		return targetAt(r.tree, index), events
	case "input":
		if x, y, ok := tapPoint(step); ok && r.tree != nil {
			return targetAt(r.tree, hit(r.tree, x, y)), step.Events
		}
		return nil, step.Events
	}
	return nil, nil
}

// A focused field may have a keyboard over the screen that the tree does not show.
func typing(tree *Tree) bool {
	return slices.ContainsFunc(tree.Elements, func(e Element) bool {
		return slices.Contains(e.States, "focused") && slices.Contains(e.States, "editable")
	})
}

func pointerAt(action string, x, y float64, t int) InputEvent {
	return InputEvent{Type: "pointer", Action: action, X: &x, Y: &y, T: &t}
}

func tapPoint(step Step) (float64, float64, bool) {
	if step.Type != "input" || len(step.Events) == 0 {
		return 0, 0, false
	}
	first := step.Events[0]
	if first.Type != "pointer" || first.Action != "down" || first.X == nil || first.Y == nil {
		return 0, 0, false
	}
	if slices.ContainsFunc(step.Events, func(event InputEvent) bool { return event.Type == "pointer" && event.Action == "move" }) {
		return 0, 0, false
	}
	return *first.X, *first.Y, true
}

func (r *actRun) indexOf(ref string) int {
	if r.tree == nil {
		return -1
	}
	byRef := func(elements []Element) int {
		return slices.IndexFunc(elements, func(e Element) bool { return e.Ref == ref })
	}
	if index := byRef(r.tree.Elements); index >= 0 {
		return index
	}
	seen := r.hub.shown(r.info.ID, r.actor.SessionID)
	if seen == nil {
		return -1
	}
	old := byRef(seen.Elements)
	if old < 0 {
		return -1
	}
	was := seen.Elements[old]
	return slices.IndexFunc(r.tree.Elements, func(e Element) bool {
		return e.Role == was.Role && e.Name == was.Name && e.Value == was.Value && e.Bounds == was.Bounds
	})
}

// moved stops a tap whose point no longer lands on what the session last saw there.
func (r *actRun) moved(index int, step Step, now *StepTarget) bool {
	x, y, ok := tapPoint(step)
	if !ok || now == nil {
		return false
	}
	seen := r.hub.shown(r.info.ID, r.actor.SessionID)
	if seen == nil {
		return false
	}
	was := targetAt(seen, hit(seen, x, y))
	if was == nil || was.Role == now.Role && was.Name == now.Name {
		return false
	}
	r.result.Stopped = &ActStop{Step: index, Reason: "moved",
		Message: fmt.Sprintf("step %d: the point now lands on %s, not on %s as last seen; run `look` again", index+1, now, was)}
	return true
}

func (r *actRun) perform(index int, step Step, events []InputEvent) bool {
	var err error
	switch step.Type {
	case "element", "input":
		err = r.hub.send(r.ctx, InputBatch{Display: r.info.ID, Events: events})
	case "launch", "open":
		err = r.hub.launch(r.ctx, r.info, step)
	case "wait":
		if step.MS > 0 {
			sleep(r.ctx, time.Duration(step.MS)*time.Millisecond)
		}
	}
	if err == nil {
		err = context.Cause(r.ctx)
	}
	if err != nil {
		r.stop(index, err)
		return false
	}
	return true
}

func (r *actRun) find(index int, step Step) (Element, error) {
	target := *step.Target
	deadline := time.Now().Add(findPatience)
	scrolls := 0
	for read := r.current; ; read = r.read {
		tree, err := read()
		if err != nil {
			return Element{}, err
		}
		element, candidates := resolve(*tree, target, step.Action)
		if element.Ref != "" {
			return element, nil
		}
		if target.Scroll && len(candidates) == 0 && scrolls < maxTargetScrolls && r.scrollOn(tree) {
			scrolls++
			continue
		}
		if r.next(deadline) {
			continue
		}
		if err := context.Cause(r.ctx); err != nil {
			return Element{}, err
		}
		if len(candidates) > 0 {
			r.result.Stopped = &ActStop{Step: index, Reason: "ambiguous", Candidates: candidates,
				Message: fmt.Sprintf("step %d: %d elements match %s; pick one with a ref or nth", index+1, len(candidates), target)}
		} else {
			r.result.Stopped = &ActStop{Step: index, Reason: "not_found", Message: fmt.Sprintf("step %d: nothing on the screen matches %s", index+1, target)}
		}
		return Element{}, nil
	}
}

func (r *actRun) scrollOn(tree *Tree) bool {
	list := scroller(*tree)
	if list.Ref == "" {
		return false
	}
	before := signature(tree)
	if err := r.hub.send(r.ctx, InputBatch{Display: r.info.ID, Events: []InputEvent{{Type: "element", Ref: list.Ref, Action: "scrollForward"}}}); err != nil {
		return false
	}
	r.settle(settleMax)
	after, err := r.read()
	return err == nil && signature(after) != before
}

func (r *actRun) wait(step Step) bool {
	if step.Until == nil {
		if step.Type != "wait" || step.MS == 0 {
			r.settle(settleMax)
		}
		return true
	}
	until := *step.Until
	deadline := time.Now().Add(untilTimeout(until))
	for r.ctx.Err() == nil {
		if until.needsTree() && !r.holds(until) {
			if !r.next(deadline) {
				return !until.Stable && r.ctx.Err() == nil && r.holds(until)
			}
			continue
		}
		if !until.Stable {
			return true
		}
		if !r.settle(time.Until(deadline)) {
			return false
		}
		if !until.needsTree() || r.holds(until) {
			return true
		}
	}
	return false
}

func (r *actRun) holds(until Until) bool {
	tree, err := r.read()
	if err != nil {
		return false
	}
	return (until.Text == "" || shows(*tree, until.Text)) &&
		(until.Gone == "" || !shows(*tree, until.Gone)) &&
		(until.App == "" || tree.App == until.App)
}

func shows(tree Tree, text string) bool {
	query := normalized(text)
	return slices.ContainsFunc(tree.Elements, func(element Element) bool { return visible(element) && matches(element, query, false) >= 0 })
}

func untilTimeout(until Until) time.Duration {
	if until.TimeoutMs > 0 {
		return time.Duration(until.TimeoutMs) * time.Millisecond
	}
	return DefaultUntilMs * time.Millisecond
}

func describeUntil(until Until) string {
	switch {
	case until.Text != "":
		return fmt.Sprintf("%q", until.Text)
	case until.Gone != "":
		return fmt.Sprintf("the end of %q", until.Gone)
	case until.App != "":
		return until.App
	}
	return "a still screen"
}

func (r *actRun) surprised(index int, step Step, next Step, before, after *Tree) bool {
	expected := step.Type == "launch" || step.Type == "open" || step.Until != nil && step.Until.App != ""
	if !expected && before.App != "" && after.App != "" && before.App != after.App && next.Type != "launch" && next.Type != "open" {
		r.result.Stopped = &ActStop{Step: index, Reason: "app_changed", Message: fmt.Sprintf("step %d: %s came to the front instead of %s", index+1, after.App, before.App)}
		return true
	}
	dialog := newDialog(before, after)
	if dialog < 0 || next.Type == "launch" || next.Type == "open" || next.Type == "wait" {
		return false
	}
	if next.Type == "element" && next.Target.Ref == "" {
		if element, _ := resolve(*after, *next.Target, next.Action); element.Ref != "" {
			if found := slices.IndexFunc(after.Elements, func(e Element) bool { return e.Ref == element.Ref }); within(after.Elements, dialog, found) {
				return false
			}
		}
	}
	name := after.Elements[dialog].Name
	r.result.Stopped = &ActStop{Step: index, Reason: "dialog", Message: fmt.Sprintf("step %d: a dialog %q opened over the screen", index+1, name)}
	return true
}

func newDialog(before, after *Tree) int {
	key := func(e Element) string { return e.Name + fmt.Sprint(e.Bounds) }
	seen := map[string]bool{}
	for _, element := range before.Elements {
		if element.Depth == 0 && element.Role == "dialog" {
			seen[key(element)] = true
		}
	}
	for index, element := range after.Elements {
		if element.Depth == 0 && element.Role == "dialog" && !seen[key(element)] {
			return index
		}
	}
	return -1
}

func effectOf(before, after *Tree, changed bool) string {
	if before != nil && after != nil {
		if before.App != after.App || rootName(before) != rootName(after) {
			return "navigated"
		}
		changed = changed || signature(before) != signature(after)
	}
	if changed {
		return "changed"
	}
	return "none"
}

func rootName(tree *Tree) string {
	for _, element := range tree.Elements {
		if element.Depth == 0 && element.Role == "window" {
			return element.Name
		}
	}
	return ""
}

func signature(tree *Tree) uint64 {
	hash := fnv.New64a()
	for _, e := range tree.Elements {
		fmt.Fprintf(hash, "%d|%s|%s|%s|%.3f,%.3f,%.3f,%.3f|%v\n", e.Depth, e.Role, e.Name, e.Value, e.Bounds[0], e.Bounds[1], e.Bounds[2], e.Bounds[3], e.States)
	}
	return hash.Sum64()
}

func (r *actRun) stop(index int, err error) {
	reason := "failed"
	var displayErr *Error
	switch {
	case errors.As(err, &displayErr) && displayErr == errInterrupted:
		reason = "interrupted"
	case errors.As(err, &displayErr) && displayErr.Code == CodePreempted:
		reason = "preempted"
	case errors.Is(err, context.DeadlineExceeded):
		reason, err = "timeout", fmt.Errorf("the plan ran out of its %s", MaxActMs*time.Millisecond)
	}
	message := err.Error()
	if displayErr != nil {
		message = displayErr.Message
	}
	r.result.Stopped = &ActStop{Step: index, Reason: reason, Message: fmt.Sprintf("step %d: %s", index+1, message)}
}

func (r *actRun) observe(o Observe, acted bool) error {
	screen := &r.result.Screen
	if r.info.Tree {
		tree, err := r.read()
		if err != nil {
			if !r.info.Capture || o.Image == "never" {
				return err
			}
			return r.observeImage(o)
		}
		screen.App = tree.App
		screen.Quality = quality(*tree)
		if o.Tree != "none" {
			now := observation{session: r.actor.SessionID, tree: o.Tree, screen: signature(tree), shown: tree}
			seen := r.hub.observe(r.info.ID, now)
			if acted && seen && now.session != "" && screen.Quality == "good" {
				screen.Unchanged = true
			} else {
				limit := cmp.Or(o.MaxElements, DefaultTreeElements)
				shown := *tree
				if r.window != nil {
					shown = r.window.tree(shown)
				}
				if o.Tree == "compact" {
					shown = shown.compact(limit)
				} else {
					shown = shown.sanitize(limit)
				}
				screen.Tree = &shown
			}
		}
	}
	if o.Image == "always" || o.Image == "auto" && screen.Quality != "good" {
		return r.observeImage(o)
	}
	return nil
}

func (r *actRun) observeImage(o Observe) error {
	if !r.info.Capture {
		return nil
	}
	params := CaptureParams{Display: r.info.ID, MaxSize: cmp.Or(o.MaxSize, actImageSize), Quality: actImageJPEG}
	if r.window != nil {
		params.Region = r.window.region()
	}
	image, err := r.hub.capture(r.ctx, params)
	if err != nil {
		return err
	}
	screen := &r.result.Screen
	if screen.Tree == nil && !screen.Unchanged {
		r.hub.forget(r.info.ID)
	}
	screen.Image = &image
	return nil
}

func (h *Hub) observe(display string, now observation) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	was := h.observed[display]
	h.observed[display] = now
	return was.session == now.session && was.tree == now.tree && was.screen == now.screen
}

func (h *Hub) forget(display string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if seen, ok := h.observed[display]; ok {
		seen.shown = nil
		h.observed[display] = seen
	}
}

func (h *Hub) shown(display, session string) *Tree {
	h.mu.Lock()
	defer h.mu.Unlock()
	if seen, ok := h.observed[display]; ok && seen.session == session {
		return seen.shown
	}
	return nil
}

func quality(tree Tree) string {
	named, actions, unnamed := 0, 0, 0
	for _, element := range tree.Elements {
		if element.Depth == 0 || !visible(element) {
			continue
		}
		if element.Name != "" || element.Value != "" {
			named++
		}
		if len(element.Actions) > 0 {
			actions++
			if element.Name == "" && !namesInside(tree.Elements, element) {
				unnamed++
			}
		}
	}
	if named < poorNamedLimit || actions >= 4 && float64(unnamed) > math.Ceil(float64(actions)/2) {
		return "poor"
	}
	return "good"
}

func namesInside(elements []Element, element Element) bool {
	root := slices.IndexFunc(elements, func(e Element) bool { return e.Ref == element.Ref })
	for i := root + 1; i < len(elements) && elements[i].Depth > element.Depth; i++ {
		if elements[i].Name != "" {
			return true
		}
	}
	return false
}

func (h *Hub) launch(ctx context.Context, info Info, step Step) error {
	if !info.Apps {
		return errorf(CodeUnsupported, "display %q does not launch apps or open links", info.ID)
	}
	conn, err := h.currentConn()
	if err != nil {
		return err
	}
	params := struct {
		Display string `json:"display"`
		App     string `json:"app,omitempty"`
		URL     string `json:"url,omitempty"`
	}{info.ID, step.App, step.URL}
	return conn.call(ctx, step.Type, params, nil, launchTimeout)
}
