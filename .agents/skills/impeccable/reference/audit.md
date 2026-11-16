# Audit

A code-level technical quality check, not a design critique. Check what is measurable and verifiable in the implementation, verify each finding in context, and call out false positives. Document issues; do not fix them during the audit.

## Accessibility

- **Contrast:** text below 4.5:1, or below 3:1 for large text and UI components.
- **Semantics:** heading hierarchy, landmarks, real buttons and links instead of clickable divs.
- **Names and states:** interactive elements without accessible names, roles, or state (expanded, selected, pressed).
- **Keyboard:** visible focus, logical tab order, no traps, Esc closes layers.
- **Forms:** labels, required indicators, and errors tied to their fields.
- **Images:** missing or useless alt text.
- **Motion:** `prefers-reduced-motion` keeps meaningful feedback (color, opacity, state) while removing movement; a global near-zero-duration kill is a defect, as is flashing or motion that blocks reading or input.

## Performance

- Layout thrashing: reading and writing layout in the same loop.
- Animating layout properties instead of `transform` / `opacity`; unbounded blur, filter, or shadow effects that drop frames.
- `will-change` applied broadly or left on at rest.
- Unoptimized or eagerly loaded images; missing dimensions causing layout shift.
- Unnecessary re-renders, unused imports, oversized dependencies.

## Theming

- Hard-coded colors or values that bypass design tokens.
- Wrong or mixed tokens; values that do not follow theme switches.
- Broken or low-contrast states in any supported theme.

## Responsive and touch

- Fixed widths, horizontal overflow, and layouts that break when text size increases.
- Touch targets under 44x44 px (WCAG 2.5.8 floor is 24x24 CSS px unless spacing or an equivalent control covers it).
- Hover-only affordances with no touch path.
- Broken touch gestures: mouse-only handlers, missing `touch-action` on pointer drag surfaces, drag state not cleared on cancel or lost capture, controls that swallow page scroll.
- Content hidden behind safe-area insets or the on-screen keyboard.

Say what produced the evidence (source reading, emulated viewport, synthesized touch, real device) and what stayed untested.

## Implementation integrity

Repeated shortcuts, one-off components where a shared primitive exists, design-system drift, misleading or placeholder content, and structure interchangeable with an unrelated product.

## Severity

**P0** blocks task completion. **P1** is significant difficulty or a WCAG AA failure. **P2** is an annoyance with a workaround. **P3** is polish with no real user impact.

## Findings

For each issue: severity, location (component, file, line), category, user impact, standard violated if any, and the fix. Group recurring problems into systemic patterns ("hard-coded colors in 15+ components"). Keep P3s few.
