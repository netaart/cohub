//go:build linux && !android

package display

import (
	"cmp"
	"context"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"
)

type atspi struct {
	screen *x11Screen

	mu        sync.Mutex
	conn      *dbus.Conn
	snapshots []atspiSnapshot
	sequence  int
}

type atspiNode struct {
	Dest string
	Path dbus.ObjectPath
}

type atspiSnapshot struct {
	id      int
	entries []atspiEntry
}

type atspiEntry struct {
	node      atspiNode
	signature string
	element   Element
	click     int32 // the index of its click action, or -1
}

const (
	atspiRegistry    = "org.a11y.atspi.Registry"
	atspiRoot        = dbus.ObjectPath("/org/a11y/atspi/accessible/root")
	atspiAccessible  = "org.a11y.atspi.Accessible"
	atspiComponent   = "org.a11y.atspi.Component"
	atspiAction      = "org.a11y.atspi.Action"
	atspiText        = "org.a11y.atspi.Text"
	atspiEditable    = "org.a11y.atspi.EditableText"
	atspiCallTimeout = 2 * time.Second
	atspiReadTimeout = 5 * time.Second
	atspiSnapshots   = 4
)

const (
	atspiStateActive    = 1
	atspiStateChecked   = 4
	atspiStateDefunct   = 6
	atspiStateEditable  = 7
	atspiStateEnabled   = 8
	atspiStateExpanded  = 10
	atspiStateFocusable = 11
	atspiStateFocused   = 12
	atspiStateSelected  = 23
	atspiStateShowing   = 25
)

var atspiRoles = map[string]string{
	"frame": "window", "window": "window",
	"dialog": "dialog", "alert": "dialog", "file chooser": "dialog", "color chooser": "dialog", "font chooser": "dialog",
	"list": "list", "list box": "list", "tree": "list", "table": "list", "tree table": "list",
	"list item": "listItem", "tree item": "listItem", "table row": "listItem", "table cell": "listItem",
	"label": "text", "static": "text", "paragraph": "text", "caption": "text",
	"heading": "heading",
	"image":   "image", "icon": "image", "image map": "image",
	"push button": "button", "toggle button": "button", "push button menu": "button",
	"link":  "link",
	"entry": "textField", "password text": "textField", "spin button": "textField", "editbar": "textField",
	"check box": "checkbox", "radio button": "radio", "switch": "switch", "slider": "slider",
	"page tab": "tab",
	"menu":     "menu", "menu bar": "menu", "popup menu": "menu",
	"menu item": "menuItem", "check menu item": "menuItem", "radio menu item": "menuItem", "tearoff menu item": "menuItem",
	"document web": "web", "document frame": "web",
}

var atspiPlain = map[string]bool{
	"panel": true, "filler": true, "section": true, "grouping": true, "form": true, "redundant object": true,
	"unknown": true, "embedded": true, "viewport": true, "layered pane": true, "root pane": true, "split pane": true,
	"internal frame": true, "tool bar": true, "status bar": true, "landmark": true, "article": true, "block quote": true,
	"scroll pane": true, "application": true, "page tab list": true, "description list": true,
}

var atspiClicks = []string{"click", "press", "activate", "jump", "toggle", "open", "select"}

// Some toolkits, Chrome among them, leave action names empty; these roles
// then take their first action, the default one.
var atspiClickRoles = map[string]bool{"button": true, "link": true, "checkbox": true, "radio": true, "switch": true, "tab": true, "menuItem": true}

func atspiAvailable() bool {
	if os.Getenv("AT_SPI_BUS_ADDRESS") != "" {
		return true
	}
	return os.Getenv("DBUS_SESSION_BUS_ADDRESS") != ""
}

func (a *atspi) connect() (*dbus.Conn, error) {
	if a.conn != nil && a.conn.Connected() {
		return a.conn, nil
	}
	address := os.Getenv("AT_SPI_BUS_ADDRESS")
	if address == "" {
		session, err := dbus.SessionBusPrivate()
		if err != nil {
			return nil, errorf(CodeUnavailable, "no accessibility bus: %v", err)
		}
		defer session.Close()
		if err := session.Auth(nil); err != nil {
			return nil, errorf(CodeUnavailable, "no accessibility bus: %v", err)
		}
		if err := session.Hello(); err != nil {
			return nil, errorf(CodeUnavailable, "no accessibility bus: %v", err)
		}
		// Only read the bus: switching accessibility on would last beyond us, for every app.
		bus := session.Object("org.a11y.Bus", "/org/a11y/bus")
		if err := bus.Call("org.a11y.Bus.GetAddress", 0).Store(&address); err != nil {
			return nil, errorf(CodeUnavailable, "no accessibility bus: %v", err)
		}
	}
	conn, err := dbus.Connect(address)
	if err != nil {
		return nil, errorf(CodeUnavailable, "connect to the accessibility bus: %v", err)
	}
	a.conn = conn
	return conn, nil
}

