package display

import (
	"context"
	"slices"
)

type Window struct {
	ID      string     `json:"id"`
	App     string     `json:"app,omitempty"`
	Title   string     `json:"title,omitempty"`
	Bounds  [4]float64 `json:"bounds"`
	Focused bool       `json:"focused,omitempty"`
}

type WindowsResult struct {
	Windows []Window `json:"windows"`
}

type WindowScreen interface {
	Screen
	Windows(ctx context.Context) ([]Window, error)
}

func (h *Hub) Windows(ctx context.Context, display string) (WindowsResult, error) {
	if err := h.requireAbility(display, func(info Info) bool { return info.Windows }, "windows"); err != nil {
		return WindowsResult{}, err
	}
	conn, err := h.currentConn()
	if err != nil {
		return WindowsResult{}, err
	}
	var result WindowsResult
	if err := conn.call(ctx, "windows", AppsParams{Display: display}, &result, callTimeout); err != nil {
		return WindowsResult{}, err
	}
	windows := result.Windows[:0]
	for _, window := range result.Windows {
		bounds := (&Focus{Bounds: window.Bounds}).clean()
		if !windowIDPattern.MatchString(window.ID) || bounds == nil || bounds.Bounds[2] == 0 || bounds.Bounds[3] == 0 || len(windows) == MaxWindows {
			continue
		}
		window.Bounds, window.App, window.Title = bounds.Bounds, clip(window.App), clip(window.Title)
		windows = append(windows, window)
	}
	return WindowsResult{Windows: windows}, nil
}

func (h *Hub) window(ctx context.Context, info Info, id string) (Window, error) {
	if !info.Windows {
		return Window{}, errorf(CodeInvalid, "display %q does not list its windows", info.ID)
	}
	result, err := h.Windows(ctx, info.ID)
	if err != nil {
		return Window{}, err
	}
	index := slices.IndexFunc(result.Windows, func(w Window) bool { return w.ID == id })
	if index < 0 {
		return Window{}, errorf(CodeNotFound, "window %q is not on display %q", id, info.ID)
	}
	return result.Windows[index], nil
}

func (w Window) toDisplay(x, y float64) (float64, float64) {
	return unit(w.Bounds[0] + x*w.Bounds[2]), unit(w.Bounds[1] + y*w.Bounds[3])
}

func (w Window) fromDisplay(b [4]float64) [4]float64 {
	x, y := (b[0]-w.Bounds[0])/w.Bounds[2], (b[1]-w.Bounds[1])/w.Bounds[3]
	right, bottom := x+b[2]/w.Bounds[2], y+b[3]/w.Bounds[3]
	x, y = unit(x), unit(y)
	return [4]float64{x, y, unit(unit(right) - x), unit(unit(bottom) - y)}
}

func (w Window) contains(b [4]float64) bool {
	cx, cy := b[0]+b[2]/2, b[1]+b[3]/2
	return cx >= w.Bounds[0] && cy >= w.Bounds[1] && cx <= w.Bounds[0]+w.Bounds[2] && cy <= w.Bounds[1]+w.Bounds[3]
}

func (w Window) steps(steps []Step) []Step {
	out := slices.Clone(steps)
	for i, step := range out {
		if len(step.Events) == 0 {
			continue
		}
		events := slices.Clone(step.Events)
		for j, event := range events {
			if event.X != nil && event.Y != nil {
				x, y := w.toDisplay(*event.X, *event.Y)
				events[j].X, events[j].Y = &x, &y
			}
		}
		out[i].Events = events
	}
	return out
}

func (w Window) tree(tree Tree) Tree {
	out := tree
	out.Width, out.Height = int(float64(tree.Width)*w.Bounds[2]+0.5), int(float64(tree.Height)*w.Bounds[3]+0.5)
	out.Elements = nil
	for _, element := range tree.Elements {
		if element.Depth == 0 || w.contains(element.Bounds) {
			element.Bounds = w.fromDisplay(element.Bounds)
			out.Elements = append(out.Elements, element)
		}
	}
	return out
}

func (w Window) target(target *StepTarget) *StepTarget {
	if target == nil {
		return nil
	}
	moved := *target
	moved.Bounds = w.fromDisplay(target.Bounds)
	return &moved
}

func (r *actRun) inWindow() {
	w := r.window
	if w == nil {
		return
	}
	result := &r.result
	result.Window = w
	steps := make([]StepResult, len(result.Steps))
	for i, step := range result.Steps {
		step.Target = w.target(step.Target)
		steps[i] = step
	}
	result.Steps = steps
	if result.Stopped != nil {
		for i, candidate := range result.Stopped.Candidates {
			result.Stopped.Candidates[i].Bounds = w.fromDisplay(candidate.Bounds)
		}
	}
}

func (w Window) region() *[4]float64 {
	bounds := w.Bounds
	return &bounds
}
