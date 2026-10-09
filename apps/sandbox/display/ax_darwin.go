//go:build darwin

package display

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	axValueCGPoint   = 1
	axValueCGSize    = 2
	axTimeoutSeconds = 1
	axReadTimeout    = 5 * time.Second
	axSnapshots      = 4
)

var ax struct {
	systemWide     func() uintptr
	copyAttribute  func(element, attribute uintptr, value *uintptr) int32
	copyAttributes func(element, attributes uintptr, options uint32, values *uintptr) int32
	copyActions    func(element uintptr, names *uintptr) int32
	perform        func(element, action uintptr) int32
	setAttribute   func(element, attribute, value uintptr) int32
	setTimeout     func(element uintptr, seconds float32) int32
	valueTypeID    func() uintptr
	valueGet       func(value uintptr, kind uint32, out unsafe.Pointer) bool

	attributes uintptr // the CFArray read for every element
	names      map[string]uintptr
}

var axAttributes = []string{
	"AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXPlaceholderValue",
	"AXPosition", "AXSize", "AXFocused", "AXEnabled", "AXSelected", "AXExpanded", "AXChildren",
}

var (
	axOnce sync.Once
	axErr  error
)

func loadAX() error {
	axOnce.Do(func() {
		if axErr = loadQuartz(); axErr != nil {
			return
		}
		lib := quartzLibs.services
		for name, fn := range map[string]any{
			"AXUIElementCreateSystemWide": &ax.systemWide, "AXUIElementCopyAttributeValue": &ax.copyAttribute,
			"AXUIElementCopyMultipleAttributeValues": &ax.copyAttributes, "AXUIElementCopyActionNames": &ax.copyActions,
			"AXUIElementPerformAction": &ax.perform, "AXUIElementSetAttributeValue": &ax.setAttribute,
			"AXUIElementSetMessagingTimeout": &ax.setTimeout, "AXValueGetTypeID": &ax.valueTypeID, "AXValueGetValue": &ax.valueGet,
		} {
			purego.RegisterLibFunc(fn, lib, name)
		}
		ax.names = map[string]uintptr{}
		for _, name := range append(slices.Clone(axAttributes), "AXFocusedApplication", "AXFocusedWindow", "AXMainWindow", "AXPress", "AXShowMenu") {
			ax.names[name] = cfString(name)
		}
		refs := make([]uintptr, len(axAttributes))
		for i, name := range axAttributes {
			refs[i] = ax.names[name]
		}
		ax.attributes = cfArray(refs)
	})
	return axErr
}

var axRoles = map[string]string{
	"AXWindow": "window", "AXSheet": "dialog",
	"AXList": "list", "AXOutline": "list", "AXTable": "list", "AXBrowser": "list", "AXGrid": "list",
	"AXRow": "listItem", "AXCell": "listItem",
	"AXStaticText": "text", "AXHeading": "heading", "AXImage": "image",
	"AXButton": "button", "AXMenuButton": "button", "AXPopUpButton": "button", "AXDisclosureTriangle": "button", "AXIncrementor": "button",
	"AXLink":      "link",
	"AXTextField": "textField", "AXTextArea": "textField", "AXComboBox": "textField", "AXSearchField": "textField",
	"AXCheckBox": "checkbox", "AXRadioButton": "radio", "AXSlider": "slider",
	"AXMenu": "menu", "AXMenuBar": "menu", "AXMenuItem": "menuItem", "AXMenuBarItem": "menuItem",
	"AXWebArea": "web",
}

var axSubroles = map[string]string{
	"AXDialog": "dialog", "AXSystemDialog": "dialog", "AXSwitch": "switch", "AXTabButton": "tab", "AXSecureTextField": "textField",
}

var axPlain = map[string]bool{
	"AXGroup": true, "AXSplitGroup": true, "AXLayoutArea": true, "AXToolbar": true, "AXTabGroup": true,
	"AXScrollArea": true, "AXSplitter": true, "AXUnknown": true, "AXLayoutItem": true,
}

type axTree struct {
	screen *macScreen

	mu        sync.Mutex
	snapshots []axSnapshot
	sequence  int
}

type axSnapshot struct {
	id      int
	entries []axEntry
}

type axEntry struct {
	element   uintptr // retained
	signature string
	bounds    [4]float64
	actions   []string
}

type axDetails struct {
	role, subrole, title, description, value, placeholder string
	position, size                                        [2]float64
	focused, enabled, selected, expanded, checked         bool
	children                                              []uintptr // borrowed from values
	values                                                uintptr   // owns children; release after use
	actions                                               []string
}

func (d axDetails) release() {
	if d.values != 0 {
		cf.release(d.values)
	}
}