func (a *atspi) Close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.conn != nil {
		_ = a.conn.Close()
		a.conn = nil
	}
}

func (a *atspi) call(ctx context.Context, conn *dbus.Conn, node atspiNode, method string, out any, args ...any) error {
	ctx, cancel := context.WithTimeout(ctx, atspiCallTimeout)
	defer cancel()
	call := conn.Object(node.Dest, node.Path).CallWithContext(ctx, method, 0, args...)
	if call.Err != nil {
		return call.Err
	}
	if out == nil {
		return nil
	}
	return call.Store(out)
}

type atspiDetails struct {
	role       string
	name       string
	states     [2]uint32
	interfaces []string
	extents    [4]int32
	actions    []string
	text       string
	children   []atspiNode
}

func (d atspiDetails) state(bit int) bool { return d.states[bit/32]&(1<<(bit%32)) != 0 }

func (d atspiDetails) has(iface string) bool { return slices.Contains(d.interfaces, iface) }

func (a *atspi) details(ctx context.Context, conn *dbus.Conn, node atspiNode, children bool) (atspiDetails, error) {
	var d atspiDetails
	var states []uint32
	obj := conn.Object(node.Dest, node.Path)
	ctx, cancel := context.WithTimeout(ctx, atspiCallTimeout)
	defer cancel()
	calls := []*dbus.Call{
		obj.GoWithContext(ctx, atspiAccessible+".GetRoleName", 0, nil),
		obj.GoWithContext(ctx, "org.freedesktop.DBus.Properties.Get", 0, nil, atspiAccessible, "Name"),
		obj.GoWithContext(ctx, atspiAccessible+".GetState", 0, nil),
		obj.GoWithContext(ctx, atspiAccessible+".GetInterfaces", 0, nil),
	}
	if children {
		calls = append(calls, obj.GoWithContext(ctx, atspiAccessible+".GetChildren", 0, nil))
	}
	var name dbus.Variant
	outs := []any{&d.role, &name, &states, &d.interfaces}
	var kids []atspiNode
	if children {
		outs = append(outs, &kids)
	}
	for i, call := range calls {
		<-call.Done
		if call.Err != nil {
			return d, call.Err
		}
		if err := call.Store(outs[i]); err != nil {
			return d, err
		}
	}
	d.name, _ = name.Value().(string)
	copy(d.states[:], states)
	d.children = kids

	var more []*dbus.Call
	if d.has(atspiComponent) {
		more = append(more, obj.GoWithContext(ctx, atspiComponent+".GetExtents", 0, nil, uint32(0)))
	}
	if d.has(atspiAction) {
		more = append(more, obj.GoWithContext(ctx, atspiAction+".GetActions", 0, nil))
	}
	readText := d.has(atspiText) && (d.state(atspiStateEditable) || d.name == "") && d.role != "password text"
	if readText {
		more = append(more, obj.GoWithContext(ctx, atspiText+".GetText", 0, nil, int32(0), int32(MaxElementText)))
	}
	for _, call := range more {
		<-call.Done
		if call.Err != nil {
			continue
		}
		switch call.Method {
		case atspiComponent + ".GetExtents":
			var box struct{ X, Y, W, H int32 }
			if call.Store(&box) == nil {
				d.extents = [4]int32{box.X, box.Y, box.W, box.H}
			}
		case atspiAction + ".GetActions":
			var actions []struct{ Name, Description, Key string }
			if call.Store(&actions) == nil {
				for _, action := range actions {
					d.actions = append(d.actions, action.Name)
				}
			}
		case atspiText + ".GetText":
			// Embedded objects show as U+FFFC; their own elements carry them.
			if call.Store(&d.text) == nil {
				d.text = strings.TrimSpace(strings.ReplaceAll(d.text, "\uFFFC", ""))
			}
		}
	}
	return d, nil
}

