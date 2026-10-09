# Mobile Data Synchronization Strategy

Status: the first HTTP synchronization implementation, focused Space realtime subscriptions, and account-wide Running discovery are included in this change. Notification-triggered refresh remains intentionally excluded. The policy tables describe the target design; see Implemented Scope for the exact implemented subset.

## Scope And Evidence

Keep foreground data fresh without requiring pull-to-refresh, especially Chat lists and execution state. Preserve cache-first rendering, optimistic sends, history windows, pagination, and account isolation. Background execution is not a realtime guarantee on iOS or Android.

Inspected on 2026-09-16:

- Installed `@neta-art/cohub`: `8.16.0`, including `dist/chunks/http.d.ts`, `http.js`, and `environment.d.ts`.
- Read-only upstream reference: `0897a61da7cb4949522d4bdbfc03c72af8abec7b`; its SDK package is `8.10.0`, older than the installed SDK.
- Mobile implementation and upstream API, gateway, and web synchronization code. No authenticated production requests or native-device verification were performed. SDK support and reference-server behavior do not prove deployed-server behavior.

## Baseline Before Implementation

| Data | Current automatic update | Limitation |
| --- | --- | --- |
| Home Chats and Spaces | Initial load, foreground entry, and every 60 seconds while active | Always fetches Spaces plus the first 60 Chats, regardless of visible screen |
| List status | Latest-turn request per recent Chat after home refresh, pagination, selected filters, and transport recovery; up to six concurrent requests | Default 30-minute lookback; no shared per-session request deduplication; long-running older Chats are excluded |
| Open Chat | Generation stream and persisted events; snapshot reseed and tail reconciliation on foreground/reconnect | Subscriptions follow mounted readers, not strictly screen focus; no periodic reconciliation for a missed event on an apparently open connection |
| Source-filtered Chats | Initial/filter load and explicit reload | Separate pages are not refreshed by the global home timer |
| Spaces tab overview | Focus, foreground, and 60-second timer while focused | Separate from home Spaces refresh |
| Space detail Chats, Saves, Works, Tasks | Focus with freshness checks; manual refresh | Staying on the screen does not periodically reload its resources |
| Files | Initial/path load and manual refresh | No filesystem event invalidation or periodic refresh |
| Activity and credits | Focus, foreground, and 60-second timer while focused | Separate scheduler; effect currently skips polling when WebSocket state is reconnecting |
| Models | Catalog cached in memory; status has a 60-second freshness check on demand | Freshness check is not a periodic timer |
| Settings data | Several hooks refresh on focus and after mutations | No unified policy for prolonged foreground viewing or return from background |
| Notifications | Notification-tap routing and authoritative Chat loading | No foreground notification-received invalidation of shared data |

Relevant implementation: [context.tsx](../src/data/context.tsx), [session-status.ts](../src/data/session-status.ts), [use-source-sessions.ts](../src/data/use-source-sessions.ts), [use-activity.ts](../src/data/use-activity.ts), [Spaces tab](../app/(tabs)/spaces.tsx), [Space detail](../app/space/[spaceId]/index.tsx), and [Files](../app/space/[spaceId]/files.tsx).

Two issues should be addressed before increasing frequency:

1. `refreshHome()` starts a separate status batch without awaiting it. Home single-flight does not prevent overlapping status batches triggered by focus, reconnect, or subsequent refreshes. One home cycle can cause 2 + N HTTP requests, plus pin queries, where N is the number of recent Chats in its page.
2. `home-success` replaces the session array and cursor with the first page, including for silent refreshes. A faster timer would discard loaded older pages more often and can disturb list position and trigger repeated pagination.

## Available Capabilities

### Available In The Installed SDK

- `user.listSessions({ limit, cursor, source })` and `space(id).sessions.list(...)` support list reconciliation. List records include optional `activeTurn` with `queued`, `running`, or `abort_requested`. The reference API explicitly attaches active turns to both lists.
- `space(id).subscribe(...)` exposes `session.created`, `session.updated`, turn lifecycle events, `space.fs.changed`, `app.version.published`, and task events. Mobile currently consumes session-scoped handlers, not a shared Space event handler.
- `session.subscribeGeneration(..., { recover: true })` already provides stream recovery. Keep it as the owner of open-Chat stream patches.
- `tasks.getMany(ids)` batches up to 100 known Task Runs. `tasks.list({ status: "active", ... })` discovers active tasks; task state is not interchangeable with Chat turn state. `tasks.wait(id, { signal })` supports short, user-initiated waits.
- List queries, turn queries, Space resource queries, connection callbacks, and React Native AppState are sufficient for the proposed first implementation. No dependency upgrade is needed for these interfaces.

