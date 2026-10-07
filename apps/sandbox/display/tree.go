package display

import (
	"math"
	"regexp"
	"slices"
	"strings"
	"unicode/utf16"
)

type TreeParams struct {
	Display     string `json:"display"`
	MaxElements int    `json:"maxElements,omitempty"`
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

const (
	DefaultTreeElements = 300
	MaxTreeElements     = 1000
	maxTreeDepth        = 64
	maxElementText      = 500
)

var (
	elementRefPattern = regexp.MustCompile(`^e\d{1,9}\.\d{1,5}$`)
	elementRoles      = names("window", "dialog", "group", "list", "listItem", "text", "heading", "image", "button", "link",
		"textField", "checkbox", "radio", "switch", "slider", "tab", "menu", "menuItem", "web", "other")
	elementStates = names("focused", "selected", "checked", "disabled", "editable", "password", "scrollable", "expanded")
)

func names(values ...string) map[string]bool {
	set := make(map[string]bool, len(values))
	for _, value := range values {
		set[value] = true
	}
	return set
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
		element.Depth = min(max(element.Depth, 0), maxTreeDepth)
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

func utf16Len(text string) int {
	return len(utf16.Encode([]rune(text)))
}

// clip bounds text in UTF-16 units, as JavaScript clients count it.
func clip(text string) string {
	text = strings.ToValidUTF8(strings.TrimSpace(text), "")
	if utf16Len(text) <= maxElementText {
		return text
	}
	runes := []rune(text)
	units := 0
	for i, r := range runes {
		units += utf16.RuneLen(r)
		if units > maxElementText-1 {
			return string(runes[:i]) + "…"
		}
	}
	return text
}
