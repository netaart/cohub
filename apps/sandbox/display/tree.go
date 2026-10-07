package display

import (
	"math"
	"slices"
	"strings"
	"unicode/utf8"
)

type TreeParams struct {
	Display     string `json:"display"`
	MaxElements int    `json:"maxElements,omitempty"`
	Actionable  bool   `json:"actionable,omitempty"`
}

type Tree struct {
	Width     int       `json:"width"`
	Height    int       `json:"height"`
	Elements  []Element `json:"elements"`
	Truncated bool      `json:"truncated,omitempty"`
}

type Element struct {
	Ref     string     `json:"ref"`
	Depth   int        `json:"depth"`
	Role    string     `json:"role"`
	Name    string     `json:"name,omitempty"`
	Value   string     `json:"value,omitempty"`
	Bounds  [4]float64 `json:"bounds"`
	States  []string   `json:"states,omitempty"`
	Actions []string   `json:"actions,omitempty"`
}

func (p *TreeParams) normalize() error {
	if p.MaxElements == 0 {
		p.MaxElements = DefaultTreeElements
	}
	if p.MaxElements < 1 || p.MaxElements > MaxTreeElements {
		return errorf(CodeInvalid, "maxElements must be within 1..%d", MaxTreeElements)
	}
	return nil
}

func (t Tree) sanitize(limit int) Tree {
	clean := Tree{Width: max(0, t.Width), Height: max(0, t.Height), Truncated: t.Truncated, Elements: make([]Element, 0, min(len(t.Elements), limit))}
	seen := map[string]bool{}
	for _, element := range t.Elements {
		if !elementRefPattern.MatchString(element.Ref) || seen[element.Ref] {
			continue
		}
		if len(clean.Elements) == limit {
			clean.Truncated = true
			break
		}
		seen[element.Ref] = true
		if !elementRoles[element.Role] {
			element.Role = "other"
		}
		element.Depth = min(max(element.Depth, 0), MaxTreeDepth)
		element.Name = clip(element.Name)
		element.Value = clip(element.Value)
		for i, value := range element.Bounds {
			if math.IsNaN(value) {
				value = 0
			}
			element.Bounds[i] = math.Round(min(max(value, 0), 1)*10000) / 10000
		}
		element.States = knownNames(element.States, elementStates)
		element.Actions = knownNames(element.Actions, elementActions)
		if slices.Contains(element.States, "password") {
			element.Value = ""
		}
		clean.Elements = append(clean.Elements, element)
	}
	return clean
}

func (t Tree) actionable(limit int) Tree {
	kept := t.Elements[:0:0]
	for _, element := range t.Elements {
		if len(element.Actions) == 0 && !slices.Contains(element.States, "editable") {
			continue
		}
		if len(kept) == limit {
			t.Truncated = true
			break
		}
		element.Depth = 0
		kept = append(kept, element)
	}
	t.Elements = kept
	return t
}

// textLen counts characters, as zod does on the TypeScript side.
func textLen(text string) int {
	return utf8.RuneCountInString(text)
}

func clip(text string) string {
	text = strings.ToValidUTF8(strings.TrimSpace(text), "")
	if textLen(text) <= MaxElementText {
		return text
	}
	return string([]rune(text)[:MaxElementText-1]) + "…"
}