Important constraints:

- `activeTurn: null` means no active turn, not that the last turn completed successfully. It does not distinguish completed, failed, stopped, or a Chat with no turns.
- `activeTurn: undefined` is not an authoritative idle state. Verify the deployed list contract before relying on it. Do not manufacture completion from missing data or introduce an unrequested compatibility path.
- The reference gateway routes Space events to `space:<id>`. A session subscription also retains this Space room and filters locally. Space `.on(...)` filters locally too: it does not reduce network traffic from streaming patches.
- A user room exists, but ordinary Space session events are not automatically a complete user-wide Chats feed. The SDK has no dedicated user-inbox subscription or batch latest-Chat-status query in the inspected interfaces.
- Global Chats contains sessions created by or participated in by the user, not every accessible Space session. Realtime Space events must not blindly insert every session into that inbox. Existing members can be patched; unknown sessions should invalidate and refetch the authoritative filtered list.
- The reference lacks a demonstrated replay cursor for these ordinary Space events. Event delivery alone cannot repair a disconnected interval.

## Proposed Policy

Use **realtime events for fast updates, scoped HTTP polling for reconciliation and discovery, and immediate invalidation after local actions**. The intervals below are starting values, not measured latency guarantees. They apply after successful requests and exclude network/server delay.

| Resource | Foreground policy | Immediate triggers |
| --- | --- | --- |
| Visible global or source-filtered Chats | Reconcile first page every 15 seconds; 30 seconds when idle; 60 seconds when not visible | Focus if stale, foreground, reconnect, relevant session event, send/create/rename/fork |
| Visible Space Chats / Chat side panel | Same 15/30-second list policy, plus its Space events | Panel open, focus, foreground, session event |
| Known active turns | With healthy scoped realtime, reconcile at least every 30 seconds; without it, target 5-second checks within request budget | Turn created/updated/finalized, send/stop response, foreground/reconnect |
| Open Chat | Existing stream; check active execution state after 15 seconds without relevant events; reconcile idle visible tail every 60 seconds | Finalization, out-of-sync, reconnect, foreground |
| Spaces list / overview / counts | 60 seconds when visible; retain a low-frequency 120-second Space discovery query elsewhere | Create/pin/membership-related refresh, focus if stale |
| Visible Task Runs | Events plus 10-second active reconciliation; 60 seconds if idle; batch known IDs | Task event, local task creation, foreground |
| Visible Saves / Works | 60 seconds, separately from Tasks | Related successful checkpoint task or published-app event |
| Visible directory | Filesystem-event invalidation, debounced by 500 ms; 30-second reconciliation | Directory open, foreground, local write |
| Activity / credits | Retain 60 seconds while visible | Focus, foreground, successful billing action; debounce relevant task/turn completion |
| Model health | 60 seconds only while picker is visible | Picker open if stale |
| Catalog / Rules / Channels / Billing history / Referrals | Focus or foreground when older than 60 seconds; no global periodic fetch | Their own mutations; bounded polling only while a concrete external operation is pending |
| Search results | Query-driven; mark visible query stale after relevant events and debounce requery | Query/scope change; do not refresh every historical query |

For Chats, use the 15-second interval while any known active turn exists or for 60 seconds after relevant activity. Otherwise use 30 seconds. The offscreen 60-second list query discovers cross-device activity in unobserved Spaces. Do not run both an unfiltered and filtered fast timer unnecessarily: one foreground discovery/query schedule per visible scope, with shared entity reconciliation.

A silent active-turn watchdog must query state, not declare a turn failed because no text arrived. Tools can legitimately produce no stream events for an extended period. Rebuild a generation subscription only for a real recovery trigger or detected inconsistency, with the existing cooldown.

### Running Is Independent Of Recency

Separate three concepts:

