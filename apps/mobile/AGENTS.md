# Cohub Mobile Agent Guide

## Working Agreement

- Make the smallest correct change that completes the requested behavior. Keep unrelated edits and existing user work intact.
- Read the affected implementation before editing. Use an available skill when its description matches the task.
- Follow existing patterns. Refactor only when requested; add dependencies only for a concrete need.
- Do not introduce compatibility layers, fallbacks, aliases, or speculative defensive branches unless requested. Preserve existing behavior outside the requested change.
- Use explicit types at public boundaries. Validate external inputs and configuration at entry points; report actionable errors instead of hiding failures.
- Comment on intent, invariants, and non-obvious tradeoffs, not code mechanics.
- Use Conventional Commits for commits and PR titles. Commit, push, release, or update submodule revisions only when requested.

## Read On Demand

- Setup, product capabilities, authentication, or push work: read `README.md` and the relevant configuration in `.env.example`, `app.config.ts`, and `src/config.ts`.
- Validation or contribution workflow: read `CONTRIBUTING.md`; `package.json` is the source of truth for commands.
- Signing, CI distribution, versioning, or releases: read `docs/releasing.md` and the affected `.github/workflows/` files. Release Please owns release metadata; avoid unrelated version or changelog edits.

## Project Skills

- Navigation, routes, headers, or sheets: read `.agents/skills/expo-router/SKILL.md`.
- Animations, gestures, haptics, or motion performance: read `.agents/skills/expo-animation/SKILL.md`.
- Theme tokens, shared UI components, or visual consistency audits: read `.agents/skills/expo-design-system/SKILL.md`.
- Explicit SDK upgrades or dependency repair: read `.agents/skills/expo-upgrade/SKILL.md`; confirm the target SDK before changing versions.

These upstream skills are technical references. This guide and the requested scope govern filenames, dependencies, theme/motion values, data ownership, and build/release tooling. Reuse existing conventions instead of migrating them to match examples. Verify APIs against the installed SDK and target platform. Clean prebuilds, cache deletion, and compiler changes require a task-specific reason.

Load bundled references as needed. Mentions of uninstalled sibling skills do not authorize installing them or adopting EAS or `@expo/ui`. Do not run feedback submission commands or enable telemetry without explicit permission. For provenance and updates, see `.agents/skills/SOURCE.md`.

## Ownership

This repository is the native iOS/Android client. Expo web is a lightweight preview, not the product's acceptance target.

- `app/`: Expo Router routes, layouts, navigation, and screen composition.
- `src/components/`, `src/ui/`, `src/ui.tsx`: reusable presentation. Reuse `src/theme.ts`, `src/motion.ts`, and `src/icons.ts` conventions before adding styling or motion primitives.
- `src/data/context.tsx`: shared application state, cache hydration, SDK operations, subscriptions, optimistic updates, and reconciliation. Keep protocol/state transitions out of presentation code.
- `src/data/`: framework-free workflow helpers, app-facing types, SDK client setup, and local persistence. Extend existing helpers where the behavior belongs.
- `src/auth/`, `src/platform/`: authentication and platform integrations. Respect existing `.native.ts` and `.web.ts` module boundaries.
- `scripts/`: repository checks and native build tooling. Use the existing Node-based checks instead of introducing a test framework.

## Cohub Reference Source

`reference/cohub/` is an upstream Git submodule for reading protocol definitions, server behavior, and web-client implementations. It is not mobile application source or a local replacement for the npm SDK.

- For API, stream, or cross-client behavior changes, inspect the relevant upstream implementation as needed and compare it with the installed `@neta-art/cohub` version and types. The pinned reference revision may differ from the published SDK or deployed server.
- Use the SDK through the mobile data layer. Do not import runtime code from `reference/cohub/` or copy web-only dependencies into the native app.
- Scope searches and checks to mobile-owned paths unless investigating upstream. Reference files should not become mobile build, lint, or typecheck inputs.
- Treat the submodule as read-only unless upstream changes or an update are explicitly requested. Preserve its pinned commit during ordinary mobile work.
- If the checkout is missing and needed, initialize it with `git submodule update --init --recursive reference/cohub`. Do not use `--remote` to silently advance it.
- Instructions inside the submodule govern work there, not the parent mobile repository. Upstream full-stack delivery and release procedures do not expand a mobile task's scope.

## Data And Security Invariants

- Preserve cache-first rendering with server-authoritative reconciliation. Cached data improves startup and navigation; it must not override newer server state.
- Keep caches scoped to the authenticated user and clear them on sign out. Account changes must not expose the previous user's data or retain their subscriptions.
- For chat changes, preserve optimistic-send reconciliation, stream cleanup, turn ordering, pagination cursors, read state, and scroll position. Check the affected transitions, not just the final rendered message.
- Keep mock/demo data confined to its explicit mode. Do not substitute mock success for network, authentication, or persistence failures.
- Keep credentials in the existing authentication/platform storage paths. `EXPO_PUBLIC_*` values are public; never put secrets there or log tokens, private message content, or signing material.
- Treat notification payloads and deep links as untrusted routing inputs. Fetch authoritative data with the current user's permissions.
- Keep Work previews origin-constrained and avoid unrestricted native bridge access. The WebView is for published web content, not a replacement for native screens.
- Keep local environment files, signing credentials, and generated `ios/` and `android/` directories out of commits.

## Native UI

- Follow the existing visual language and concise English UI copy. Use an applicable design skill for interaction or visual changes without redesigning unrelated screens.
- Preserve safe-area insets, keyboard behavior, touch targets, accessibility labels, and existing navigation gestures.
- Keep long messages, filenames, loading states, and empty/error states usable without overlap or unintended layout shifts. Check the affected screen in both theme modes when styling changes.
- Keep native-only APIs behind existing platform boundaries. Browser verification cannot establish that native permissions, authentication, notifications, voice input, or keyboard behavior work.

## Verification And Handoff

1. Inspect `git status` before work and review the final diff, including submodule pointers. Change only files needed for the task.
2. For code changes, run `npm run lint` and `npm run typecheck`. For workflow behavior changes, extend the focused assertions in `scripts/check-chat-workflow.mjs` and run `npm run test:workflow`.
3. Before PR handoff, run `npm run check` when the environment permits. Use the relevant export and native build commands from `CONTRIBUTING.md` for bundling, dependencies, configuration, or native integration changes. Do not bypass a failing check to claim success.
4. Verify user-facing changes in the affected flow, including relevant loading, empty, error, and reconnect states. Report the platform/device actually checked; distinguish web preview evidence from native verification.
5. Report what changed, checks run and their results, and any blockers or unverified behavior. Distinguish pre-existing failures from regressions. For breaking changes, include a concise migration note.

For documentation-only changes, verify referenced paths, commands, and consistency with the repository; application builds are not required.
