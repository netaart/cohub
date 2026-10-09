# Expo Skills Assessment

Reviewed upstream commit `d0075ffa09928f1edb3e7ac4f5af07586d4b344d`. This is a selection assessment, not an installation or verification of every Expo API example.

## Project Fit

Cohub Mobile uses Expo 57, Expo Router, Reanimated 4, Gesture Handler, and Expo Haptics ([package.json](../package.json)). It already has shared [theme](../src/theme.ts) and [motion](../src/motion.ts) values. Data flows through the Cohub SDK and the existing data layer, with user-scoped SQLite caching ([README](../README.md)). Builds use GitHub Actions and native scripts; EAS is not required ([releasing](releasing.md)).

## Recommended First Batch

All recommendations require the project-specific boundaries below; these are technical references, not authorization to migrate existing code.

| Skill | Value for this project | Boundary |
| --- | --- | --- |
| [expo-router][router] | Existing routes, stacks, sheets, headers, and deep links | Preserve existing filenames and navigation unless the task requests a change. Check SDK/platform support for examples. |
| [expo-animation][animation] | Direct match for installed Reanimated, Worklets, Gesture Handler, and Haptics | Reuse `src/motion.ts`; do not replace shared timings or tab behavior solely to match the skill. Verify gestures and performance on native builds. |
| [expo-design-system][design] | Explicitly adopts an existing theme before introducing one; useful for component consistency and drift audits | Extend `src/theme.ts` and current UI primitives, not a parallel theme directory. Keep cleanup scoped to the task. |
| [expo-upgrade][upgrade] | Dependency alignment, Expo Doctor, native rebuilds, and migration references | Only run for an authorized upgrade/repair, with an explicit target version. Cache deletion, clean prebuild, compiler changes, and dependency removals are not routine steps for unrelated work. |

## Add On Demand

- [expo-module][module]: useful when writing a local Swift/Kotlin module or config plugin. Existing native integrations alone do not require creating a new module.
- [expo-examples][examples]: useful when adding a third-party integration; adapt a version-matched example, never scaffold over this repository.
- [expo-data-fetching][data]: useful network, cancellation, and offline reference, but its trigger covers every request and its examples include React Query/SWR and web route loaders. Keep the Cohub SDK, existing state owner, auth storage, and SQLite cache; do not add a parallel fetching architecture.

## Defer

- [expo-native-ui][native-ui] and [expo-ui][ui]: prefer `@expo/ui`, which this project does not currently depend on. Native UI also prescribes kebab-case filenames, inline styles, a different icon preference, and an Expo-Go-first workflow. Its broad Expo Go claims should not override this project's documented native push and authentication prerequisites. Adopt only after reconciling these directions with project conventions.
- [expo-overview][overview]: useful general routing guidance, but its broad trigger and mandatory `expo-ui` consultation pull in skills beyond the selected set. It also routes store/build tasks toward EAS. Prefer focused task pointers in the root `AGENTS.md` for this existing project.
- `expo-project-structure`, `expo-web-to-native`, `expo-brownfield`: target new projects or migration scenarios, not current mobile maintenance.
- `expo-dom`: not needed for the current origin-constrained published Work WebView. DOM components are a separate architectural choice, not a drop-in replacement.
- `expo-app-clip`, experimental `expo-migrate-module`: add only for an explicit App Clip or native module migration task.
- All `eas-*` skills: defer until adopting the corresponding EAS service. Current build and release ownership remains in GitHub Actions and Release Please.
- [expo-dev-client][dev-client]: the concept is relevant, but the current instructions center on EAS profiles, including remote version ownership. Even its local build examples use `eas build --local`; current repository scripts are the appropriate workflow.
- `expo-skill-feedback`: not needed for application development. Do not send project information or enable telemetry without explicit permission.

The complete upstream inventory and installation options are in the [upstream README][readme]. Deferred inventory items were screened by their documented purpose; the linked candidates and conflict-heavy skills were inspected directly.

## Proposed Installation Boundaries

1. Install the four recommended skills under `.agents/skills/<skill-name>/`, including their referenced files (for example, `expo-animation/RECIPES.md` and each skill's `references/`). Copying only `SKILL.md` loses required context.
2. Retain the upstream [MIT license][license] and record source URL, commit, selected skills, and any local edits. Review updates deliberately rather than tracking upstream implicitly.
3. Add concise task-specific pointers to `AGENTS.md`. State that existing project conventions and the task scope govern dependency choices, filenames, theme/motion values, data ownership, and build/release tooling.
4. Treat sibling skill mentions as references, not permission to automatically install the entire collection. Resolve needed sibling guidance deliberately.
5. Do not execute bundled feedback commands or enable telemetry as part of normal development. The upstream README says automatic telemetry is off by default; feedback submission is separate.
6. Validate local reference paths after installation. Skill installation must not change application dependencies, release configuration, or the `reference/cohub` revision.

The four recommended skills were subsequently installed under `.agents/skills/` at the reviewed commit. See [source and maintenance notes](../.agents/skills/SOURCE.md); project-specific usage boundaries are recorded in the root `AGENTS.md`.

[readme]: https://github.com/expo/skills/blob/d0075ffa09928f1edb3e7ac4f5af07586d4b344d/README.md
[license]: https://github.com/expo/skills/blob/d0075ffa09928f1edb3e7ac4f5af07586d4b344d/LICENSE
[router]: https://github.com/expo/skills/blob/d0075ffa09928f1edb3e7ac4f5af07586d4b344d/plugins/expo/skills/expo-router/SKILL.md
[animation]: https://github.com/expo/skills/blob/d0075ffa09928f1edb3e7ac4f5af07586d4b344d/plugins/expo/skills/expo-animation/SKILL.md
[design]: https://github.com/expo/skills/blob/d0075ffa09928f1edb3e7ac4f5af07586d4b344d/plugins/expo/skills/expo-design-system/SKILL.md
[upgrade]: https://github.com/expo/skills/blob/d0075ffa09928f1edb3e7ac4f5af07586d4b344d/plugins/expo/skills/expo-upgrade/SKILL.md
[module]: https://github.com/expo/skills/blob/d0075ffa09928f1edb3e7ac4f5af07586d4b344d/plugins/expo/skills/expo-module/SKILL.md
[examples]: https://github.com/expo/skills/blob/d0075ffa09928f1edb3e7ac4f5af07586d4b344d/plugins/expo/skills/expo-examples/SKILL.md
[data]: https://github.com/expo/skills/blob/d0075ffa09928f1edb3e7ac4f5af07586d4b344d/plugins/expo/skills/expo-data-fetching/SKILL.md
[native-ui]: https://github.com/expo/skills/blob/d0075ffa09928f1edb3e7ac4f5af07586d4b344d/plugins/expo/skills/expo-native-ui/SKILL.md
[ui]: https://github.com/expo/skills/blob/d0075ffa09928f1edb3e7ac4f5af07586d4b344d/plugins/expo/skills/expo-ui/SKILL.md
[overview]: https://github.com/expo/skills/blob/d0075ffa09928f1edb3e7ac4f5af07586d4b344d/plugins/expo/skills/expo-overview/SKILL.md
[dev-client]: https://github.com/expo/skills/blob/d0075ffa09928f1edb3e7ac4f5af07586d4b344d/plugins/expo/skills/expo-dev-client/SKILL.md