- Execution state: queued, running, stopping, or inactive, derived from authoritative `activeTurn` and turn events.
- Latest outcome: completed, failed, stopped, or unknown, derived from versioned turn records.
- List membership: current source/status/time filters and server pagination.

The 30-minute display filter must not become a synchronization cutoff. Keep known active turn IDs watched until an authoritative terminal transition, even if their Chat ages out of the time filter or first page. Use `turns.get(knownTurnId)` for targeted checks rather than assuming the newest turn is the only active one. A terminal update to an older turn must not clear a newer active turn.

Use `activeTurn` to avoid N latest-turn queries merely to determine whether list items are executing. Request latest-turn outcomes for visible rows that need them and for the relevant status-filter scan. Cache/reconcile those outcomes by sequence and timestamp. Do not silently change the current time-filter product semantics while fixing synchronization.

A complete all-account Running view cannot be guaranteed from the first 60 sessions or a recent-time scan. After a cold start, active sessions outside loaded pages remain undiscovered without further pagination or an upstream active-session query. Label this coverage accurately; do not equate "known running" with "all running."

## Scheduling And Ownership

Keep SDK operations, state merging, and cache writes in `src/data/`. Pages report focused scope, visible IDs, and open panels; they do not own protocol handling.

Introduce a small framework-free scheduling module (proposed `src/data/sync-scheduler.ts`) with registration, invalidation, foreground state, and disposal as its interface. It owns timing and request admission, not application entities. Connect it through `AppProvider` and existing data hooks incrementally; do not build a replacement query framework or refactor unrelated state.

Required behavior:

- Key work by authenticated user, resource, and scope/filter. Share one in-flight request per key, including status probes.
- Schedule the next run after completion rather than using overlapping `setInterval` callbacks.
- Collapse bursts such as foreground + transport-open + route-focus into one refresh. Invalidation during an in-flight read queues at most one follow-up so a mutation is not missed.
- Start with at most four background HTTP requests concurrently, including at most two individual turn probes. Interactive sends and initial visible loads take priority. Round-robin probes so large running sets do not starve; a 5-second target is not guaranteed beyond the budget.
- Add approximately 10% interval jitter. Retry transient failures with exponential backoff capped at 120 seconds; honor `Retry-After`. Authentication/permission failures require the appropriate auth/access handling, not perpetual rapid retries.
- Treat HTTP reachability separately from WebSocket health. A reconnecting socket does not imply HTTP is unavailable. Use request outcomes initially; do not add a network-monitoring dependency solely for this design.
- Stop new automatic work when inactive/backgrounded. On foreground, refresh the visible scope and active work first, then discovery. Preserve the existing snapshot-seeded Chat recovery.
- Dispose account-scoped timers, listeners, and queued work on sign-out/account change. Reject results from the old client/user generation. Abort reads where the existing SDK interface supports it; otherwise discard late results. A local timeout does not cancel the underlying HTTP request.
- Record last successful refresh and failure per resource. Silent errors preserve cached data but must not advance freshness or indefinitely appear healthy. Reuse existing error surfaces for sustained failures; avoid a toast on every retry.

## Realtime Subscription Scope

Share one mobile event handler per watched Space, with reader ownership. The SDK already reference-counts room retention; reuse that mechanism rather than creating another WebSocket client.

Watch the focused Space and the Space of the open Chat first. Add Spaces represented by visible Chat rows, initially capped at 10 distinct list-derived Spaces; prioritize visible running rows. Offscreen known active turns remain HTTP reconciliation targets when outside that room budget. Release list-derived subscriptions when their scope is no longer visible.

Do not subscribe every known Space. Measure received bytes and event volume, not just listener count: filtering out a patch in JavaScript saves rendering work but not bandwidth or parsing.

Handle events as follows:

- Session metadata: reconcile known entities, invalidate affected server-owned list membership/order, and coalesce refreshes.
- Turn created/updated/finalized: update lightweight execution/outcome records using turn identity and version; invalidate relevant summaries. Keep full message history handling in the existing Chat path.
- Files changed: invalidate the visible directory and affected read-only file preview. Never overwrite an unsaved editor buffer or automatically reload a running Work WebView.
- Task/app publication: update or invalidate the corresponding resources. A checkpoint task completing invalidates Saves; one turn completing should not refetch every Space panel.
- Reconnect/foreground: reconcile watched resources with HTTP even when the socket reports open. Handle room subscription rejection as a real access/error result.

