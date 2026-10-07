package display

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
)

func TestSharedCases(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/protocol/fixtures/display.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		InputBatches []struct {
			Name   string       `json:"name"`
			Valid  bool         `json:"valid"`
			Events []InputEvent `json:"events"`
		} `json:"inputBatches"`
		Displays []struct {
			Name  string                           `json:"name"`
			Info  Info                             `json:"info"`
			Known struct{ System, Needs []string } `json:"known"`
		} `json:"displays"`
		Elements []struct {
			Name    string  `json:"name"`
			Element Element `json:"element"`
			Clean   struct {
				Role            string
				States, Actions []string
			} `json:"clean"`
		} `json:"elements"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, c := range fixture.InputBatches {
		if err := (InputBatch{Events: c.Events}).Validate(); (err == nil) != c.Valid {
			t.Errorf("%s: valid %v, got %v", c.Name, c.Valid, err)
		}
	}
	for _, c := range fixture.Displays {
		known := c.Info.known()
		if !slices.Equal(known.System, c.Known.System) || !slices.Equal(known.Needs, c.Known.Needs) {
			t.Errorf("%s: got %v %v", c.Name, known.System, known.Needs)
		}
	}
	for _, c := range fixture.Elements {
		clean := Tree{Elements: []Element{c.Element}}.sanitize(MaxTreeElements).Elements[0]
		if clean.Role != c.Clean.Role || !slices.Equal(clean.States, c.Clean.States) || !slices.Equal(clean.Actions, c.Clean.Actions) {
			t.Errorf("%s: got %+v", c.Name, clean)
		}
	}
}
