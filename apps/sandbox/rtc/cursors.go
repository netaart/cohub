package rtc

import (
	"maps"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/cohub/apps/sandbox/display"
)

const cursorInterval = display.CursorIntervalMs * time.Millisecond

type Cursor struct {
	UserID string  `json:"userId"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
}

type cursorState struct {
	cursor  Cursor
	display string
}

func (m *Manager) cursor(current *session, x, y *float64) {
	if current.userID == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if x == nil || y == nil || math.IsNaN(*x) || math.IsNaN(*y) {
		if _, ok := m.cursors[current.id]; !ok {
			return
		}
		delete(m.cursors, current.id)
	} else {
		at := Cursor{UserID: current.userID, X: min(max(*x, 0), 1), Y: min(max(*y, 0), 1)}
		if was, ok := m.cursors[current.id]; ok && was.cursor == at {
			return
		}
		m.cursors[current.id] = cursorState{cursor: at, display: current.display}
	}
	m.scheduleCursorsLocked(current.display)
}

func (m *Manager) scheduleCursorsLocked(display string) {
	if m.cursorTimers[display] != nil {
		return
	}
	m.cursorTimers[display] = time.AfterFunc(cursorInterval, func() {
		m.mu.Lock()
		delete(m.cursorTimers, display)
		byUser := map[string]cursorState{}
		for _, state := range m.cursors {
			if state.display == display {
				byUser[state.cursor.UserID] = state
			}
		}
		all := slices.Collect(maps.Values(byUser))
		var viewers []*session
		for _, current := range m.sessions {
			if current.display == display {
				viewers = append(viewers, current)
			}
		}
		m.mu.Unlock()
		slices.SortFunc(all, func(a, b cursorState) int { return strings.Compare(a.cursor.UserID, b.cursor.UserID) })
		for _, viewer := range viewers {
			others := make([]Cursor, 0, len(all))
			for _, state := range all {
				if state.cursor.UserID != viewer.userID {
					others = append(others, state.cursor)
				}
			}
			viewer.send(controlMessage{Type: "cursors", Cursors: &others})
		}
	})
}

func (m *Manager) forgetCursor(current *session) {
	m.cursor(current, nil, nil)
}