## Consistency Rules

1. Preserve cache-first paint; cached records never prove that execution is still active or finished.
2. Preserve `reconcileLatestTurn` ordering by sequence and `updatedAt`, including terminal precedence at equal timestamps. Track per-resource request/event revision so an older list response cannot clear a newer event or optimistic send. Session `updatedAt` alone may not version an attached `activeTurn` projection.
3. Keep list entities separate from page boundaries in the affected list state. A head refresh merges newer records and inserts new head entries without discarding older loaded pages or replacing the tail cursor. Preserve source-specific membership and scope keys.
4. Absence from a first page is not deletion. Reconcile loaded pages on their own authoritative refresh/access checks, deduplicate by ID, and obtain each cursor from the server response. Membership removals and permission revocations must not be preserved indefinitely.
5. Never let background list polling replace an open Chat's history window, pagination cursors, optimistic messages, read position, or streaming reducer. Use the existing tail/stream reconciliation path when history is affected.
6. Keep visible list anchors stable during reconciliation. Scroll position and user reading take precedence over forcibly jumping to a new first row.
7. Invalidate resources after successful local operations, including send, stop, create, rename, pin, fork, file save, and task creation. Do not depend on an echo event arriving.
8. Foreground notification receipt may invalidate identified resources after payload validation; fetch with current-user permissions. Background push is an optional freshness hint, never proof of state or guaranteed background execution.

## Delivery Order

### Phase 1: Correct And Faster HTTP Synchronization

- Verify authenticated deployed list responses include authoritative `activeTurn`, including queued, stopped, and cross-device transitions.
- Fix silent first-page reconciliation and cursor retention before shortening intervals.
- Separate Chat-list polling from the bundled home Spaces/pins/status work, without changing bootstrap behavior unnecessarily.
- Add shared scheduling, focus-aware list intervals, per-key single-flight, account generations, and silent freshness/error tracking.
- Include source-filtered lists, Space detail lists, visible resources, and known old active turns. Use `activeTurn` for execution state; retain targeted outcome queries where required.

This phase alone targets 15-30-second visible-list discovery and roughly 5-second known-active checks when request budget and network permit. No server feature addition is required for the verified SDK interfaces, but deployed semantics still need validation.

### Phase 2: Scoped Realtime Invalidation

- Add shared Space handlers and event-driven lightweight status/list updates.
- Add Files, Tasks, Works, and Saves invalidation; reuse existing generation recovery for open Chats.
- Increase reconciliation intervals for healthy observed resources only after measuring event coverage. Keep polling for unobserved scopes and missed events.

This targets near-event-time updates for watched Spaces, with HTTP discovery for everything else. It is not a guaranteed all-account realtime feed.

### Phase 3: Upstream Improvements

Prioritize an authenticated user-level, lightweight inbox change feed; latest-turn summary fields or a batch status query; a server-side active-session filter; and resumable change cursors/tombstones. Include participant/source membership and access revocation semantics. A lightweight event subscription must be filtered on the server to actually reduce stream traffic.

These changes would make global running discovery and terminal outcomes cheaper and more complete. They require SDK/server work and are outside ordinary mobile implementation.

## Implemented Scope

