# Bubble Layout Acceptance

Open **Debug > Bubble Layout** (tap the Profile/About version five times to open Debug). The page uses the production MessageBubble/StreamCard, not a second renderer. No backend requests or synthetic chat submissions are made by the fixtures. Link and image interactions remain real.

## Layout Rules

- User and assistant bubbles share the maximum-width calculation, padding, and metadata placement. Role only changes alignment, colors, and the sent checkmark.
- Ordinary short text is content-sized. Structured blocks (code, tables, lists, quotes, tools, galleries) have bounded widths so their nested rows remain usable.
- For completed messages, the last visible text block measures native line rectangles and the timestamp/status area. Single-line text may expand within the bubble cap to fit metadata. Multi-line text is never narrowed to reserve a timestamp column.
- Metadata shares the final line only when its measured right-hand space fits the whole metadata area plus an 8 pt gap. Its bottom sits 2 pt below the text line when height permits. Otherwise it occupies its own right-aligned row.
- Code/table/image/tool endings get a separate metadata row outside the framed content. Empty trailing text and hidden tool results do not take ownership of the timestamp. Errors, content-only records, and text-only records use the same composition.
- During streaming, the timestamp stays in its own row outside the growing text's measurement cycle. Each append changes the text measurement key; previously that reset the footer to a new row and then pulled it inline again, even without a line break (a replay measured 48 -> 64 -> 48 pt). Completed messages retain the measured inline placement. Glyph reveal/fade timing is unchanged.
- Measurements are asynchronous: the unmeasured completed-message state reserves a separate footer row, and native layout results determine the final placement. Verify settling and streaming on device; Node assertions cannot validate native frame timing.
- Model/token labels and message actions remain outside the bubble. This change does not alter turn navigation, selection handlers, or scroll-to-turn behavior.

## Controls

- **Text / Rich / States**: 29 fixed cases, each rendered once as a user and once as an assistant. Includes Chinese/English, multi-line and multi-screen text, emoji/combining marks, RTL, unbroken tokens, formatted text, heading/list/quote endings, code, tables, bundled images, nested tool output, sending/errors, missing summaries, invalid dates, and empty records.
- **Boundary**: 12 progressively longer messages, paired across roles, for the exact point where metadata stops fitting on the last line.
- **Stream**: start/pause, restart, and interrupt an incremental reply; compare the completed MessageBubble with the live StreamCard.
- **280 pt** constrains the specimen viewport. **Inverted** changes list direction. Test both along with a normal phone-width viewport.
- The sun/moon button and size options change the real app appearance preferences. Restore your preferred settings after testing. For additional scaling, use the Android system font setting.
- **Record** starts a fresh memory-only diagnostic log (replacing any existing scroll recording). The bookmark inserts a marker; Copy pauses recording and copies all retained entries. The shared recorder retains 4,000 entries and reports overwritten entries in the export header.

## Device Checklist

1. Compare Short reply and Short request in light/dark mode. Neither role should have a mostly empty full-width bubble.
2. Compare Boundary cases in default/xlarge app text and 280 pt/full width. The footer must be wholly on the final line or wholly below it, never covering characters, links, or checkmarks.
3. Check explicit newlines, mixed direction, long tokens, and multi-screen paragraphs. No horizontal overflow; earlier lines must not become a narrow column to accommodate the time.
4. Check all Rich cases. Expand the tool result and open the gallery. Nested code/table content must remain inside its available width; time must not appear inside a code/table/image frame.
5. Check sending/error and missing-summary cases. The error must remain legible, exactly one metadata area should appear, and the content must not change when an optional summary exists. An empty record should have no bubble; an invalid assistant timestamp should reserve no metadata row.
6. Start the stream, pause, resume, interrupt, restart, and let it finish. Watch the footer as new lines and Markdown blocks appear, especially while reading away from the bottom. Note any repeated height oscillation or visible settling.
7. Repeat taps, long presses, selection, and scrolling in an actual chat. This work is not a fix for Android selection-induced scrolling.

For a failure, report case number/group, role, viewport mode, font size, theme, and action. Include a screenshot or recording and the copied log. `bubble.metaLayout` includes message/session aliases, text and metadata measurements, last-line rectangle, requested minWidth, footer marginTop, and inline decision. It contains no message text. The existing Scroll Diagnostics page records explicit chat scroll commands separately.

## Automated Coverage

`npm run test:workflow` checks metadata geometry at multiple widths/scales and executes the real Markdown JSX composition with lightweight native leaf stubs to verify footer forwarding, uniqueness, and a separate streaming footer across every prefix of a mixed Markdown reply. These are not native screenshot tests. Use `npm run check`, `npm run export:android`, and `npm run export:ios` for code/bundle validation.
