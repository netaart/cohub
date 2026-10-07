package display

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"
)

type Info struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Width   int      `json:"width"`
	Height  int      `json:"height"`
	Stream  bool     `json:"stream"`
	Capture bool     `json:"capture"`
	Input   bool     `json:"input"`
	System  []string `json:"system,omitempty"`
	Desktop bool     `json:"desktop,omitempty"`
	Tree    bool     `json:"tree,omitempty"`
	Needs   []string `json:"needs,omitempty"`
	Viewers []Viewer `json:"viewers,omitempty"`
}

type Viewer struct {
	UserID  string `json:"userId"`
	Control bool   `json:"control,omitempty"`
}

func (i Info) valid() bool {
	return displayIDPattern.MatchString(i.ID) && textLen(i.Name) <= MaxNameLen && i.Width >= 0 && i.Height >= 0 && i.Width <= MaxDimension && i.Height <= MaxDimension
}

// known drops the names this version does not know, so a newer provider
// still shares its screen.
func (i Info) known() Info {
	i.System = knownNames(i.System, systemActions)
	i.Needs = knownNames(i.Needs, permissions)
	i.Viewers = nil
	return i
}

func knownNames(names []string, known map[string]bool) []string {
	var kept []string
	for _, name := range names {
		if known[name] && !slices.Contains(kept, name) {
			kept = append(kept, name)
		}
	}
	return kept
}

func (i Info) equal(other Info) bool {
	return i.ID == other.ID && i.Name == other.Name && i.Width == other.Width && i.Height == other.Height &&
		i.Stream == other.Stream && i.Capture == other.Capture && i.Input == other.Input &&
		i.Desktop == other.Desktop && i.Tree == other.Tree && slices.Equal(i.System, other.System) && slices.Equal(i.Needs, other.Needs) &&
		slices.Equal(i.Viewers, other.Viewers)
}

type Sample struct {
	Data []byte
	PTS  uint64
	Key  bool
}

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

const (
	CodeUnavailable = "unavailable" // the ability needs consent or a running provider
	CodeNotFound    = "not_found"
	CodeUnsupported = "unsupported"
	CodeInvalid     = "invalid"
	CodeBusy        = "busy"
	CodeTimeout     = "timeout"
	CodePreempted   = "preempted" // a person took over the display
	CodeFailed      = "failed"
)

func errorf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

func ErrorCode(err error) string {
	var displayErr *Error
	if errors.As(err, &displayErr) {
		return displayErr.Code
	}
	return CodeFailed
}

type CaptureParams struct {
	Display string `json:"display"`
	Format  string `json:"format,omitempty"`
	Quality int    `json:"quality,omitempty"`
	MaxSize int    `json:"maxSize,omitempty"`
}

func (p *CaptureParams) normalize() error {
	switch p.Format {
	case "":
		p.Format = "jpeg"
	case "jpeg", "png":
	default:
		return errorf(CodeInvalid, "format must be jpeg or png")
	}
	if p.Quality == 0 {
		p.Quality = 90
	}
	if p.Quality < 1 || p.Quality > 100 {
		return errorf(CodeInvalid, "quality must be within 1..100")
	}
	if p.MaxSize == 0 {
		p.MaxSize = DefaultMaxSize
	}
	if p.MaxSize < 0 || p.MaxSize > MaxDimension {
		return errorf(CodeInvalid, "maxSize must be within 0..%d", MaxDimension)
	}
	return nil
}

type CaptureResult struct {
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
}

type InputEvent struct {
	Type   string   `json:"type"`
	Action string   `json:"action,omitempty"`
	X      *float64 `json:"x,omitempty"`
	Y      *float64 `json:"y,omitempty"`
	DX     float64  `json:"dx,omitempty"`
	DY     float64  `json:"dy,omitempty"`
	Button string   `json:"button,omitempty"`
	Key    string   `json:"key,omitempty"`
	Text   *string  `json:"text,omitempty"`
	Ref    string   `json:"ref,omitempty"`
	T      *int     `json:"t,omitempty"`
}

type InputBatch struct {
	Display string       `json:"display"`
	Events  []InputEvent `json:"events"`
	StartBy int64        `json:"startBy,omitempty"`
}

const MaxInputSchedule = MaxInputScheduleMs * time.Millisecond

func names(values ...string) map[string]bool {
	set := make(map[string]bool, len(values))
	for _, value := range values {
		set[value] = true
	}
	return set
}

func validUnit(value *float64) bool {
	return value != nil && !math.IsNaN(*value) && *value >= 0 && *value <= 1
}

func validText(text string) bool {
	return textLen(text) <= MaxInputTextLen && !strings.ContainsRune(text, 0)
}

func validDelta(value float64) bool {
	return !math.IsNaN(value) && value >= -MaxScroll && value <= MaxScroll
}

func (b InputBatch) Validate() error {
	if len(b.Events) == 0 {
		return errorf(CodeInvalid, "events are required")
	}
	if len(b.Events) > MaxInputEvents {
		return errorf(CodeInvalid, "at most %d events per batch", MaxInputEvents)
	}
	last := 0
	for index, event := range b.Events {
		if event.T != nil {
			if *event.T < last || time.Duration(*event.T)*time.Millisecond > MaxInputSchedule {
				return errorf(CodeInvalid, "event %d: t must be ascending and within %s", index, MaxInputSchedule)
			}
			last = *event.T
		}
		if err := event.validate(); err != nil {
			return errorf(CodeInvalid, "event %d: %s", index, err)
		}
	}
	return nil
}

func (e InputEvent) validate() error {
	switch e.Type {
	case "pointer":
		if !pointerActions[e.Action] {
			return errors.New("pointer action must be down, move, up or cancel")
		}
		if !validUnit(e.X) || !validUnit(e.Y) {
			return errors.New("pointer x and y must be within 0..1")
		}
		if e.Button != "" && !buttons[e.Button] {
			return errors.New("button must be primary, secondary or middle")
		}
	case "scroll":
		if !validUnit(e.X) || !validUnit(e.Y) {
			return errors.New("scroll x and y must be within 0..1")
		}
		if !validDelta(e.DX) || !validDelta(e.DY) || (e.DX == 0 && e.DY == 0) {
			return fmt.Errorf("scroll needs dx or dy within -%[1]d..%[1]d", MaxScroll)
		}
	case "key":
		if !keyActions[e.Action] {
			return errors.New("key action must be down, up or press")
		}
		if e.Key == "" || textLen(e.Key) > MaxKeyLen {
			return errors.New("key is required")
		}
	case "text":
		if e.Text == nil || *e.Text == "" || !validText(*e.Text) {
			return fmt.Errorf("text must be 1..%d characters", MaxInputTextLen)
		}
	case "element":
		if !elementRefPattern.MatchString(e.Ref) {
			return errors.New("ref must be an element ref such as e3.12")
		}
		if !elementActions[e.Action] {
			return errors.New("element action is not supported")
		}
		if (e.Action == "setText") != (e.Text != nil) || e.Text != nil && !validText(*e.Text) {
			return fmt.Errorf("setText needs text of at most %d characters, other actions none", MaxInputTextLen)
		}
	case "system":
		if !systemActions[e.Action] {
			return errors.New("system action is not supported")
		}
	default:
		return fmt.Errorf("unknown event type %q", e.Type)
	}
	return nil
}
