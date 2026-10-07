package display

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
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
}

var displayIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

func (i Info) valid() bool {
	return displayIDPattern.MatchString(i.ID) && utf8.RuneCountInString(i.Name) <= 200 && i.Width >= 0 && i.Height >= 0 && i.Width <= 16384 && i.Height <= 16384
}

// known drops the system buttons this version does not know, so a newer
// provider still shares its screen.
func (i Info) known() Info {
	system := make([]string, 0, len(i.System))
	for _, action := range i.System {
		if systemActions[action] && !slices.Contains(system, action) {
			system = append(system, action)
		}
	}
	i.System = system
	if len(system) == 0 {
		i.System = nil
	}
	return i
}

func (i Info) equal(other Info) bool {
	return i.ID == other.ID && i.Name == other.Name && i.Width == other.Width && i.Height == other.Height &&
		i.Stream == other.Stream && i.Capture == other.Capture && i.Input == other.Input &&
		i.Desktop == other.Desktop && slices.Equal(i.System, other.System)
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
	if p.MaxSize < 0 || p.MaxSize > 16384 {
		return errorf(CodeInvalid, "maxSize must be within 0..16384")
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
	Text   string   `json:"text,omitempty"`
	T      *int     `json:"t,omitempty"`
}

type InputBatch struct {
	Display string       `json:"display"`
	Events  []InputEvent `json:"events"`
}

const (
	MaxInputEvents   = 512
	MaxInputTextLen  = 4096
	MaxInputSchedule = 60 * time.Second
	maxKeyLen        = 64
)

var (
	pointerActions = map[string]bool{"down": true, "move": true, "up": true, "cancel": true}
	keyActions     = map[string]bool{"down": true, "up": true, "press": true}
	buttons        = map[string]bool{"": true, "primary": true, "secondary": true, "middle": true}
	systemActions  = map[string]bool{"back": true, "home": true, "recents": true, "notifications": true, "quickSettings": true, "lock": true}
)

func validUnit(value *float64) bool {
	return value != nil && !math.IsNaN(*value) && *value >= 0 && *value <= 1
}

func validDelta(value float64) bool {
	return !math.IsNaN(value) && value >= -10 && value <= 10
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
		if !buttons[e.Button] {
			return errors.New("button must be primary, secondary or middle")
		}
	case "scroll":
		if !validUnit(e.X) || !validUnit(e.Y) {
			return errors.New("scroll x and y must be within 0..1")
		}
		if !validDelta(e.DX) || !validDelta(e.DY) || (e.DX == 0 && e.DY == 0) {
			return errors.New("scroll needs dx or dy within -10..10")
		}
	case "key":
		if !keyActions[e.Action] {
			return errors.New("key action must be down, up or press")
		}
		if e.Key == "" || len(e.Key) > maxKeyLen {
			return errors.New("key is required")
		}
	case "text":
		if e.Text == "" || utf8.RuneCountInString(e.Text) > MaxInputTextLen || strings.ContainsRune(e.Text, 0) {
			return fmt.Errorf("text must be 1..%d characters", MaxInputTextLen)
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
