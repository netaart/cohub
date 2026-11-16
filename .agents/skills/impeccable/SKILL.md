---
name: impeccable
description: "Use when the user wants to design, redesign, shape, critique, audit, polish, simplify, harden, animate, or otherwise improve a frontend interface: product UI, dashboards, components, forms, settings, onboarding, empty states, and landing pages. Handles UX review, hierarchy, layout, typography, color, motion, UX copy, accessibility, responsive behavior, and edge cases. Also for making bland UI bolder or loud UI quieter. Not for backend-only or non-UI tasks."
metadata:
  upstream: https://github.com/pbakaus/impeccable (v4.9.2, trimmed to the core guidance)
---

Design like an award-winning design director: production-grade code, a clear point of view, and a deep grasp of what the product and its users need.

Core principles:
- Finish the job. No hedging, no shortcuts: the deliverable is complete, except assets the user must provide.
- Scale ambition to the surface's mode (see Modes). On Operate and Read, ambition shows as precision and restraint, and patterns the visitor already knows earn their place.
- Verify by looking at the rendered result at the sizes it ships at, and batch the checks: fix what one look shows before looking again.

## Setup

1. Read the project context: [PRODUCT.md](../../context/PRODUCT.md) (users, purpose, voice) and [DESIGN.md](../../context/DESIGN.md) (visual system, tokens, components, motion). They are binding; do not invent missing context.
2. Load the playbook for the requested command from the table below. For app UI, also read [reference/operate.md](reference/operate.md).
3. Immediately before any UI edit, including small refinements, read [reference/craft-floor.md](reference/craft-floor.md): the quality floor and absolute bans. Skip it for planning-only work.

## How to design

- **The brief wins.** Honor pinned aesthetics, fonts, and palettes. Redirecting a clear brief toward your taste is failure.
- **Refinement preserves; redesign replaces.** Refinement keeps the incumbent identity, behavior, copy, and everything outside scope. Ask before replacing factual copy or adding claims. A redesign keeps product truth, content, and function, but needs the user's explicit go-ahead and ends with DESIGN.md updated.
- **Work inside the system.** Reuse the tokens, shared primitives, and patterns DESIGN.md names before adding new ones.

## Modes

The mode names what the visitor's success looks like on this surface. Choose it from the surface, not the product.

- **Operate:** the visitor completes a task. App UI, dashboards, editors, settings, tools. Scanability, consistency, native expectations, and the real usage scene outrank expression. Brand lives in precise details.
- **Read:** the visitor understands something. Docs, guides, changelogs. Structure for comprehension first.
- **Persuade:** the visitor decides and acts. Landing pages, marketing, pricing. Earn attention and action with bold, distinct work.
- **Experience:** the visitor is inside the work itself, such as a Board or a showcase. Let the artifact lead; the interface recedes.

## Commands

| Command | Description | Reference |
|---|---|---|
| `shape [feature]` | Plan UX/UI before writing code | [reference/shape.md](reference/shape.md) |
| `extract [target]` | Pull reusable tokens and components into the design system | [reference/extract.md](reference/extract.md) |
| `critique [target]` | UX design review: heuristics, cognitive load, personas | [reference/critique.md](reference/critique.md) |
| `audit [target]` | Technical quality checks (a11y, perf, theming, responsive) | [reference/audit.md](reference/audit.md) |
| `polish [target]` | Final quality pass before shipping | [reference/polish.md](reference/polish.md) |
| `bolder [target]` | Amplify safe or bland designs | [reference/bolder.md](reference/bolder.md) |
| `quieter [target]` | Tone down aggressive or overstimulating designs | [reference/quieter.md](reference/quieter.md) |
| `distill [target]` | Strip to essence, remove complexity | [reference/distill.md](reference/distill.md) |
| `harden [target]` | Production-ready: errors, i18n, edge cases | [reference/harden.md](reference/harden.md) |
| `onboard [target]` | First-run flows, empty states, activation | [reference/onboard.md](reference/onboard.md) |
| `animate [target]` | Purposeful animation and motion | [reference/animate.md](reference/animate.md) |
| `colorize [target]` | Strategic color for monochromatic UIs | [reference/colorize.md](reference/colorize.md) |
| `typeset [target]` | Typography hierarchy and fonts | [reference/typeset.md](reference/typeset.md) |
| `layout [target]` | Spacing, rhythm, and visual hierarchy | [reference/layout.md](reference/layout.md) |
| `delight [target]` | Personality and memorable touches | [reference/delight.md](reference/delight.md) |
| `clarify [target]` | UX copy, labels, and error messages | [reference/clarify.md](reference/clarify.md) |
| `adapt [target]` | Different devices and screen sizes | [reference/adapt.md](reference/adapt.md) |
| `optimize [target]` | Diagnose and fix UI performance | [reference/optimize.md](reference/optimize.md) |

Routing:

- **Explicit or clearly implied command:** load its reference and follow it. Ask once if two commands fit.
- **No argument:** suggest the two or three commands that fit the current context; never auto-run one.
- **Otherwise:** treat the request as general design work under Setup and How to design.
