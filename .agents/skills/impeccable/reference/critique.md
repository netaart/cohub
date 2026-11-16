# Critique

A UX design review of one concrete target (a source file, component, or URL). Judge it as a design director would, against PRODUCT.md and DESIGN.md. Read the source and, when a browser is available, look at the rendered result at desktop and mobile sizes.

Form the design judgment first, then do the mechanical checks, so measurable findings do not anchor taste.

## What to evaluate

**Design specificity.** Is the composition, interaction, and visual language grounded in this product, or could an unrelated product use it unchanged? Category-default structure (card grids, hero-metric dashboards, generic empty states) is a finding, not a neutral choice.

**Hierarchy and clarity.** With detail blurred, are the primary action, the secondary content, and the major groups still obvious, in that order? Does every element earn its place?

**Cognitive load.** Each failure below adds load; four or more is a critical finding.
- Single focus: the primary task is not competing with other elements.
- Chunking and grouping: information arrives in small, visibly related groups.
- Minimal choices: no more than about four visible options at a decision point.
- Working memory: nothing must be remembered from a previous screen to act on this one.
- Progressive disclosure: complexity appears only when needed.

**Nielsen's heuristics.** Check each; score 0-4 only when a number helps the caller.
1. Visibility of system status: loading, saving, syncing, running, and failure are always visible.
2. Match with the real world: the user's language and conventions, not internal jargon.
3. User control and freedom: undo, cancel, back, and escape from every state.
4. Consistency and standards: same thing, same name, same look, same place.
5. Error prevention: constraints, safe defaults, confirmation only for destructive acts.
6. Recognition over recall: options, history, and context are visible.
7. Flexibility and efficiency: shortcuts, bulk actions, and fast paths for experts.
8. Aesthetic and minimalist design: no element competes without a job.
9. Error recovery: errors say what happened and what to do, in plain words.
10. Help: guidance is in context, where the question arises.

**States and edges.** Loading, empty, error, success, disabled, long content, missing content, slow network, and first run.

**Personas.** Walk the primary action as two or three of these, plus one derived from PRODUCT.md's users. Report what broke for them, naming elements, not generic descriptions.
- **Power user:** skips onboarding, expects keyboard shortcuts, bulk actions, and no slow or unskippable animation.
- **First-timer:** needs obvious next steps, plain labels, and no icon-only mystery controls.
- **Accessibility-dependent:** keyboard only or screen reader; needs focus visibility, labels, contrast, and reduced motion.
- **Stress tester:** long text, huge lists, rapid repeat clicks, interrupted flows, offline.
- **Distracted mobile user:** one thumb, intermittent attention, small screen, needs large targets and resumable flows.

## Severity

| Level | Meaning |
|---|---|
| **P0** | Blocks task completion |
| **P1** | Significant difficulty, confusion, or a WCAG AA failure; fix before release |
| **P2** | Annoyance with a workaround |
| **P3** | Polish with no real user impact |

Unsure between two levels: would a user contact support about it? If yes, it is at least P1.

## Findings

Lead with the specificity verdict and the 3-5 most important issues, ordered by impact. For each: what is wrong, where (element, file), why it matters to users, and the concrete fix. Note what works and should be kept. Be direct and specific; cut "consider exploring". Keep P3s few so they do not bury what matters.
