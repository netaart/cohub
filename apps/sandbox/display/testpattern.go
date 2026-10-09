package display

import (
	"context"
	"fmt"
	"image"
	"image/color"
	"log/slog"
	"slices"
	"sync"
)

const (
	testDisplayWidth  = 1280
	testDisplayHeight = 720
)

var testBars = []color.RGBA{
	{192, 192, 192, 255}, {192, 192, 0, 255}, {0, 192, 192, 255}, {0, 192, 0, 255},
	{192, 0, 192, 255}, {192, 0, 0, 255}, {0, 0, 192, 255},
}

type testScreen struct {
	logger *slog.Logger

	mu       sync.Mutex
	pointer  *[2]float64
	events   int
	snapshot int
	field    string
}

func newTestScreen(logger *slog.Logger) *testScreen {
	return &testScreen{logger: logger}
}

func (s *testScreen) Info() (Info, error) {
	return Info{ID: "test", Name: "Test pattern", Width: testDisplayWidth, Height: testDisplayHeight, Capture: true, Input: true, Desktop: true, Tree: true}, nil
}

func (s *testScreen) Source(fps int) []string {
	return []string{"-re", "-f", "lavfi", "-i", fmt.Sprintf("testsrc2=size=%dx%d:rate=%d", testDisplayWidth, testDisplayHeight, fps)}
}

func (s *testScreen) Capture(context.Context) (image.Image, error) {
	img := image.NewRGBA(image.Rect(0, 0, testDisplayWidth, testDisplayHeight))
	barWidth := testDisplayWidth / len(testBars)
	for y := 0; y < testDisplayHeight; y++ {
		for x := 0; x < testDisplayWidth; x++ {
			img.SetRGBA(x, y, testBars[min(len(testBars)-1, x/barWidth)])
		}
	}
	s.mu.Lock()
	pointer := s.pointer
	s.mu.Unlock()
	if pointer != nil {
		cx, cy := int(pointer[0]*(testDisplayWidth-1)), int(pointer[1]*(testDisplayHeight-1))
		for d := -12; d <= 12; d++ {
			for w := -1; w <= 1; w++ {
				img.SetRGBA(cx+d, cy+w, color.RGBA{0, 0, 0, 255})
				img.SetRGBA(cx+w, cy+d, color.RGBA{0, 0, 0, 255})
			}
		}
	}
	return img, nil
}

func (s *testScreen) record(kind string, pointer *[2]float64) {
	s.mu.Lock()
	s.events++
	if pointer != nil {
		s.pointer = pointer
	}
	total := s.events
	s.mu.Unlock()
	s.logger.Debug("test pattern input", slog.String("type", kind), slog.Int("total", total))
}

func (s *testScreen) Pointer(action string, x, y float64, _ string) error {
	s.record("pointer."+action, &[2]float64{x, y})
	return nil
}

func (s *testScreen) Scroll(x, y, _, _ float64) error {
	s.record("scroll", &[2]float64{x, y})
	return nil
}

func (s *testScreen) Key(down bool, key string) error {
	if down {
		s.record("key."+key, nil)
	}
	return nil
}

func (s *testScreen) Text(string) error {
	s.record("text", nil)
	return nil
}

func (s *testScreen) Close() error { return nil }

var testElements = []Element{
	{Depth: 0, Role: "window", Name: "Test pattern", Bounds: [4]float64{0, 0, 1, 1}},
	{Depth: 1, Role: "textField", Name: "Name", Bounds: [4]float64{0.1, 0.2, 0.5, 0.1}, States: []string{"editable"}, Actions: []string{"click", "focus", "setText"}},
	{Depth: 1, Role: "button", Name: "Submit", Bounds: [4]float64{0.1, 0.4, 0.2, 0.1}, Actions: []string{"click", "longPress"}},
}

func (s *testScreen) Tree(context.Context, int) (Tree, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snapshot++
	elements := slices.Clone(testElements)
	for i := range elements {
		elements[i].Ref = fmt.Sprintf("e%d.%d", s.snapshot, i+1)
	}
	elements[1].Value = s.field
	return Tree{Width: testDisplayWidth, Height: testDisplayHeight, Elements: elements}, nil
}

func (s *testScreen) Element(ref, action string, text *string) error {
	s.mu.Lock()
	var snapshot, index int
	_, _ = fmt.Sscanf(ref, "e%d.%d", &snapshot, &index)
	if snapshot != s.snapshot || index < 1 || index > len(testElements) {
		s.mu.Unlock()
		return errorf(CodeInvalid, "element %s is not in the latest tree; read the tree again", ref)
	}
	element := testElements[index-1]
	if !slices.Contains(element.Actions, action) {
		s.mu.Unlock()
		return errorf(CodeUnsupported, "%s cannot %s", element.Role, action)
	}
	if action == "setText" {
		s.field = *text
	}
	s.mu.Unlock()
	b := element.Bounds
	s.record("element."+action, &[2]float64{b[0] + b[2]/2, b[1] + b[3]/2})
	return nil
}