func (a *atspi) Tree(ctx context.Context, maxElements int) (Tree, error) {
	width, height, err := a.screen.size()
	if err != nil {
		return Tree{}, errorf(CodeUnavailable, "%v", err)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	conn, err := a.connect()
	if err != nil {
		return Tree{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, atspiReadTimeout)
	defer cancel()

	windows, err := a.windows(ctx, conn)
	if err != nil {
		return Tree{}, err
	}
	a.sequence++
	snapshot := atspiSnapshot{id: a.sequence}
	tree := Tree{Width: width, Height: height, Elements: []Element{}}
	var visit func(node atspiNode, d atspiDetails, depth int, parent string)
	visit = func(node atspiNode, d atspiDetails, depth int, parent string) {
		if tree.Truncated || depth > MaxTreeDepth || !d.state(atspiStateShowing) || d.extents[2] <= 0 && d.extents[3] <= 0 && depth > 0 {
			return
		}
		label := cmp.Or(d.name, d.text)
		repeats := atspiRoles[d.role] == "text" && label != "" && label == parent
		included := depth == 0 || a.meaningful(d) && !repeats
		if included {
			if len(tree.Elements) == maxElements || ctx.Err() != nil {
				tree.Truncated = true
				return
			}
			element, click := a.element(d, depth, width, height)
			element.Ref = fmt.Sprintf("e%d.%d", snapshot.id, len(snapshot.entries)+1)
			snapshot.entries = append(snapshot.entries, atspiEntry{node: node, signature: atspiSignature(d), element: element, click: click})
			tree.Elements = append(tree.Elements, element)
		}
		for _, child := range d.children {
			if tree.Truncated {
				return
			}
			details, err := a.details(ctx, conn, child, true)
			if err != nil {
				tree.Truncated = tree.Truncated || ctx.Err() != nil
				continue
			}
			next, name := depth, parent
			if included {
				next, name = depth+1, label
			}
			visit(child, details, next, name)
		}
	}
	for _, window := range windows {
		before := len(tree.Elements)
		visit(window.node, window.details, 0, "")
		if len(tree.Elements) == before+1 && window.details.name == "" {
			tree.Elements = tree.Elements[:before]
			snapshot.entries = snapshot.entries[:before]
		}
	}
	a.snapshots = append(a.snapshots, snapshot)
	if len(a.snapshots) > atspiSnapshots {
		a.snapshots = a.snapshots[1:]
	}
	return tree, nil
}

type atspiWindow struct {
	node    atspiNode
	details atspiDetails
}

func (a *atspi) windows(ctx context.Context, conn *dbus.Conn) ([]atspiWindow, error) {
	var apps []atspiNode
	if err := a.call(ctx, conn, atspiNode{atspiRegistry, atspiRoot}, atspiAccessible+".GetChildren", &apps); err != nil {
		return nil, errorf(CodeUnavailable, "read the accessibility registry: %v", err)
	}
	var windows []atspiWindow
	for _, app := range apps {
		var children []atspiNode
		if a.call(ctx, conn, app, atspiAccessible+".GetChildren", &children) != nil {
			continue
		}
		for _, child := range children {
			details, err := a.details(ctx, conn, child, true)
			if err == nil && details.state(atspiStateShowing) {
				windows = append(windows, atspiWindow{child, details})
			}
		}
	}
	if len(windows) == 0 {
		return nil, errorf(CodeUnavailable, "no window shares its interface: GTK and Qt apps do on their own, Chrome when started with --force-renderer-accessibility")
	}
	slices.SortStableFunc(windows, func(x, y atspiWindow) int {
		switch {
		case x.details.state(atspiStateActive) == y.details.state(atspiStateActive):
			return 0
		case x.details.state(atspiStateActive):
			return -1
		default:
			return 1
		}
	})
	return windows, nil
}

func (a *atspi) meaningful(d atspiDetails) bool {
	if a.clickIndex(d) >= 0 || d.state(atspiStateEditable) || d.state(atspiStateFocusable) {
		return true
	}
	if atspiPlain[d.role] {
		return d.name != ""
	}
	return d.name != "" || d.text != "" || atspiRoles[d.role] != ""
}

func (a *atspi) clickIndex(d atspiDetails) int32 {
	for _, name := range atspiClicks {
		if i := slices.Index(d.actions, name); i >= 0 {
			return int32(i)
		}
	}
	if len(d.actions) > 0 && atspiClickRoles[atspiRoles[d.role]] {
		return 0
	}
	return -1
}

func (a *atspi) element(d atspiDetails, depth, width, height int) (Element, int32) {
	role := atspiRoles[d.role]
	editable := d.state(atspiStateEditable)
	switch {
	case depth == 0 && role != "dialog":
		role = "window"
	case d.role == "text" || d.role == "combo box":
		role = map[bool]string{true: "textField", false: "text"}[editable]
		if d.role == "combo box" && !editable {
			role = "button"
		}
	case role == "":
		role = "group"
		if !atspiPlain[d.role] {
			role = "other"
		}
	}
	password := d.role == "password text"
	element := Element{Depth: depth, Role: role, Name: d.name}
	if editable && !password {
		element.Value = d.text
	} else if element.Name == "" {
		element.Name = d.text
	}
	unit := func(value int32, extent int) float64 {
		if extent <= 0 {
			return 0
		}
		return float64(value) / float64(extent)
	}
	element.Bounds = [4]float64{unit(d.extents[0], width), unit(d.extents[1], height), unit(d.extents[2], width), unit(d.extents[3], height)}
	click := a.clickIndex(d)
	interactive := click >= 0 || editable
	for _, state := range []struct {
		name string
		on   bool
	}{
		{"focused", d.state(atspiStateFocused)},
		{"selected", d.state(atspiStateSelected)},
		{"checked", d.state(atspiStateChecked)},
		{"disabled", interactive && !d.state(atspiStateEnabled)},
		{"editable", editable},
		{"password", password},
		{"scrollable", d.role == "scroll pane" || role == "web"},
		{"expanded", d.state(atspiStateExpanded)},
	} {
		if state.on {
			element.States = append(element.States, state.name)
		}
	}
	if click >= 0 || role == "button" || role == "link" {
		element.Actions = append(element.Actions, "click")
	}
	if d.state(atspiStateFocusable) {
		element.Actions = append(element.Actions, "focus")
	}
	if editable {
		element.Actions = append(element.Actions, "setText")
	}
	if slices.Contains(element.States, "scrollable") {
		element.Actions = append(element.Actions, "scrollForward", "scrollBackward")
	}
	return element, click
}

func atspiSignature(d atspiDetails) string {
	return strings.Join([]string{d.role, d.name, fmt.Sprint(d.extents)}, "\x00")
}

func (a *atspi) Element(ref, action string, text *string) error {
	ctx, cancel := context.WithTimeout(context.Background(), atspiReadTimeout)
	defer cancel()
	a.mu.Lock()
	entry, err := a.resolve(ref)
	conn := a.conn
	a.mu.Unlock()
	if err != nil {
		return err
	}
	current, err := a.details(ctx, conn, entry.node, false)
	if err != nil || current.state(atspiStateDefunct) || !current.state(atspiStateShowing) || atspiSignature(current) != entry.signature {
		return errorf(CodeInvalid, "%s changed or left the screen; read the tree again", ref)
	}
	b := entry.element.Bounds
	x, y := b[0]+b[2]/2, b[1]+b[3]/2
	switch action {
	case "click":
		if entry.click >= 0 {
			var done bool
			if err := a.call(ctx, conn, entry.node, atspiAction+".DoAction", &done, entry.click); err == nil && done {
				return nil
			}
		}
		return a.tap(x, y)
	case "focus":
		var done bool
		if err := a.call(ctx, conn, entry.node, atspiComponent+".GrabFocus", &done); err != nil || !done {
			return errorf(CodeFailed, "the app refused focus on %s", ref)
		}
		return nil
	case "setText":
		if !slices.Contains(entry.element.Actions, "setText") {
			return errorf(CodeUnsupported, "%s is not a text field", ref)
		}
		var done bool
		if current.has(atspiEditable) {
			if err := a.call(ctx, conn, entry.node, atspiEditable+".SetTextContents", &done, *text); err == nil && done {
				return nil
			}
		}
		if err := a.call(ctx, conn, entry.node, atspiComponent+".GrabFocus", &done); err != nil || !done {
			if err := a.tap(x, y); err != nil {
				return err
			}
		}
		return a.screen.replaceText(*text)
	case "scrollForward", "scrollBackward":
		if !slices.Contains(entry.element.Actions, action) {
			return errorf(CodeUnsupported, "%s does not scroll", ref)
		}
		amount := 0.5
		if action == "scrollBackward" {
			amount = -amount
		}
		return a.screen.Scroll(x, y, 0, amount)
	default:
		return errorf(CodeUnsupported, "element action %s is not supported here", action)
	}
}

func (a *atspi) tap(x, y float64) error {
	if err := a.screen.Pointer("down", x, y, "primary"); err != nil {
		return err
	}
	return a.screen.Pointer("up", x, y, "primary")
}

func (a *atspi) resolve(ref string) (atspiEntry, error) {
	var snapshot, index int
	if _, err := fmt.Sscanf(ref, "e%d.%d", &snapshot, &index); err != nil {
		return atspiEntry{}, errorf(CodeInvalid, "%s is not an element ref", ref)
	}
	for _, current := range a.snapshots {
		if current.id != snapshot {
			continue
		}
		if index < 1 || index > len(current.entries) {
			return atspiEntry{}, errorf(CodeInvalid, "%s is not in its tree", ref)
		}
		return current.entries[index-1], nil
	}
	return atspiEntry{}, errorf(CodeInvalid, "%s is from an old tree; read the tree again", ref)
}
