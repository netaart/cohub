package display

import (
	"context"
	"errors"
	"log/slog"
	"testing"
)

func stubHub() *Hub {
	hub := NewHub(nil, slog.New(slog.DiscardHandler))
	hub.setDisplays([]Info{{ID: "agent"}}, "")
	return hub
}

const (
	turn  = "11111111-1111-1111-1111-111111111111"
	other = "22222222-2222-2222-2222-222222222222"
)

func TestStopKeepsTheTurnFromGoingOn(t *testing.T) {
	hub := stubHub()
	hub.beginActivity("agent", Activity{TurnID: turn})
	running, done, err := hub.script(context.Background(), "agent", &Actor{TurnID: turn})
	if err != nil {
		t.Fatal(err)
	}
	defer done()
	if stopped := hub.Stop("agent"); stopped.TurnID != turn {
		t.Fatalf("stopped %+v", stopped)
	}
	if !errors.Is(context.Cause(running), errInterrupted) {
		t.Errorf("the plan in flight ended with %v", context.Cause(running))
	}
	if info, _ := hub.Display("agent"); info.Activity != nil {
		t.Errorf("activity outlived the stop: %+v", info.Activity)
	}
	if _, _, err := hub.script(context.Background(), "agent", &Actor{TurnID: turn}); !errors.Is(err, errInterrupted) {
		t.Errorf("the same Turn got %v", err)
	}
	hub.mu.Lock()
	delete(hub.liveAt, "agent")
	hub.mu.Unlock()
	_, release, err := hub.script(context.Background(), "agent", &Actor{TurnID: other})
	if err != nil {
		t.Fatalf("the next Turn got %v", err)
	}
	release()
}

func TestTapsLandOnlyOnWhatWasSeen(t *testing.T) {
	tree := func(open bool) *Tree {
		elements := []Element{
			{Ref: "e1.1", Role: "window", Bounds: [4]float64{0, 0, 1, 1}},
			{Ref: "e1.2", Depth: 1, Role: "button", Name: "Card", Bounds: [4]float64{0, 0.4, 1, 0.2}, Actions: []string{"click"}},
			{Ref: "e1.3", Depth: 2, Role: "button", Name: "Delete", Bounds: [4]float64{0.4, 0.45, 0.2, 0.1}, Actions: []string{"click"}},
		}
		if open {
			elements = append(elements, Element{Ref: "e1.4", Depth: 1, Role: "button", Name: "World", Bounds: [4]float64{0, 0.4, 0.3, 0.1}, Actions: []string{"click"}})
		}
		return &Tree{Elements: elements}
	}
	run := &actRun{hub: stubHub(), info: Info{ID: "agent"}, tree: tree(true)}
	if _, events := run.aim(Step{Type: "element", Action: "click"}, "e1.2"); events[0].Type != "element" {
		t.Errorf("a tap on the card would press its Delete: %+v", events)
	}
	tap := Step{Type: "input", Events: []InputEvent{pointerAt("down", 0.1, 0.45, 0), pointerAt("up", 0.1, 0.45, 60)}}
	target, _ := run.aim(tap, "")
	run.hub.observe("agent", observation{shown: tree(false)})
	if !run.moved(0, tap, target) || run.result.Stopped.Reason != "moved" {
		t.Errorf("tapped %v where the card was seen", target)
	}
}
