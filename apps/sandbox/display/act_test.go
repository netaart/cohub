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
