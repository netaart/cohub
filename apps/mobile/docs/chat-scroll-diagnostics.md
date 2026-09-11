# Chat Scroll Diagnostics

This is an opt-in Android investigation tool. The real chat timeline now disables Android's `scrollsChildToFocus` behavior independently of recording; the Test screen can compare the native default against this setting.

## Open And Record

1. In Profile or About, tap the version number five times, then open **Scroll Diagnostics**.
2. Enable **Recording**. The refresh icon starts a new recording and discards the previous one. The trash icon clears and stops it. The bookmark icon adds an experiment marker.
3. Use **Test** for synthetic messages, **Chats** to open a real loaded chat, and **Logs** to inspect recent events.
4. Reproduce one scenario, wait one second for trailing scroll events, then return and copy or share the log using the header icons. Export automatically pauses recording.
5. When recording, the real chat's more-actions menu includes **Scroll Diagnostics**. Opening it adds a marker. Android Back also returns to the diagnostics page when the chat was opened from its Chats tab.

Logs are memory-only and are cleared on app restart or authenticated navigation teardown (including sign-out/account changes). There is no upload. Export before restarting. Keep recordings short: only the latest 4,000 entries are retained; the page and export header report overwritten entries. The Logs tab displays the latest 150 entries, newest first; copy/share includes all retained entries in chronological order. Sharing sends text through the native share sheet; for a large recording, use clipboard copy if the share destination rejects it.

## Experiments

Keep the keyboard closed and wait for scrolling to stop before each tap. For each condition, restore the same visible text and test the upper, middle, and lower parts of the viewport. Test taps and long presses separately, without dragging the selection handles initially. Record whether the text under the finger moves and whether selection appears. Repeat each case three times.

- **Test / Paragraph / Inverted on**: one fixed message with 100 numbered lines in one Markdown paragraph. This uses the real MessageBubble, but no turn navigation, streaming, pagination, panel pager, or follow-tail logic.
- **Test / Markdown / Inverted on**: 18 sections with headings, paragraphs, bold/inline-code text, and lists. This checks selection across separately rendered text blocks.
- On Android, **Test > Focus scroll** controls the test list's native `scrollsChildToFocus` prop. It defaults to on (the existing native behavior). Compare on/off at the same text and viewport position, keeping Recording enabled. Each toggle remounts the test list to clear native text focus and selection, so scroll back to the target before repeating the tap/long press; do not count the reset as the bug. Check that selection still works and separately test dragging its handles to viewport edges. This switch affects only the synthetic Test list, not real chats opened through Chats or Bubble Layout.
- `fixture.focusScrollChange` records the old/new value and remount; all fixture scroll/touch events include `scrollsChildToFocus`. `fixtureFocusScroll` in the export metadata and experiment marker refers only to the test fixture.
- Repeat with **Inverted off**. Changing fixture or mode remounts the test list and emits `fixture.mode`; do not count the reset as the bug.
- **Chats**: open an affected real chat without a turn deep link. Use a completed long message, manually scroll to it, wait, then repeat the taps. Chat events must include `scrollsChildToFocus: false`. No diagnostic switch is needed to enable the real-chat fix. Confirm normal text selection/copy, dragging selection handles to viewport edges, keyboard show/hide, manual scrolling, turn jumps, and follow-tail while streaming. The prop also suppresses native child-rectangle visibility requests; handle-edge autoscrolling and hardware-keyboard focus navigation specifically need device verification.
- In the real chat, explicitly navigate to a turn and repeat. Also try dragging away while the turn window is loading. This exercises the existing asynchronous positioning/cancellation path without changing it.

Use separate recordings for each scenario. Accompany the exported log with the scenario, approximate tap location, whether it jumped, and a screen recording if available. Do not include private message content unnecessarily.

## Event Fields

Each JSONL record contains an increasing sequence, milliseconds since recording started, source, event name, and structured fields. The first line includes app/build/OTA/runtime, device/OS, viewport, font scale, theme, buffer limits, and diagnostic limitations.

- `touch.start/move/end/cancel`: native target, native timestamp, screen and local coordinates, touch count, elapsed press duration, and displacement. Move sampling is capped at 20 Hz. These are passive touch observers, not new press or gesture recognizers.
- `touch.windowMeasurement`: asynchronous window bounds of the observing bubble/list at touch start/end. Compare with screen touch coordinates; local coordinates belong to the native event target, not necessarily the bubble. Inverted transforms and callback latency must be considered.
- `bubble.layout`, `row.layout`, `list.layout`, `list.contentSize`: measured geometry. Bubble events include recording-local session/message aliases, role/sequence, text length, content-block types and text/thinking lengths, and typography, never message text.
- `list.scroll`: previous/new offset, delta, content height, viewport height, and the latest observed scroll metrics. Scroll sampling retains the chat's existing 100 ms throttle. `dragBegin/End` and `momentumBegin/End` distinguish user scroll phases.
- `command.scrollToIndex` / `command.scrollToOffset`: every explicit timeline scroll command in the chat screen, with caller source, target, animation, positioning options, and whether the list ref existed. The fixture emits no such commands.
- `turn.jumpStart/Resolved/Failed`: origin (navigator/deep link), local request number, and target/resolved sequence. `cancelledWhileWaiting` reports that the cancellation generation changed during the await; it is diagnostic only and does not suppress the original behavior.
- `turn.scrollRequest`, `retrySchedule`, `retryFire`, `indexFailed`, `targetVisible`, `cancel`: positioning lifecycle. Chat events snapshot pending/active sequence, retry state, cancel generation, dragging/momentum, follow-tail, initial-position completion, and pending follow frame.
- `tail.request`, `tail.followingChanged`, `chat.state`, `pagination.request`, `list.viewable`: competing automatic-scroll and data/layout context.
- `keyboard.show/hide`, `app.state`, `screen.observe/unobserve`: keyboard and lifecycle context. A mounted screen can remain below another route; the source and session alias distinguish its events.
- `focus.observed` / `blur.observed`: only focus events delivered to JS. Android selectable Text does not necessarily emit these through the parent View. Missing focus events do not rule out native focus.

## Interpretation Limits

A tap followed by a `command.*` event identifies an application scroll request, but does not by itself establish that it caused every observed movement. Match its target and timing to `list.scroll`. A scroll with no application command can come from native focus/selection, maintain-visible-content-position, layout, or direct interaction; it is not automatically proof of a native focus bug. The fixture removes the turn-specific paths to help narrow this down.

This tool does not instrument Android `requestChildFocus`, `requestChildRectangleOnScreen`, selection handles, or native call stacks. If JS events and the fixture cannot distinguish the cause, a native build with targeted Android instrumentation is the next step. Browser testing cannot validate this bug.
