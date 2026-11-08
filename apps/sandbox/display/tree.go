package display

import (
	"cmp"
	"slices"
	"strings"
	"unicode/utf8"
)

type TreeParams struct {
	Display     string `json:"display"`
	MaxElements int    `json:"maxElements,omitempty"`
	Compact     bool   `json:"compact,omitempty"`
	Window      string `json:"window,omitempty"`
}

type Tree struct {
	App       string    `json:"app,omitempty"`
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
	if p.Window != "" && !windowIDPattern.MatchString(p.Window) {
		return errorf(CodeInvalid, "window must be a window id")
	}
	return nil
}

const compactNameLen = 160

func (t Tree) sanitize(limit int) Tree {
	clean := Tree{Width: max(0, t.Width), Height: max(0, t.Height), Truncated: t.Truncated, Elements: make([]Element, 0, min(len(t.Elements), limit))}
	if appIDPattern.MatchString(t.App) {
		clean.App = t.App
	}
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
			element.Bounds[i] = unit(value)
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

func (t Tree) compact(limit int) Tree {
	parents := parentsOf(t.Elements)
	kept := t.Elements[:0:0]
	at := make(map[int]int, len(t.Elements))
	gathered := map[int]bool{}
	add := func(index int) bool {
		if len(kept) == limit {
			t.Truncated = true
			return false
		}
		element := t.Elements[index]
		element.Depth = 0
		at[index] = len(kept)
		kept = append(kept, element)
		return true
	}
	for index, element := range t.Elements {
		if !visible(element) || element.Depth == 0 && element.Role != "dialog" {
			continue
		}
		if actionable(element) || element.Depth == 0 {
			if !add(index) {
				break
			}
			continue
		}
		text := cmp.Or(element.Name, element.Value)
		if text == "" {
			continue
		}
		place, inside := -1, false
		for parent := parents[index]; parent >= 0 && !inside; parent = parents[parent] {
			place, inside = at[parent]
			inside = inside && actionable(t.Elements[parent])
		}
		if inside {
			owner := &kept[place]
			if owner.Name == "" || gathered[place] {
				gathered[place] = true
				if textLen(owner.Name) < compactNameLen {
					owner.Name = strings.TrimPrefix(owner.Name+" · "+text, " · ")
				}
				continue
			}
			if strings.Contains(normalized(owner.Name), normalized(text)) {
				continue
			}
		}
		if !add(index) {
			break
		}
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
