package display

import (
	"cmp"
	"slices"
	"strings"
)

type Target struct {
	Ref    string `json:"ref,omitempty"`
	Name   string `json:"name,omitempty"`
	Role   string `json:"role,omitempty"`
	Nth    int    `json:"nth,omitempty"` // 1-based, top to bottom
	Scroll bool   `json:"scroll,omitempty"`
}

func (t Target) validate() error {
	byRef, byText := t.Ref != "", t.Name != "" || t.Role != ""
	switch {
	case byRef == byText:
		return errorf(CodeInvalid, "a target is a ref, or a name and/or role")
	case byRef && !elementRefPattern.MatchString(t.Ref):
		return errorf(CodeInvalid, "%q is not an element ref such as e3.12", t.Ref)
	case byRef && (t.Nth != 0 || t.Scroll):
		return errorf(CodeInvalid, "nth and scroll go with a name or role")
	case textLen(t.Name) > MaxElementText:
		return errorf(CodeInvalid, "a target name has at most %d characters", MaxElementText)
	case t.Role != "" && !elementRoles[t.Role]:
		return errorf(CodeInvalid, "unknown role %q", t.Role)
	case t.Nth < 0 || t.Nth > MaxTargetNth:
		return errorf(CodeInvalid, "nth must be within 1..%d", MaxTargetNth)
	}
	return nil
}

func (t Target) String() string {
	if t.Ref != "" {
		return t.Ref
	}
	parts := []string{}
	if t.Role != "" {
		parts = append(parts, t.Role)
	}
	if t.Name != "" {
		parts = append(parts, `"`+t.Name+`"`)
	}
	return strings.Join(parts, " ")
}

func normalized(text string) string {
	return strings.ToLower(strings.Join(strings.Fields(text), " "))
}

func matches(element Element, query string, fields bool) int {
	best := -1
	for _, text := range []string{element.Name, element.Value} {
		if text == element.Value && !fields && slices.Contains(element.States, "editable") {
			continue
		}
		text = normalized(text)
		tier := -1
		switch {
		case text == "":
		case text == query:
			tier = 0
		case strings.HasPrefix(text, query):
			tier = 1
		case strings.Contains(text, query):
			tier = 2
		}
		if tier >= 0 && (best < 0 || tier < best) {
			best = tier
		}
	}
	return best
}

func actionable(element Element) bool {
	return len(element.Actions) > 0 || slices.Contains(element.States, "editable")
}

func visible(element Element) bool {
	return element.Bounds[2] > 0 && element.Bounds[3] > 0
}

func resolve(tree Tree, target Target, action string) (Element, []Element) {
	query := normalized(target.Name)
	fields := target.Role == "textField" || action == "setText" || action == "focus"
	if strings.Contains(query, " · ") {
		if element, rows := resolveRow(tree, target, query); element.Ref != "" || len(rows) > 0 {
			return element, rows
		}
	}
	parents := parentsOf(tree.Elements)
	tiers := [3][]int{}
	for index, element := range tree.Elements {
		if !visible(element) || element.Depth == 0 || (target.Role != "" && element.Role != target.Role) {
			continue
		}
		tier := 0
		if query != "" {
			if tier = matches(element, query, fields); tier < 0 {
				continue
			}
		}
		tiers[tier] = append(tiers[tier], index)
	}
	for _, found := range tiers {
		if len(found) == 0 {
			continue
		}
		if slices.ContainsFunc(found, func(index int) bool { return actionable(tree.Elements[index]) }) {
			found = slices.DeleteFunc(found, func(index int) bool { return !actionable(tree.Elements[index]) })
		}
		found = slices.DeleteFunc(slices.Clone(found), func(index int) bool {
			for parent := parents[index]; parent >= 0; parent = parents[parent] {
				if slices.Contains(found, parent) {
					return true
				}
			}
			return false
		})
		candidates := make([]Element, len(found))
		for i, index := range found {
			candidates[i] = tree.Elements[index]
		}
		slices.SortStableFunc(candidates, func(a, b Element) int {
			return cmp.Or(cmp.Compare(a.Bounds[1], b.Bounds[1]), cmp.Compare(a.Bounds[0], b.Bounds[0]))
		})
		switch {
		case target.Nth > len(candidates):
			return Element{}, nil
		case target.Nth > 0:
			return candidates[target.Nth-1], nil
		case len(candidates) == 1:
			return candidates[0], nil
		}
		return Element{}, candidates[:min(len(candidates), MaxCandidates)]
	}
	return Element{}, nil
}

func resolveRow(tree Tree, target Target, query string) (Element, []Element) {
	var rows []Element
	for _, element := range tree.compact(MaxTreeElements).Elements {
		if normalized(element.Name) == query && (target.Role == "" || element.Role == target.Role) {
			rows = append(rows, element)
		}
	}
	switch {
	case target.Nth > len(rows):
		return Element{}, nil
	case target.Nth > 0:
		return rows[target.Nth-1], nil
	case len(rows) == 1:
		return rows[0], nil
	}
	return Element{}, rows[:min(len(rows), MaxCandidates)]
}

func parentsOf(elements []Element) []int {
	parents := make([]int, len(elements))
	var stack []int
	for index, element := range elements {
		for len(stack) > 0 && elements[stack[len(stack)-1]].Depth >= element.Depth {
			stack = stack[:len(stack)-1]
		}
		parents[index] = -1
		if len(stack) > 0 {
			parents[index] = stack[len(stack)-1]
		}
		stack = append(stack, index)
	}
	return parents
}

func scroller(tree Tree) Element {
	var best Element
	area := 0.0
	for _, element := range tree.Elements {
		size := element.Bounds[2] * element.Bounds[3]
		if size > area && slices.Contains(element.Actions, "scrollForward") {
			best, area = element, size
		}
	}
	return best
}

func within(elements []Element, root, index int) bool {
	if index < root {
		return false
	}
	for i := root + 1; i <= index; i++ {
		if elements[i].Depth <= elements[root].Depth {
			return false
		}
	}
	return true
}
