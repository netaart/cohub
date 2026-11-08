package display

import (
	"fmt"
	"strings"
)

type stopHint struct{ hint, next string }

var stopHints = map[string]stopHint{
	"not_found":   {"Nothing on the screen matched. Look, then target a name it shows, or a ref.", "look"},
	"ambiguous":   {"Several elements matched: pick a candidate by its ref, or narrow by role or position.", ""},
	"moved":       {"The screen changed under that point since you looked. Look again and aim at what shows now, by name where you can.", "lookImage"},
	"timeout":     {"What the step waited for never came. Look at where the screen is; wait longer only if it is still loading.", "look"},
	"dialog":      {"A dialog opened: read it, then act inside it or dismiss it before going on.", "look"},
	"app_changed": {"Another app came to the front. Look, and go back if that was not meant to happen.", "look"},
	"failed":      {"The machine refused the step. Look before trying another way.", "look"},
	"preempted":   {"A person is using the display: wait until they are done, then look again. Never fight for control.", ""},
	"interrupted": {"A person stopped this: do not go on with this Turn on the display; ask them.", ""},
}

func (r *actRun) hint() {
	stop := r.result.Stopped
	if stop == nil {
		return
	}
	rule := stopHints[stop.Reason]
	stop.Hint, stop.Next = rule.hint, rule.next
	info, _ := r.hub.Display(r.info.ID)
	switch {
	case stop.Reason == "not_found" && r.tree != nil && scroller(*r.tree).Ref != "":
		stop.Hint = "Nothing on the screen matched, but a list there scrolls: scroll it for the target, or look and target what shows."
	case stop.Reason == "failed" && len(info.Needs) > 0:
		stop.Hint, stop.Next = fmt.Sprintf("The display needs %s, which only the person at the machine can grant: ask them.", strings.Join(info.Needs, " and ")), ""
	case stop.Next == "lookImage" && !r.info.Capture:
		stop.Next = "look"
	}
}