func axRead(element uintptr, actions bool) (axDetails, bool) {
	var d axDetails
	if ax.copyAttributes(element, ax.attributes, 0, &d.values) != 0 || d.values == 0 {
		return d, false
	}
	value := func(i int) uintptr { return cf.arrayAt(d.values, i) }
	flag := func(i int) bool { n, _ := cfInt(value(i)); return n != 0 }
	d.role, d.subrole, d.title, d.description = goString(value(0)), goString(value(1)), goString(value(2)), goString(value(3))
	d.value, d.placeholder = goString(value(4)), goString(value(5))
	if n, ok := cfInt(value(4)); ok {
		d.checked = n == 1
	}
	d.position = axPair(value(6), axValueCGPoint)
	d.size = axPair(value(7), axValueCGSize)
	d.focused, d.enabled, d.selected, d.expanded = flag(8), flag(9), flag(10), flag(11)
	if children := value(12); children != 0 && cf.typeID(children) == cf.arrayTypeID() {
		for i := range cf.arrayCount(children) {
			d.children = append(d.children, cf.arrayAt(children, i))
		}
	}
	if actions {
		var names uintptr
		if ax.copyActions(element, &names) == 0 && names != 0 {
			for i := range cf.arrayCount(names) {
				d.actions = append(d.actions, goString(cf.arrayAt(names, i)))
			}
			cf.release(names)
		}
	}
	return d, true
}

func axPair(value uintptr, kind uint32) [2]float64 {
	var pair [2]float64
	if value != 0 && cf.typeID(value) == ax.valueTypeID() {
		ax.valueGet(value, kind, unsafe.Pointer(&pair))
	}
	return pair
}

func (d axDetails) name() string {
	if d.role == "AXStaticText" {
		return cmp.Or(d.value, d.title, d.description)
	}
	return cmp.Or(d.title, d.description)
}

func (d axDetails) kind() string {
	if role, ok := axSubroles[d.subrole]; ok {
		return role
	}
	return axRoles[d.role]
}

func (d axDetails) editable() bool { return d.kind() == "textField" }

func (d axDetails) signature() string {
	return strings.Join([]string{d.role, d.subrole, d.name(), fmt.Sprint(d.position, d.size)}, "\x00")
}

func (t *axTree) focusedWindow() (uintptr, error) {
	if err := loadAX(); err != nil {
		return 0, errorf(CodeUnavailable, "%v", err)
	}
	if !cg.trusted() {
		return 0, errorf(CodeUnavailable, "allow Accessibility for the Runtime's terminal in System Settings → Privacy & Security, then restart the Runtime")
	}
	system := ax.systemWide()
	defer cf.release(system)
	ax.setTimeout(system, axTimeoutSeconds)
	var app uintptr
	if ax.copyAttribute(system, ax.names["AXFocusedApplication"], &app) != 0 || app == 0 {
		return 0, errorf(CodeUnavailable, "no app is in front")
	}
	defer cf.release(app)
	for _, attribute := range []string{"AXFocusedWindow", "AXMainWindow"} {
		var window uintptr
		if ax.copyAttribute(app, ax.names[attribute], &window) == 0 && window != 0 {
			return window, nil
		}
	}
	return 0, errorf(CodeUnavailable, "the app in front has no window")
}

func (t *axTree) Tree(ctx context.Context, maxElements int) (Tree, error) {
	window, err := t.focusedWindow()
	if err != nil {
		return Tree{}, err
	}
	defer cf.release(window)
	width, height := t.screen.size()
	ctx, cancel := context.WithTimeout(ctx, axReadTimeout)
	defer cancel()

	t.mu.Lock()
	defer t.mu.Unlock()
	t.sequence++
	snapshot := axSnapshot{id: t.sequence}
	tree := Tree{Width: int(width), Height: int(height), Elements: []Element{}}
	var visit func(element uintptr, depth int, parent string)
	visit = func(element uintptr, depth int, parent string) {
		if tree.Truncated || depth > MaxTreeDepth {
			return
		}
		d, ok := axRead(element, true)
		if !ok {
			return
		}
		defer d.release()
		if depth > 0 && (d.size[0] <= 0 || d.size[1] <= 0) {
			return
		}
		name := d.name()
		repeats := d.role == "AXStaticText" && name != "" && name == parent
		clickable := slices.Contains(d.actions, "AXPress")
		meaningful := clickable || d.editable() || name != "" && !axPlain[d.role] || axRoles[d.role] != "" && !axPlain[d.role]
		included := depth == 0 || meaningful && !repeats
		if included {
			if len(tree.Elements) == maxElements || ctx.Err() != nil {
				tree.Truncated = true
				return
			}
			out := axElement(d, depth, width, height)
			out.Ref = fmt.Sprintf("e%d.%d", snapshot.id, len(snapshot.entries)+1)
			snapshot.entries = append(snapshot.entries, axEntry{element: cf.retain(element), signature: d.signature(), bounds: out.Bounds, actions: out.Actions})
			tree.Elements = append(tree.Elements, out)
		}
		next, label := depth, parent
		if included {
			next, label = depth+1, name
		}
		for _, child := range d.children {
			visit(child, next, label)
		}
	}
	visit(window, 0, "")
	t.snapshots = append(t.snapshots, snapshot)
	for len(t.snapshots) > axSnapshots {
		for _, entry := range t.snapshots[0].entries {
			cf.release(entry.element)
		}
		t.snapshots = t.snapshots[1:]
	}
	return tree, nil
}