- Added an account-owned, foreground-aware scheduler and a route-focus registration hook. Requests are completion-scheduled, deduplicated per resource key, coalesced over 250 ms, and retried with jittered exponential backoff. Authentication/access failures pause automatic retries until invalidation. Four automatic resource operations can run concurrently; operations containing multiple SDK calls are not a strict four-HTTP-request budget.
- Global Chats poll every 15 seconds while the Chats tab is visible and every 60 seconds offscreen. Source-filtered and Space/panel Chat lists poll every 15 seconds. Head reconciliation retains loaded older pages and tail cursors, and the Chat lists enable LegendList data-change anchoring.
- Known active turns are checked on a 5-second schedule, including turns outside the 30-minute display window. Status reads share a per-client, two-request concurrency limit and in-flight deduplication. Unchanged outcome reads are cached for 60 seconds; active reads for 4 seconds. `activeTurn` supplements execution detection, while targeted turn reads and a per-turn status ledger prevent stale snapshots from reviving terminal turns. Latest-outcome queries remain in use; they have not all been eliminated.
- Queued and stop-requested turns count as active. Running is account-wide and has no recency cutoff; Completed retains its existing time window. Running renders known active rows immediately and incorporates validated scan pages as they arrive. Partial results stay marked as loading until the last page, and a failed later page retains earlier results.
- Existing Chat stream recovery remains in place. Status/stream disagreement requests the existing cooldown-limited resync. Visible idle Chats reconcile their tail every 60 seconds without replacing a deliberately paged-away history window.
- Visible directories and file panels poll at 30 seconds. Space resources poll at 60 seconds; active Task Runs at 10 seconds; an active task detail at 5 seconds. Task refreshes batch known active IDs beyond the first page and preserve newer task revisions.
- Activity and Spaces overview now use the shared scheduler at 60 seconds. HTTP Activity reads no longer stop solely because the WebSocket is reconnecting. Global Space metadata refreshes at 120 seconds. Send, stop, new Chat, fork, and rename invalidate observed resources.
- Automatic status reads do not activate empty-list loading placeholders. File refresh failures retain existing entries and show an error. Account-generation checks reject obsolete work; provider effect cleanup pauses state-owned scheduling and realtime controllers so effect restarts do not permanently disable them.
- Global, Space, and sidebar Chat-list refreshes finish independently of turn-status enrichment. A slow or forbidden status query cannot hold the list timer or cause its scheduler entry to stop. Head polling remains enabled on the Running tab to discover recent web-created Chats while historical scanning continues.
- The open Space Chat sidebar polls label definitions and the selected label's session membership every 15 seconds. Label assignment events invalidate both resources; refreshes retain existing chips and rows while pending.

Not included yet: notification-received invalidation, polling of model pickers or low-frequency Settings pages, replay cursors, synchronization telemetry, or exhaustive revalidation of already-loaded old list pages. `Retry-After` is not exposed by the installed SDK's `HttpError`; the current scheduler uses its own backoff. Native timing, list anchoring, and deployed `activeTurn` semantics still need device/server verification.

## Verification Results

Earlier `npm run check` runs passed (lint, strict typecheck, Chat/OTA workflow assertions, notification import validation, release checks, and 20 Expo Doctor checks). The final full-repository rerun was blocked at lint by concurrently added, unrelated `landing/vendor/ScrollTrigger.min.js` and `landing/vendor/gsap.min.js`; these files and lint configuration were left untouched. Final scoped verification passed: `npx eslint app src scripts --max-warnings=0`, `npm run typecheck`, and `npm run test:workflow`. Android and iOS JavaScript exports with `--max-workers 2` also passed. `git diff --check` passed and the upstream submodule pointer is unchanged. No dependencies or native configuration changed.

Metro is running on port 8085, confirmed through `/status`. The React Native DevTools desktop installer reported a sandbox-permissions error; Metro itself started successfully.

This environment has neither `adb` nor `xcrun`. Native builds, foreground/background behavior on a device, both-theme error UI, list scroll anchoring, and authenticated cross-device/server behavior remain unverified.

## Verification Plan

Extend the existing Node workflow assertions in `scripts/check-chat-workflow.mjs`; do not add a test framework. Inject clock/scheduling dependencies into the scheduling helper.

Cover timer disposal; foreground/focus/reconnect coalescing; dirty-during-flight follow-up; backoff and request limits; old-account responses; event-versus-snapshot ordering; queued/running/stopping/terminal transitions; an active turn older than 30 minutes; source-filter membership; head refresh after loading 120+ Chats; stable cursor/scroll anchors; and missed-finalization recovery.

For implementation, run `npm run lint`, `npm run typecheck`, and `npm run test:workflow`, then `npm run check` before handoff when the environment permits. Verify on native iOS and Android with two clients: remote Chat creation/rename/start/stop, long silent tool calls, offline/reconnect, background/foreground, file edits, task completion, and sign-out/account switching. Test both themes if error/freshness UI changes.

Measure per-resource requests/minute, duplicate-suppression count, active room count, received event bytes, event-to-render latency, last-success age, retries, and time spent holding stale running state. Do not log message content, tokens, or private file paths. Select final intervals from these measurements, not from an assumed realtime guarantee.
