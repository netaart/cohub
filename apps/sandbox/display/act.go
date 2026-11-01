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
	settleQuiet    = 300 * time.Millisecond
	settleMax      = 3 * time.Second
	settleBlind    = 500 * time.Millisecond // without change reports
	readGap        = 200 * time.Millisecond // between tree reads, however fast the screen moves
	pollWatched    = 250 * time.Millisecond
	pollBlind      = 500 * time.Millisecond
	actImageSize   = 1280
	actImageJPEG   = 80
	poorNamedLimit = 3
	findPatience   = 3 * time.Second
)

type ActParams struct {
	Display string   `json:"display"`
	Steps   []Step   `json:"steps"`
	Observe *Observe `json:"observe,omitempty"`
	Actor   *Actor   `json:"actor,omitempty"`
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
}

type StepResult struct {
	Effect   string `json:"effect"`
	WaitedMs int    `json:"waitedMs"`
}

type ActStop struct {
	Step       int       `json:"step"`
	Reason     string    `json:"reason"`
	Message    string    `json:"message"`
	Candidates []Element `json:"candidates,omitempty"`
}

type ActScreen struct {
	App     string         `json:"app,omitempty"`
	Quality string         `json:"quality,omitempty"`
	Tree    *Tree          `json:"tree,omitempty"`
	Image   *CaptureResult `json:"image,omitempty"`
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
	if p.Observe == nil {
		p.Observe = &Observe{}
	}
	o := p.Observe
	o.Tree, o.Image = cmp.Or(o.Tree, "actionable"), cmp.Or(o.Image, "auto")
	switch {
	case !slices.Contains([]string{"actionable", "full", "none"}, o.Tree):
		return errorf(CodeInvalid, "observe.tree must be actionable, full or none")
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
	waiting, stopWaiting := context.WithTimeout(ctx, MaxActMs*time.Millisecond)
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
	if info.Changes {
		defer h.watchChanges(ctx, params.Display)()
	}
	run := &actRun{hub: h, info: info, result: ActResult{Steps: []StepResult{}}}
	if len(params.Steps) > 0 {
		run.actor = Activity{}
		if params.Actor != nil {
			run.actor = Activity{SessionID: params.Actor.SessionID, TurnID: params.Actor.TurnID}
		}
		scripted, done, err := h.script(ctx, params.Display)
		if err != nil {
			run.stop(0, err)
		} else {
			defer done()
			defer h.endActivity(params.Display)
			run.ctx = scripted
			run.steps(params.Steps)
		}
	}
	observing, done := context.WithTimeout(context.WithoutCancel(ctx), callTimeout)
	defer done()
	run.ctx = observing
	if err := run.observe(*params.Observe); err != nil && len(run.result.Steps) == 0 && run.result.Stopped == nil {
		return ActResult{}, err
	}
	return run.result, nil
}

func (h *Hub) runnable(params ActParams) (Info, error) {
	info, ok := h.Display(params.Display)
	switch {
	case !ok:
		return Info{}, errorf(CodeNotFound, "display %q not found", params.Display)
	case len(params.Steps) > 0 && !info.Input:
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
	hub    *Hub
	ctx    context.Context
	info   Info
	actor  Activity
	result ActResult
	tree   *Tree // as last read: after the previous step
	readAt time.Time
}

func (r *actRun) read() (*Tree, error) {
	r.readAt = time.Now()
	tree, err := r.hub.Tree(r.ctx, TreeParams{Display: r.info.ID, MaxElements: MaxTreeElements})
	if err != nil {
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
		r.hub.beginActivity(r.info.ID, r.actor)
		var before *Tree
		if r.info.Tree {
			before, _ = r.current()
		}
		seq, _, _ := r.hub.changeState(r.info.ID)
		if !r.perform(index, step) {
			return
		}
		acted := time.Now()
		met := r.wait(step)
		result := StepResult{WaitedMs: int(time.Since(acted).Milliseconds())}
		var after *Tree
		if r.info.Tree {
			after, _ = r.read()
		}
		now, _, _ := r.hub.changeState(r.info.ID)
		result.Effect = effectOf(before, after, r.info.Changes && now != seq)
		r.result.Steps = append(r.result.Steps, result)
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

func (r *actRun) perform(index int, step Step) bool {
	var err error
	switch step.Type {
	case "element":
		ref := step.Target.Ref
		if ref == "" {
			var element Element
			if element, err = r.find(index, *step.Target); err != nil {
				r.stop(index, err)
				return false
			}
			if element.Ref == "" {
				return false
			}
			ref = element.Ref
		}
		err = r.hub.send(r.ctx, InputBatch{Display: r.info.ID, Events: []InputEvent{{Type: "element", Ref: ref, Action: step.Action, Text: step.Text}}})
	case "input":
		err = r.hub.send(r.ctx, InputBatch{Display: r.info.ID, Events: step.Events})
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

func (r *actRun) find(index int, target Target) (Element, error) {
	deadline := time.Now().Add(findPatience)
	for read := r.current; ; read = r.read {
		tree, err := read()
		if err != nil {
			return Element{}, err
		}
		element, candidates := resolve(*tree, target)
		if element.Ref != "" {
			return element, nil
		}
		if !r.next(deadline) {
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
	return slices.ContainsFunc(tree.Elements, func(element Element) bool { return visible(element) && matches(element, query) >= 0 })
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
		if element, _ := resolve(*after, *next.Target); element.Ref != "" {
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

func (r *actRun) observe(o Observe) error {
	screen := &r.result.Screen
	if r.info.Tree {
		tree, err := r.read()
		if err != nil {
			return err
		}
		screen.App = tree.App
		screen.Quality = quality(*tree)
		if o.Tree != "none" {
			limit := cmp.Or(o.MaxElements, DefaultTreeElements)
			shown := *tree
			if o.Tree == "actionable" {
				shown = shown.actionable(limit)
			} else {
				shown = shown.sanitize(limit)
			}
			screen.Tree = &shown
		}
	}
	if o.Image == "always" || o.Image == "auto" && screen.Quality != "good" {
		if !r.info.Capture {
			return nil
		}
		image, err := r.hub.Capture(r.ctx, CaptureParams{Display: r.info.ID, MaxSize: cmp.Or(o.MaxSize, actImageSize), Quality: actImageJPEG})
		if err != nil {
			return err
		}
		screen.Image = &image
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