func axElement(d axDetails, depth int, width, height float64) Element {
	role := d.kind()
	switch {
	case depth == 0 && role != "dialog":
		role = "window"
	case role == "":
		role = "other"
		if axPlain[d.role] {
			role = "group"
		}
	}
	password := d.subrole == "AXSecureTextField"
	element := Element{Depth: depth, Role: role, Name: d.name()}
	if d.editable() {
		element.Name = cmp.Or(element.Name, d.placeholder)
		if !password {
			element.Value = d.value
		}
	}
	unit := func(value, extent float64) float64 {
		if extent <= 0 {
			return 0
		}
		return value / extent
	}
	element.Bounds = [4]float64{unit(d.position[0], width), unit(d.position[1], height), unit(d.size[0], width), unit(d.size[1], height)}
	clickable := slices.Contains(d.actions, "AXPress")
	toggles := role == "checkbox" || role == "radio" || role == "switch"
	for _, state := range []struct {
		name string
		on   bool
	}{
		{"focused", d.focused},
		{"selected", d.selected},
		{"checked", toggles && d.checked},
		{"disabled", (clickable || d.editable()) && !d.enabled},
		{"editable", d.editable()},
		{"password", password},
		{"scrollable", d.role == "AXScrollArea" || role == "web"},
		{"expanded", d.expanded},
	} {
		if state.on {
			element.States = append(element.States, state.name)
		}
	}
	if clickable {
		element.Actions = append(element.Actions, "click")
	}
	if slices.Contains(d.actions, "AXShowMenu") {
		element.Actions = append(element.Actions, "longPress")
	}
	if d.editable() {
		element.Actions = append(element.Actions, "focus", "setText")
	}
	if slices.Contains(element.States, "scrollable") {
		element.Actions = append(element.Actions, "scrollForward", "scrollBackward")
	}
	return element
}

func (t *axTree) resolve(ref string) (axEntry, error) {
	var snapshot, index int
	if _, err := fmt.Sscanf(ref, "e%d.%d", &snapshot, &index); err != nil {
		return axEntry{}, errorf(CodeInvalid, "%s is not an element ref", ref)
	}
	for _, current := range t.snapshots {
		if current.id != snapshot {
			continue
		}
		if index < 1 || index > len(current.entries) {
			return axEntry{}, errorf(CodeInvalid, "%s is not in its tree", ref)
		}
		entry := current.entries[index-1]
		cf.retain(entry.element)
		return entry, nil
	}
	return axEntry{}, errorf(CodeInvalid, "%s is from an old tree; read the tree again", ref)
}

func (t *axTree) Element(ref, action string, text *string) error {
	t.mu.Lock()
	entry, err := t.resolve(ref)
	t.mu.Unlock()
	if err != nil {
		return err
	}
	defer cf.release(entry.element)
	current, ok := axRead(entry.element, false)
	current.release()
	if !ok || current.signature() != entry.signature {
		return errorf(CodeInvalid, "%s changed or left the screen; read the tree again", ref)
	}
	if !slices.Contains(entry.actions, action) {
		return errorf(CodeUnsupported, "%s cannot %s", ref, action)
	}
	b := entry.bounds
	x, y := min(1, max(0, b[0]+b[2]/2)), min(1, max(0, b[1]+b[3]/2))
	switch action {
	case "click":
		if ax.perform(entry.element, ax.names["AXPress"]) == 0 {
			return nil
		}
		return t.screen.click(x, y)
	case "longPress":
		if ax.perform(entry.element, ax.names["AXShowMenu"]) != 0 {
			return errorf(CodeFailed, "the app refused a menu on %s", ref)
		}
		return nil
	case "focus":
		if ax.setAttribute(entry.element, ax.names["AXFocused"], cf.yes) != 0 {
			return t.screen.click(x, y)
		}
		return nil
	case "setText":
		value := cfString(*text)
		defer cf.release(value)
		if ax.setAttribute(entry.element, ax.names["AXValue"], value) == 0 {
			return nil
		}
		if ax.setAttribute(entry.element, ax.names["AXFocused"], cf.yes) != 0 {
			if err := t.screen.click(x, y); err != nil {
				return err
			}
		}
		return t.screen.replaceText(*text)
	default:
		amount := 0.5
		if action == "scrollBackward" {
			amount = -amount
		}
		return t.screen.Scroll(x, y, 0, amount)
	}
}
