//go:build linux && !android

package display

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/jezek/xgb/xproto"
)

func (s *x11Screen) Windows(context.Context) ([]Window, error) {
	width, height, err := s.size()
	if err != nil || width == 0 || height == 0 {
		return nil, errorf(CodeUnavailable, "%v", err)
	}
	ids := s.windowList("_NET_CLIENT_LIST_STACKING")
	if ids == nil {
		tree, err := xproto.QueryTree(s.conn, s.root).Reply()
		if err != nil {
			return nil, errorf(CodeFailed, "list X windows: %v", err)
		}
		ids = tree.Children
	}
	active := s.windowList("_NET_ACTIVE_WINDOW")
	windows := make([]Window, 0, len(ids))
	for _, id := range slices.Backward(ids) {
		attributes, err := xproto.GetWindowAttributes(s.conn, id).Reply()
		if err != nil || attributes.MapState != xproto.MapStateViewable || attributes.OverrideRedirect {
			continue
		}
		geometry, err := xproto.GetGeometry(s.conn, xproto.Drawable(id)).Reply()
		if err != nil || geometry.Width < 2 || geometry.Height < 2 {
			continue
		}
		at, err := xproto.TranslateCoordinates(s.conn, id, s.root, 0, 0).Reply()
		if err != nil {
			continue
		}
		title := s.text(id, "_NET_WM_NAME", "WM_NAME")
		app := s.class(id)
		if title == "" && app == "" {
			continue
		}
		bounds := (&Focus{Bounds: [4]float64{
			float64(at.DstX) / float64(width), float64(at.DstY) / float64(height),
			float64(geometry.Width) / float64(width), float64(geometry.Height) / float64(height),
		}}).clean()
		if bounds == nil || bounds.Bounds[2] == 0 || bounds.Bounds[3] == 0 {
			continue
		}
		windows = append(windows, Window{
			ID: fmt.Sprintf("x%x", uint32(id)), App: app, Title: title, Bounds: bounds.Bounds,
			Focused: slices.Contains(active, id),
		})
		if len(windows) == MaxWindows {
			break
		}
	}
	return windows, nil
}

func (s *x11Screen) atom(name string) xproto.Atom {
	reply, err := xproto.InternAtom(s.conn, true, uint16(len(name)), name).Reply()
	if err != nil {
		return xproto.AtomNone
	}
	return reply.Atom
}

func (s *x11Screen) windowList(name string) []xproto.Window {
	atom := s.atom(name)
	if atom == xproto.AtomNone {
		return nil
	}
	reply, err := xproto.GetProperty(s.conn, false, s.root, atom, xproto.AtomWindow, 0, 1<<16).Reply()
	if err != nil || reply.Format != 32 || reply.ValueLen == 0 {
		return nil
	}
	ids := make([]xproto.Window, 0, reply.ValueLen)
	for i := 0; i+4 <= len(reply.Value); i += 4 {
		ids = append(ids, xproto.Window(uint32(reply.Value[i])|uint32(reply.Value[i+1])<<8|uint32(reply.Value[i+2])<<16|uint32(reply.Value[i+3])<<24))
	}
	return ids
}

func (s *x11Screen) text(id xproto.Window, names ...string) string {
	for _, name := range names {
		atom := s.atom(name)
		if atom == xproto.AtomNone {
			continue
		}
		reply, err := xproto.GetProperty(s.conn, false, id, atom, xproto.GetPropertyTypeAny, 0, 1024).Reply()
		if err == nil && reply.Format == 8 && len(reply.Value) > 0 {
			return strings.ToValidUTF8(string(reply.Value), "")
		}
	}
	return ""
}

func (s *x11Screen) class(id xproto.Window) string {
	reply, err := xproto.GetProperty(s.conn, false, id, xproto.AtomWmClass, xproto.AtomString, 0, 256).Reply()
	if err != nil || len(reply.Value) == 0 {
		return ""
	}
	parts := strings.Split(strings.TrimRight(string(reply.Value), "\x00"), "\x00")
	return strings.ToValidUTF8(parts[len(parts)-1], "")
}
