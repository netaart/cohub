# @neta-art/cohub

## 8.17.0

### Minor Changes

- 50d6f00: **App version history and provenance.** Published apps now expose their immutable version history, and every version carries the session it was published from.
  
  - Public app pages gain a Cohub bar version switcher: `?cohub_v=<n>` selects a version, `getBySlug(…, { version })` fetches that version's content, and `listPublicVersions()` returns the history. SSR resolves the requested version; switching is a client-side fetch that keeps the URL shareable.
  - `AppVersionRecord.source` and `AppVersionSource` describe provenance (`sessionId`, `turnId`, `turnSequence`, `via`). The raw `meta.source` stamped at publish time is no longer exposed, provenance is validated against the app's own space, and session identity/title is included only when the caller holds `session.view` for the source session — so a private session never leaks through a published app, and viewer-scoped responses are never shared-cached.
  - `cohub apps versions` prints a Source column: the source session title when visible, otherwise the publishing channel.
  - The public page docks the Cohub bar above the App instead of floating over it, keeps the Cohub wordmark in that bar, and opens a version's source session in a new tab. Version history loads off the public page's critical path, so the first render never waits for it.
- c89672c: `GET /api/me/sessions` no longer returns `sourceCounts`. The per-origin totals required a full aggregate over the account's sessions on every page fetch, which does not scale with large scheduled-task volumes. The source picker in the web inbox now lists every origin statically without counts.

### Patch Changes

- 4071454: `GET /api/me/sessions?source=…` now filters by each session's source **system label** instead of the raw `space_sessions.source` string. Channel sessions are stored as `feishu:dm:…` or `channel:feishu`, so matching the raw column dropped every Feishu/WeChat/Discord/QQ chat from its own filter and leaked it into `other`; labels carry the attribution the normalizer already made at creation, so this fixes every provider at once and matches what a space sidebar shows.
- f33c6ca: Queued follow-up turns no longer render (or resume) as running generation. A session's newest unfinished turn can be a queued follow-up waiting behind a running one, so live generation is now resumed only from `running` / `abort_requested` turns: a queued turn stays in the follow-up queue instead of being cloned as the streaming turn, and an empty pending snapshot is never persisted or restored.
- f33c6ca: The web model picker shows availability dots for generation models too, not just LLMs — the same status feed now marks unavailable or degraded image/video/audio models in the picker, in both the collapsed row and the expanded model list.
- f33c6ca: Space `@` mentions in the composer now share the command palette's space search instead of maintaining a second scorer. An empty query lists recently visited Spaces in the palette's Recent order, and a typed query goes through the same merge (fuzzy text match weighted against viewer tier and recency), so a mention and the palette can no longer disagree about which Space ranks first — and the removed duplicate logic drops the per-keystroke scan over cached session lists.

## 8.16.0

### Minor Changes

- 96a30a9: `GET /api/me/sessions` filters by any session source instead of only `web`. `?source=web,feishu` takes a comma-separated list of source kinds, where `web` also matches a null source (legacy rows) and `other` matches anything unlabelled; unknown kinds return `400`. Responses carry `sourceCounts` so callers can build a picker from the kinds an account actually has. `user.listSessions({ source: ["web"] })`.

## 8.15.0

### Minor Changes

- eff8a32: Public app detail responses (`AppDetailResponse`) now expose `totalViews`, the app's all-time view count. `by-slug`, `:id/public` and `:id` all return it, so hosts can surface a view count without a separate stats request. It is `null` when the rollup total is temporarily unavailable — a view count never fails a detail response.
- a5ffd93: `GET /api/me/sessions` accepts `source=web` to return only human web chats, so scheduled prompts and channel bots no longer bury real conversations. `user.listSessions({ source: "web" })` exposes it, and the web inbox defaults to this filter with a Web App / All toggle.

## 8.14.0

### Minor Changes

- c7b6df3: Consent dialogs now target a Space the viewer controls, and app misconfiguration stays off the viewer's screen.
  
  - **Viewer-controlled default target**: a Space-bound `auth.request` no longer silently targets the app author's home Space. The host resolves a default from the invocation Space, then the embedding shell's Space, then the viewer's last-picked Space, then their first accessible Space — falling back to `GET /api/spaces/default`, which ensures a home Space. The target is resolved _before_ silent reuse, so a legacy home-Space cached grant can no longer silently re-authorize the author's Space. An explicit `spaceId` the viewer cannot access is treated as no target (with a developer diagnostic that never leaks the resolved Space id) instead of failing after they consent. If the viewer's Space list cannot be loaded (bounded by a timeout), confirmation is blocked rather than falling through to the app author's Space. Silent renewal for client-known targets (account grants, or the Space the app was invoked in) happens before the list is loaded, so returning viewers skip that round trip and are not blocked by a transient list failure.
  - **Shared Space picker model**: `normalizeSpacePickerQuery`, `orderSpacePickerItems`, `filterSpacePickerItems`, and `selectSpacePickerItems` (plus their types) are exported from `@neta-art/cohub/space-picker`, so every host can render the same chooser.
  - **Selection owned by the bridge core**: `AppBridgeDialogState` gains `selectedSpaceId` and `canChangeSpace`, `AppAuthorizeRequest` gains `defaultSpaceId`, and `AppBridgeCore` gains `setSelectedSpace(id)`. Hosts render; the core decides. Concurrent authorize requests can no longer overwrite each other and leave one unanswered: the dialog is reserved synchronously and later requests join or replace it, and a replaced silent attempt never clears the newer one. Confirmation only accepts a Space the host actually loaded; an accessible explicit `spaceId` is pinned in the core (not just hidden in the UI), so a host cannot redirect a grant the caller then acts on.
  - **Structured authorize errors**: failed grants return a machine-readable `code` (`space_inaccessible`, `scope_not_held`, `app_not_accessible`, `consent_required`, `space_not_found`, `migration_pending`).
  - **Developer diagnostics**: the host forwards `cohub.app.diagnostic` events and the SDK logs them to the app author's console via `console.warn` (the diagnostic subscription also announces runtime readiness, so apps that never read context still receive them). Delivery is non-fatal — a throwing host transport cannot break authorization — and is limited to the iframe bridge host today. Viewer-facing copy stays neutral for app-configuration failures and is mapped per error code. Account-level scopes silently reuse a grant on **any** Space that covers them (legacy, Space-less entries included), trying each in turn; picker mode only reuses the last-picked Space while the viewer still has it. Silent renewal retries once with a refreshed token on a 401 (an auth failure is never treated as a revoked grant), clears the cache only for a 403/404 grant rejection, and is capped and timeout-bounded. `AppRuntimeApi` exposes an idempotent `dispose()` to release its diagnostic and pointer listeners.
- 785f9a9: Add a `session.access.manage` permission so builders can share a session. Session-level access (share/unshare) is now authorized by this permission instead of the host-only `member.manage`; space-level access and member management remain host-only. The permission is part of the public permission vocabulary and is not granted to Apps.

### Patch Changes

- fd5fdd5: Release overlay rect input regions when the pointer leaves them. Once the host makes a cross-origin overlay frame interactive it swallows pointer events, so the host could not tell that the pointer had left a rect region — a resting overlay kept the whole window unclickable. The SDK now reports the pointer while a rect `inputRegion` is active, and the host releases the region as soon as it is outside. Ownership is frozen while any button is held (including a drag that began on the page underneath), and an overlay that opts out or closes loses interaction immediately.
  
  `requestConfigure` also now treats `geometry` as the complete shape: a present object replaces the current one (`{}` fills the layer), and a geometry with any invalid axis is ignored rather than silently becoming a fill.

## 8.13.0

### Minor Changes

- 5232f9f: Add space webhook triggers (`on.event: webhook`) and hook `uses` App Actions.

## 8.12.1

### Patch Changes

- 2fe6bee: The App consent dialog now merges identical authorization requests. When an App calls `auth.request()` again with the same scopes and target while the dialog is still open — for example on every context update — the new request joins the open dialog and receives the same answer, instead of dismissing it with a spurious denial and opening a fresh one. Requests for a different consent still replace the dialog as before.
- 95622b1: Realtime subscriptions now surface rejected room subscriptions instead of silently receiving nothing. When the gateway rejects the Space room (for example an app session without `space.view`), `session.subscribe()` calls its `error` handler and `space.events.subscribe()` its handler with the `system.subscribe.error` event, so an App can tell the viewer why it is not receiving events.

## 8.12.0

### Minor Changes

- 311c47d: Board edit history is now replayable. `createBoardReplayPlayer()` (SDK) turns a Board's transaction log into render documents — it rewinds through the server-computed inverses and plays forward through payloads, handling version gaps and paging in both directions — and `cohub boards transactions <board>` (CLI, alias `history`) pages through the same log. The API exposes `GET /spaces/:id/boards/:boardId/transactions`, which returns newest-first pages read under one repeatable-read snapshot with the current rows as the replay anchor. Read-only: nothing is ever written to the Board. In the web workspace, "Replay history" opens a private read-only stage with a scrubber, play/pause, speed control, step, camera follow and live tail appends.
- a869400: Board motion is now optional and preset-based. Boards default to no motion; the built-in `effects.deal` preset can be selected as the default enter motion (`appearance.motion.enter`) or applied to an individual node with an `on-enter` effect. `kindVersion` defaults to `1` on effect and preset input. Reduced-motion handling is preserved.
  
  The Board-local theme registry is removed from `@neta-art/cohub/board/render`: `getBoardThemeRenderer`, `registerBoardThemeRenderer`, `BoardThemeRenderer`, `BoardThemeContext` and `cleanBoardTheme` no longer exist. The registry was never wired to `appearance.theme` and always resolved to the single built-in background; use `createBoardBackground` / `updateBoardBackground` instead. Board colors continue to come from Cohub theme tokens, and `appearance.theme` / `appearance.mood` are now optional and ignored by rendering.
- 41b2ae5: Apps can open as an **overlay**: a transparent, chrome-free layer above the Space workspace instead of a preview tab. `cohub desktop open <app> --as overlay` requests it, and a page published with `<meta name="cohub:surface" content="overlay">` opens that way by default. Inside the App, `context.invocation.surface` reads `"overlay"`, and `cohub.app.requestConfigure({ geometry, inputRegion })` controls where the overlay sits and which rectangles accept pointer events — everything else (context, auth, Space APIs, realtime, `surface.handle()` + `--call`, composer chips, navigation, commerce) works as in a tab. Overlays close through `cohub.app.requestClose()` or `Escape` in the workspace.
  
  Republishing now updates page-derived metadata (title, description, icon, image, lang, theme color, surface) when the current value is the one extraction last wrote; values a publisher set by hand that differ from the page are kept.
- 35be140: Generation model declarations can carry a display `pricing` block (`unit`, `amount` or `min`/`max`, optional `note`). `models.listMultimodal()` returns it with each model, and the web model picker renders it next to the model id.
- bea9903: `space.create` is now a user-level permission: creating a Space is authorized by holding it rather than by the caller's principal type. `POST /api/spaces` accepts execution tokens again, so `cohub spaces create` works inside a Sandbox; app sessions need a `space.create` viewer grant, preview sessions are denied, and real account sessions are unchanged. Auto-minting the first-time Home space is now an unconditional parameterless system default.

### Patch Changes

- a1df456: Board file cards drop the `TYPE · size` meta line; the title, excerpt and category stripe already carry enough to recognise a file. The `fileMetaLine` / `formatFileSize` helpers remain available for custom card renderers.

## 8.11.0

### Minor Changes

- 1f326f4: Add `client.auth.requestCreateSpace()` so Apps can create a viewer-owned Space in one consent. The host uses the viewer's account token against the existing create API, then grants the requested scopes on the new Space.
- a34dc95: Apps can embed other Apps by rendering their public pages in iframes. `cohub.app.embed.attach(frame, { appId, shell, onCloseRequest })` forwards the embedder's shell location and relays the embedded App's close intent; the embedded App sees `context.shell.surface === "embed"` and, once the embedder is verified against the frame origin, `context.invocation.embedder`. Any App can call `cohub.app.requestClose()` to ask its host to close the surface it runs in.
- 925d712: Board file cards read better: titles come from frontmatter (`title`/`name`/`label`/`heading`) or the first H1 and drop the file extension; frontmatter is split reliably (BOM, leading blanks, `+++` TOML, trailing fence whitespace); covers accept more keys including nested `image.src`; excerpts vary by file kind (prose for docs, leading comment for code, `description` for JSON/YAML). Cards show a `TYPE · size` meta line, a category-coloured stripe, and a large type mark when there is no cover or excerpt.

## 8.10.2

### Patch Changes

- 5f4f0bc: Retry stalled WebSocket connection handshakes after a configurable timeout.

## 8.10.1

### Patch Changes

- 8633eb5: CLI commands now fall back to the Home space when `-s` / `COHUB_SPACE_ID` are omitted (`GET /api/spaces/default`, cached per login). `apps publish` infers `--source` from runtime (workspace in a sandbox, local otherwise). `getCohubContext()` treats runtime as sandbox only when an execution token is present.

## 8.10.0

### Minor Changes

- 6f9d3d5: Publish local app sources from the CLI: upload your app source to the server and have the worker publish its assets. The SDK execution context and task waiting APIs are hardened accordingly, with new public-assets helpers for app source publishing.

## 8.9.0

### Minor Changes

- c59bc31: Add published App Actions backed by existing Run Command Task Runs, with owner-funded execution, viewer-scoped App Commerce access, and private owner diagnostics.

## 8.8.0

### Minor Changes

- 0cd4d32: Turn browsing and intermediate archives in the SDK:
  
  - `session.turns.intermediate.get(turnId)` reads a turn's persisted intermediate messages straight from its CDN archive — resolving the messages object key and signed URLs automatically — and `intermediate.getToolCalls(turnId, message)` returns the matching tool calls, extracting them from message content when no archive object exists.
  - Export the archive shapes `TurnIntermediateMessagesFile`, `MessageToolCallsFile`, `StoredIntermediateMessage`, and `StoredToolCall` for typing archive reads.

### Patch Changes

- 9275e77: Expose the current Cohub shell Space, Session, and viewed Turn through App runtime context and live context change events.

## 8.7.0

### Minor Changes

- f9b6156: Normalize Board item geometry across semantic authoring and storage:
  
  - Draw points and arrow start/end points are now consistently world-space; authoring items use optional `position`/`size` and the persisted frame is derived automatically.
  - Export `computeArrowFrame` (previously internal arrow geometry) so arrow item frames can be computed outside the renderer.
  - Share geometry helpers between the API, CLI, and renderers, and fix draw renderer performance by computing geometry once per item.

## 8.6.0

### Minor Changes

- 6685de4: Export `BoardSemanticCommandSchema` from the public SDK so board mutations can be validated and compiled outside the API.

## 8.5.1

### Patch Changes

- a279343: Optimize debugger response body capture by skipping oversized fetch bodies and reducing repeated UTF-8 encoding work when creating payload previews.

## 8.5.0

### Minor Changes

- 9884704: Add app workspace navigation bridge: apps and chat backgrounds can navigate the embedding Cohub workspace via `client.navigation.open(target)` and `appRuntime.navigationOpen(target, call)`. Targets are validated `AppNavigationTarget` payloads from `@cohub/protocol/app-navigation` (a string is accepted as an app ref), responses report `handled` with a `reason` (`unsupported`/`timeout`) when the host cannot navigate, and `PopupBrokerTransport` reports navigation as unsupported.

## 8.4.0

### Minor Changes

- 7baf58e: App runtime context now exposes the hosting Space as `app.homeSpace` (id and name), so chat backgrounds and apps can theme against the Space they run in. The top-level `space` field is deprecated in favor of `app.homeSpace`, and the legacy `work` projection stays stable as App context gains fields.
- 7baf58e: Space FS reads, stat, and ls results now expose file metadata change time as `ctimeMs` (epoch milliseconds, when available), and stat reports `isFile`. SDK `SpaceFsFileResponse` gains the matching optional `ctimeMs` field.

## 8.3.1

### Patch Changes

- 0511cbe: Palette: scope the overview-backed default list to the space picker "Recent" tab and order it strictly by personal activity.

  - Plain palette default list (no query, no `a:`) and the All / Mine / Pinned tabs return to the pre-overview local derivation: first frame from the same IndexedDB / space-list caches as before, no overview snapshot, no overview refetch, no snapshot-driven re-sort.
  - Recent tab keeps the overview path: the first frame is the last received server payload (the cached overview snapshot) folded with local caches — device visits and viewer-authored turns re-rank it, newly cached spaces/sessions merge in — instead of an "All"-ordered legacy list that visibly re-sorted once the refetched overview landed. When no snapshot exists at all, the frame falls back to a purely local synthesis with the same ordering semantics.
  - Recent ordering drops the pinned-first tier on both the client build and the overview API: spaces are ordered strictly by personal activity time (visits + viewer-authored turns + server participation), so a stale pinned space no longer floats above recently used ones. Pinning still marks the item; the dedicated Pinned tab is unchanged.
  - The overview refetch is no longer tied to the palette's search abort signal, which previously cancelled it mid-flight and delayed the correct list by a re-request cycle.

## 8.3.0

### Minor Changes

- - Add `search.overview()` (`GET /api/palette/overview`) plus `PaletteOverviewResponse` types for viewer-relative palette default data, including `recentSpaceIds` hints from local activity
  - `search.query()` gains `groupTurns` to toggle per-session turn grouping
  - Expose prompt quick-action fields (`quickAction`, `buttonLabel`, `order`) on `PromptTemplateCatalogEntry`
  - App bridge retries authorization once with a forced token refresh, so consent flows survive short-lived access tokens
  - Drop legacy `s3_post_v1` public asset upload protocol; uploads always use presigned PUT

## 8.2.0

### Minor Changes

- 5d2a4b7: Export `AppViewerGrantRecord` from the package root so apps can type the rows returned by `apps.listMyGrants()` without redefining them locally.

## 8.1.0

### Minor Changes

- 9bec315: Rework app permission grants around per-space authorization.

  - Viewer grants are now per Space (`app_viewer_grants` keyed by app + viewer + space): an app can be granted different scopes on its home Space and on any Space the viewer picks. `cohub.auth.request()` accepts `spaceId`, and the consent dialog shows the target Space name resolved by Cohub.
  - `cohub.auth.requestSpace()` merges space selection and the grant into one consent dialog: the host loads the viewer's space list (the app only learns the picked Space), the result carries the picked Space, and returning viewers are re-authorized silently against their last pick.
  - `auth.request` / `auth.requestSpace` accept `alwaysAsk` to skip silent reuse and force a fresh consent dialog (re-confirming or switching Spaces). `cohub.context().permissions.viewerGrants` now includes previously granted scopes so apps can render state without triggering a dialog; apps never manage grant caches themselves.
  - Either grant source is enough: a bounded publisher `appScopes` set (`space.view`, `session.view`, `file.view`, `file.edit`, `taskrun.view`, `session.prompt.readonly`, `session.prompt.fullaccess`, `command.execute`, home Space only) or a viewer grant (any supported permission on any Space). App creation, configuration, publishing, and deletion accept only real account principals, so an App cannot edit its own grants or lifecycle. Publisher scopes and App status resolve live from the DB once per request, so disabling an App or removing `file.edit`/Prompt access takes effect immediately. Viewer grants are also validated at grant time and re-validated on every request against the viewer's own current access.
  - `allowedViewerScopes` is no longer enforced — viewers may grant any permission they hold themselves. The field stays on the wire for compatibility.
  - Grant TTL is now 14 days (matching the consent dialog copy); tokens stay at 1 hour. Tokens carry identity, the eight bounded publisher scopes, and a display-only snapshot of the consented scopes (`viewerScopes`, kept for legacy JWT-inspecting clients) — effective publisher and viewer permissions resolve from the DB per request rather than trusting claims. App session minting and verification also clamp publisher scopes, so legacy rows and already-issued tokens cannot retain unsupported direct permissions.
  - Revocation is durable: silent re-authorization (`silent: true` on the authorize endpoint, set automatically by the host when reusing a cached consent or auto-authorizing the publisher) only renews a live grant that still covers the requested scopes — it never creates, widens, or revives one. Silent responses return the full stored grant scopes rather than the narrower refresh request, keeping the API, JWT display snapshot, host cache, and DB aligned. The publisher's auto-authorization still works for their own app (implicit consent when no revoked row exists) but no longer bypasses revoke, and `alwaysAsk` now forces the dialog for owners too. Explicit consent replaces the stored scope set, the host cache mirrors that exactly instead of union-merging, and a denied dialog never discards an already-valid token. App session minting, authorization, and grant management accept only real account principals, so delegated tokens cannot mint grants or exchange themselves for another App's identity. Authorize requests targeting a caller-supplied Space verify that it exists.
  - The authorize upsert is index-agnostic (works under both the legacy two-column and the new three-column unique index), so the new code can deploy before the `0064` migration; multi-space grants activate once the migration lands. Deploy code first — the old code's two-column ON CONFLICT cannot run after the migration.
  - New APIs: `GET /api/apps/:id/grants` (list your own grants) and `DELETE /api/apps/:id/grants/:grantId` (revoke). SDK: `apps.listMyGrants`, `apps.revokeMyGrant`. CLI: `cohub apps authorize`, `cohub apps grants`, `cohub apps revoke`.
  - Delegated app authorization in scheduled tasks is a reference, not a snapshot: the worker resolves the app's live publisher scopes plus the viewer's live grant (intersected with current access) from server state before any side effect, so an editable cron payload can never widen scopes — forged snapshots are ignored, and an expired/revoked/downgraded authorization aborts the task (`UnrecoverableError`) instead of spending the viewer's quota. A published app is the master switch for the whole delegation: disabling it stops queued tasks immediately instead of letting a lingering viewer grant drive them for up to 14 days, while publisher scopes stay bound to the app's home space — cross-space tasks keep running on the viewer's grant for that space. App sessions may only manage their own cron jobs and cannot edit task payloads at all (creation stays gated by the prompt permission), and `payload.auth` is server-generated provenance for every caller: cron updates strip any client-supplied auth and preserve the original verbatim, so no account can inject or swap an app authorization reference to borrow a published app's publisher scopes.
  - Prompt auth intersects viewer grant scopes with the viewer's current permissions on the space at submission time, so a role downgrade strips lost scopes (e.g. `member.manage`) instead of trusting the consent-time snapshot. Scheduled tasks re-validate via the shared `resolveViewerGrantScopesAtUseTime` (bound to the grant's full identity: id + app + viewer + space) before any side effect: an expired token, a dead grant, a lost prompt permission, or an auth context that does not match the task aborts it (`UnrecoverableError`) instead of letting it run unauthenticated and spend the viewer's quota. The reported `viewerScopes` are always the trimmed set.
  - Silent grant coverage honours permission implications everywhere (`session.prompt.fullaccess` covers `session.prompt.readonly`, `file.view` covers `file.view.filtered`): the server renews such requests silently instead of returning 403, and the SDK cache reuses them without re-prompting.
  - Both SDK layers key remembered consents by the canonical Space id and scopes returned by the authorize endpoint, so implicit and explicit home-space grants converge onto one entry instead of double-counting. The host migrates legacy keys without renewing or overwriting newer consent state; only definitive 401/403/404 authorization failures clear cache and reopen consent, while network errors, 429, and 5xx preserve it and return a retryable error.
  - New account-level scope `user.taskrun.list`: with an explicit viewer grant, an app can list and read every Task Run owned by the viewer through the unscoped task list, including runs from Spaces they can no longer access and account-level runs. It grants no access to the source Spaces or to other users' runs. Without it, app sessions keep the strictly space-scoped view.
  - `taskrun.view` viewer grants are strictly space-scoped: without `user.taskrun.list`, the unscoped Task Run list filters rows to spaces with a live grant that still matches the viewer's current access (previously any single grant exposed the viewer's runs across every space), and account-level runs stay hidden.
  - Grant-time scope validation resolves the viewer's permission set once per authorize instead of one membership/policy query per requested scope, and uses the shared implication-aware permission check so stronger access can grant a weaker scope such as `file.view.filtered`.
  - Batched space-permission filtering for app sessions: one grant load plus one membership batch instead of a query per space. The account-level Task Run list is a direct owner-filtered paginated query, with no pre-scan over run history or Space memberships. The Web and CLI publisher controls expose the same eight bounded direct scopes; broader capabilities remain available through viewer consent.

## 8.0.1

### Patch Changes

- 7e0f977: Align the realtime event domain for desktop commands: introduce a dedicated `desktop` domain in `REALTIME_DOMAINS` (distinct from `ui`) so `DesktopCommandDispatchedEvent` routes correctly, and add a compile-time assertion that every realtime server event carries a valid domain.

## 8.0.0

### Major Changes

- 5c0c0b2: Rename the Work vocabulary to App/Desktop across the SDK, and make the App wire surface canonical.

  **Breaking changes**

  - Realtime App events and `/api/apps` responses now always speak the canonical App vocabulary (`app` / `apps` / `appScopes` / `appId`). Consumers of the legacy realtime `workId` / `workScopes` / `work` field names must read the canonical fields from now on.
  - `client.desktop` (DesktopCommandsApi) and `client.apps` (AppsApi) are the canonical accessors; the work-era `client.ui` and `client.works` accessors are retained as deprecated aliases.
  - Published App records and version records expose `app` / `apps` / `appScopes` / `appId`; the deprecated `Work*` type aliases now describe these canonical fields (a one-time field rename for consumers that read the raw wire shape).

  **Compatibility**

  - The legacy wire surface stays available for existing consumers: `/api/works*` REST mounts, `/api/ui/commands`, `/w/` public URLs and asset keys, and `work://` refs are preserved until the next breaking version.
  - The embedded App runtime bridge accepts both `cohub.app.*` and the legacy `cohub.work.*` messages and replies on the matching namespace, so older published Works keep working without a rebuild.
  - App session JWTs keep the legacy `workScopes` claim alongside the canonical `appScopes`.

### Patch Changes

- 53ca326: Persist App Promotion attribution in Billing Order meta and preserve the paid-order integration point for a future reliable Billing event trigger.
- ef6d8dd: Add live App context change subscriptions for embedded App runtimes.
- 8bfcc4e: Make embedded App runtime context updates handshake-aware and resilient to iframe navigation races.

## 7.0.0

### Major Changes

- 24c7201: Board semantic authoring protocol

  **Breaking changes**

  - Semantic mutations (`POST /boards/:id/mutations`) now accept `board.patch`, `connection.*`, `effect.*`, and `composition.*` commands alongside `item.*`; all commands compile into one atomic transaction.
  - `POST /boards/:id/validate`, SDK `board.validate()`, CLI `cohub boards validate`/`apply` removed. Use semantic mutations with `dryRun: true` for server-side validation.
  - SDK `boards.create()` and `board.authoring()` return the semantic `BoardAuthoringSnapshot` (items, connections, effects, compositions, playback); raw Board bootstrap/transaction methods were removed.
  - `BoardSummary.counts.nodes` renamed to `counts.items`; `BoardCapabilities` exposes `items` instead of `nodes`.
  - SDK realtime board event and subscription handler are now `board.changed` / `changed`, with semantic `changed` projection and no wire operations.
  - CLI: `boards nodes add/patch/remove` replaced by `boards items create/patch/replace/delete`; `boards examples` and `boards capabilities` provide templates and schemas.

  **New**

  - `dryRun: true` on semantic mutations: full server-side validation (version, references, cascade) without writing or consuming the mutation id.
  - Idempotent mutation replay via persisted receipts; no-op mutations record a `validated` receipt without bumping the board version.
  - Composition re-apply is row-diffed: unchanged tracks/clips keep their rows, identical aggregates short-circuit to a no-op.
  - Targeted reads for item, connection, effect and composition projections; section-scoped validation reads for mutations.
  - `BoardEffectSchema` lives in one module (`board-effect.js`) shared by create and mutation paths.
  - Web, CLI and SDK all use the same public `authoring()` / `mutateSemantic()` / `board.changed` path; pending Web edits persist semantic mutations.
  - `item.reorder` expresses z-order without exposing storage `orderKey`; `effect.apply` is the idempotent declaration-style effect command.
  - Mutation receipts expose `outcome: applied | noop | dry-run`; Board realtime uses the same semantic changed projection.
  - Checkpoints and published Works store the same semantic Item snapshot as live authoring reads; legacy Sequence/Node snapshot compatibility was removed.

## 6.0.0

### Major Changes

- 1db3791: Replace Board sequences with atomic animation compositions built from typed tracks, keyframes, procedural clips, markers, and explicit playback policies. Board mutations now return durable idempotency receipts, and the CLI exposes composition-first authoring commands.

### Minor Changes

- 342f6d5: Expose the current viewer and optional UI Preview invocation identifiers through `client.context()` for embedded Works.

### Patch Changes

- 19d15a2: Document and expose viewer-authorized `taskrun.view` access for published Works.

## 5.10.0

### Minor Changes

- 057a590: Add persisted Board backgrounds, semantic camera focus clips, summary and mutation SDK helpers, semantic CLI commands for nodes, connections, appearance, playback policy, effects and sequences, safe Board target resolution, and atomic exports.

## 5.9.0

### Minor Changes

- 7844146: Support Space file previews from the CLI: `cohub ui preview` accepts `file://<path>` or a relative Space path (resolved against the active space), alongside the existing Work refs and the new `work://` scheme. The SDK now exports `UiFilePreviewTarget` for the extended `preview.show` command.

## 5.8.2

### Patch Changes

- 8dcd9a4: Support direct generation mode in create-space prompts: optional `mode` and `generation` fields on `CreateSpacePromptInput`, optional `content`, and `execution` kind on immediate responses.

## 5.8.1

### Patch Changes

- d32ab93: Accept UUID v6-v8 identifiers consistently across SDK and CLI resource parsing.
- 4decc5c: Add generic and Meta Work promotion links with aggregated landing and readiness analytics.
- de8d59e: Carry Work promotion attribution through authentication and checkout, and expose registration, purchase-confirmation, and checkout-start conversion events to configured promotion providers.

## 5.8.0

### Minor Changes

- 2539eb6: Add automatic first-purchase offers and promotion-code previews to billing checkout APIs.
- 1ed2878: Add a shared native Board node contract, semantic node builder, machine-readable validation diagnostics, and capability discovery for SDK and CLI clients.
- 6be8f7e: Add direct, space-scoped public file uploads and inspection with OSS-native overwrite protection in the SDK and CLI.
- 10d93b2: Expose reusable Board media inference, playback resolution, interaction, and video thumbnail primitives, and add purpose-aware Space file URL resolution.

### Patch Changes

- 0dbc522: Use `cohub.live` endpoints and hosted app origins across the SDK and CLI.
- 8736c29: Send the Sandbox runtime version as request provenance when Cohub CLI requests inherit a valid Sandbox environment.

## 5.7.0

### Minor Changes

- 0d6e57d: Add first-class Board audio nodes with deterministic waveform rendering and shared codec support.

### Patch Changes

- 48ec699: Expose the unified billing reason used when AI requests are blocked because the balance is not positive.

## 5.6.0

### Minor Changes

- 03f9ee7: Add a reusable TaskRun-to-Board snapshot projector, safe remote output URL normalization, and batched TaskRun lookup by ID. The Board task projection is now shared by the SDK and Cohub Web.

## 5.5.0

### Minor Changes

- 82c244c: **Board task nodes**: Support task nodes with multimodal previews (image, video, audio waveform, and text excerpts), snapshot decoding, and headless task-card rendering on Board documents.

## 5.4.3

### Patch Changes

- Re-establish room subscriptions after a WebSocket reconnect, so realtime room events resume flowing without manually resubscribing.

## 5.4.2

### Patch Changes

- Preserve original avatar formats (JPEG/PNG/GIF/WebP) and upload avatars as immutable assets with stable URLs, so replacing a profile or space avatar no longer breaks previously served images.

## 5.4.1

### Patch Changes

- **Board connections from ports**: node ports are now drawn and reachable, so relations can be started by dragging from a port — no separate Connect tool needed. Ports enlarge under the pointer and the drag preview shows the loose end plus a highlight on the attach target. Adds `anchorPointOnFrame` for pointer-driven geometry resolution.

## 5.4.0

### Minor Changes

- 278a194: **Board connections**: relations between nodes are now first-class entities instead of arrow bindings. Add `spaces.connect()` / `spaces.disconnect()` operations and `spaces.connections()` / `spaces.connectionsForNode()` queries, export the `BoardConnection` type, and resolve geometry live from node frames so connections stay in sync as the layout changes. Shape capabilities rename `canBind` to `canConnect`.

## 5.3.3

### Patch Changes

- 9a0eeb1: Align publisher-owned preview and background authorization, and let New Chat Work backgrounds use low-risk browser capabilities and visible composer context.

## 5.3.2

### Patch Changes

- 0a82a02: Expose the minimum required balance when video generation is blocked for insufficient credits.
- 0628b24: Accept UI-domain realtime envelopes in the WebSocket SDK so dispatched UI commands reach frontend listeners.

## 5.3.1

### Patch Changes

- 89e0b1c: Expose safe response trace identifiers on final unauthorized errors and recovery callbacks.

## 5.3.0

### Minor Changes

- 6d68beb: Add Work previews in the workspace and let an Agent drive them.

  Works become a fourth preview domain alongside files, Boards, and ports, so a
  published Work can run as a workspace tab (`?preview=work:<workId>`). The Work
  detail page gains a **Preview** action beside **New tab**.

  `cohub ui preview <work>` shows that preview in the Cohub tab the current chat
  started from, and `--call <method>` invokes a method the Work registered with
  `client.work.surface.handle()`. Showing is idempotent, so a repeat re-activates the
  same tab. Retrying with the same command id re-delivers it, which recovers a
  dispatch that never reached the browser; delivery is at-least-once, so callable
  methods should be safe to repeat.

  Routing uses a new `RequestSource.clientId`, propagated from the browser through
  prompts, agent turns, and the Sandbox (`COHUB_SOURCE_CLIENT_ID`). Commands reach
  only the acting user's own frontend instance, and a Work exposes nothing beyond the
  methods it registers.

  A Work can also attach one custom context chip to the Cohub composer with
  `client.work.composer.setChip()`. The compact label opens a lightweight full-text
  preview, while the original content is preserved in the sent message for the
  Agent and timeline.

  A Work answers surface calls and sends composer context only to an explicit list
  of Cohub app origins (or its own), never a `*.cohub.run` suffix match, so neither
  a third-party embedder nor a Work served from a Cohub content subdomain can invoke
  another Work's methods or alter the Cohub composer. Surface calls acknowledge
  delivery; the Work reports the final UI command result directly with the SDK.

## 5.2.0

### Minor Changes

- Add `WorksApi.getStats()` and typed Work view analytics responses for published Works.

## 5.1.1

### Patch Changes

- 6602d1d: Deduplicate concurrent access-token refreshes and identify stale unauthorized requests so clients can preserve a newer session.

## 5.1.0

### Minor Changes

- a7b9292: Add structured Work mentions, public-reference resolution, immutable artifact manifests, and verified file or directory Work downloads.

## 5.0.0

### Major Changes

- e307ac2: Remove the Explore SDK API and its public response types after the Explore product surface was retired.

### Patch Changes

- e2dd355: Clarify Work realtime room APIs, runtime-only CLI boundaries, operational limits, and CDN usage in the SDK and product documentation.
- 0f39153: Align Space creation across the SDK and CLI: support checkpoint bootstrap from the CLI, require API-mandated creation fields, expose typed bootstrap lifecycle metadata, preserve the bootstrap task ID in human-readable CLI output, and prevent Git credentials from leaking through bootstrap metadata or task responses.

## 4.9.0

### Minor Changes

- aea39ee: Add realtime rooms to the Work runtime. Works can create or join a code-scoped room through `client.work.realtime` and exchange generic JSON events over the existing WebSocket, with member presence, room-scoped sequencing, and short-lived admission tickets. High-frequency senders can use `room.send` to skip the per-event ack. Every connection is its own participant by default, and members carry an opaque `userKey` so an application can group a viewer's connections; a room created with `seatPerUser` gives each viewer a single seat instead.

## 4.8.0

### Minor Changes

- 93c1267: Add platform-managed Cohub Balance components to Work Commerce products, including SDK response types, retry-safe checkout attempts, and CLI creation and listing support.

## 4.7.1

### Patch Changes

- 3931642: Add idempotency keys to directory creation, deletion, move, and Board creation so interrupted filesystem mutations can be retried safely.

## 4.7.0

### Minor Changes

- ec5ffdb: Add generation model discovery helpers and hide generation declarations marked `hidden` from default CLI discovery while preserving exact-ID and explicit-policy access.

## 4.6.0

### Minor Changes

- 4735eea: Add optional browser upload progress and cancellation signals for public assets.

## 4.5.0

### Minor Changes

- 59443a9: Add friendly-first space invite URLs, invitation location metadata, reliable invitation limits and usage tracking, and CLI commands for creating, listing, and revoking invite links.

## 4.4.0

### Minor Changes

- f514b5e: Add paginated Space-level Turn listing with author and time boundaries, including CLI access.

## 4.3.0

### Minor Changes

- 651476c: Expose mounted Mod provenance in skill catalog entries and show the source slug in CLI listings.

## 4.2.0

### Minor Changes

- 4e9e994: Add SDK support for publishing arbitrary files and read-only Boards as Works.

  Work responses now expose their content kind and immutable artifact metadata,
  including captured Board snapshots and assets.

- 22c00f4: Add negotiated presigned PUT support for durable chat attachments while retaining legacy POST uploads.

## 4.1.0

### Minor Changes

- 3a9a51d: Add delayed, looping Board autoplay configured through Board metadata.

## 4.0.1

### Patch Changes

- 1fb5002: Docs: clarify `accessMode` in the Work Runtime Guide to prevent read-only 403s.

  The permission table and all `space.prompt()` examples only showed full-access
  prompts, with no mention that `session.prompt.readonly` requires
  `accessMode: "read_only"` in the call. Since the backend defaults `accessMode`
  to `full_access`, requesting only `session.prompt.readonly` and reusing the
  example code (no `accessMode`) yielded a 403.

  - Split the "Send a prompt" table row into full-access / read-only rows that
    name the `accessMode` parameter explicitly.
  - Add an `accessMode`-default warning and a complete read-only prompt recipe
    (auth.request + space.prompt + subscribeGeneration) to the LLM chat section.
  - Add a pitfalls checklist item for scope / `accessMode` mismatch.

## 4.0.0

### Major Changes

- b9e6840: Remove note board nodes and render Markdown file-card titles from frontmatter.

### Minor Changes

- 9350706: Add shared Board geometry for Figma-style rotation zones outside selection corners.
- 9350706: Add black and white to the shared Board tool palette and color types.
- ba7d325: Add shared Board tool-style defaults and controls, and increase the default text size.

### Patch Changes

- c1eb8ef: Allow Board hosts to render a themed image backdrop beneath the transparent canvas.
- 95ae57d: Render freehand Board strokes with stable rounded outlines through sharp turns and self-intersections.
- a98f930: Add typed `work.version.published` Space realtime events.
- 9350706: Preserve image proportions in Board file-card covers and remove the metadata footer.

## 3.2.0

### Minor Changes

- 54cd4d0: Move the Board document model, renderers, and image exporters into the Cohub SDK, organised by dependency so each entry only carries what it needs:

  - `@neta-art/cohub/board` — document schema, geometry, shapes, timeline compilation, and export planning. No PixiJS, so it runs on servers, agents, and edge workers.
  - `@neta-art/cohub/board/render` — the PixiJS card renderers, themes, and palette the editor draws with.
  - `@neta-art/cohub/board/export` — rendering a planned export to a canvas in the browser.
  - `@neta-art/cohub/board/headless` — Node.js image export on `@napi-rs/canvas`.

  `pixi.js` and `@napi-rs/canvas` stay optional peers, needed only for the rendering and export entries. Board modules also keep their build boundaries, so consumers tree-shake unused schemas and renderers instead of pulling in the whole model.

## 3.1.0

### Minor Changes

- 94a8f99: Board realtime: add optional `client.formFactor` to awareness state so peers can present a mobile touch contact as such, and carry server-owned `metadata` (including request provenance) on `board.transaction.applied` for CLI / Agent attribution.
- b47510a: Add Board realtime awareness subscriptions and updates for cursors, selections, creation gestures, drawing, and transforms.

## 3.0.0

### Major Changes

- ac1a3ce: Adopt Board across SDK types, REST endpoints, file formats, and realtime events. Add bound `BoardClient` entities with transaction and playback subscriptions.

### Minor Changes

- 077ce83: Add the Space startup API for preloading UI configuration and local preview sessions.

## 2.15.0

### Minor Changes

- 7dfa1d8: Add optional `thinkingLevel` to session prompts, scheduled prompts, channel model config, and space hooks. The level is fully optional — omitted values inherit the session default, matching existing provider/model behavior. UI, CLI, and SDK all support per-model thinking level selection driven by models config (`reasoning`, `defaultThinkingLevel`, `thinkingLevelMap`). Effective thinking level is persisted to turn meta and exposed on turn records for multi-client recovery.

### Patch Changes

- 7dfa1d8: Add optional file write baselines and mutation identifiers for conflict-aware autosave.

## 2.14.1

### Patch Changes

- dad311e: Recover WebSocket sessions from a transient authentication failure by forcing one access-token refresh, reconnecting once, and restoring room subscriptions without entering an infinite retry loop.

## 2.14.0

### Minor Changes

- f72fa82: Expose structured canvas transaction conflicts and richer published Work metadata through the Cohub SDK and CLI dependency bundle.

  - Export `CanvasTransactionError` with status, code, and `isVersionConflict` so clients can rebase and retry rejected canvas transactions.
  - Add `lang` and `themeColor` to published Work metadata types.

## 2.13.0

### Minor Changes

- Carry request provenance via `X-Cohub-Source-*` headers for cross-space traceability.

  - **SDK**: `requestSource` on client options (static or per-request getter); transport stamps `X-Cohub-Source-*` automatically; re-export provenance helpers (`readRequestSourceFromEnv`, `requestSourceToHeaders`, `mergeRequestSourceIntoMeta`, …).
  - **CLI**: every request sends `via: cli` and sandbox `COHUB_*` identity when present; drop ad-hoc `meta.source` / `versionMeta` / `meta.cohub` merge on works and generations.
  - **Breaking note**: `WorkCreateInput.versionMeta` removed — publish provenance is taken from request headers instead.

## 2.12.0

### Minor Changes

- d21c200: Ship the resource-references graph-edge model and empty-account Home space bootstrap that the API and agent already expose.

  - **feat(references): graph-edge model with agent file access stats** — turn-level sources, file targets, and agent tool file kinds (`agent_tool_file_read|write|edit|ls|find|grep`); drop redundant `participant` edges; `ReferenceRecord` uses `sourceSpaceId` / `sourceSessionId`; aggregate supports `groupBy=target` and `limit`.
  - **feat: auto-create Home space for empty accounts** — `spaces.getDefault()` creates a blank Home space (`slug=home`) when the account has no accessible space.
  - **CLI**: `references query` accepts `turn:<uuid>`; aggregate `--group-by target` / `--limit`; file targets render as short space id + path.

## 2.11.2

### Patch Changes

- 1d27866: Stop silent SSO login callback redirect loops by letting bootstrap `getMe` skip the unauthorized handler, and ship Apache-2.0 LICENSE/NOTICE with the published packages.

## 2.11.1

### Patch Changes

- 43b7653: Record optional provenance on work versions via `meta` (CLI auto-fills `source` from COHUB\_\* env).

## 2.11.0

### Minor Changes

- 6c0b75f: Add durable chat attachments that no longer require a session.

  SDK: `publicAssets.uploadChatAttachment()` for any file mime, optional `spaceId`/`sessionId` association only, and space upload `downloadUrl` materialize (skip client PUT when the file is already a durable public asset). `sandbox_tmp` destination `sessionId` is optional; plan entries may omit `uploadUrl`/`objectKey` for remote sources.

  CLI: `spaces prompt --image` works without `--session`; file upload complete skips remote `downloadUrl` entries that the server pulls itself.

### Patch Changes

- 86e11a7: Expose generation model discount billing details in SDK results and CLI output.

## 2.10.0

### Minor Changes

- a45d3e8: Add referral links, account referral management, and CLI referral commands.

## 2.9.0

### Minor Changes

- 74a3b9d: Add raw space LLM completions that skip the agent turn queue. Callers fully control message history and an optional space-relative system prompt file.

  SDK: `space.completion()` (JSON) and `space.streamCompletion()` (SSE deltas with abort-safe streaming).
  CLI: `cohub completion` / `cohub spaces completion` with `--stream`, `--system-prompt`, model/provider, temperature, max tokens, and thinking level.

## 2.8.0

### Minor Changes

- 4c28633: Broker mode can now resolve the workId at runtime from the public slug triple. Standalone Works no longer need to hardcode a workId that only exists after publishing — pass `work: { brokerOrigin, ownerUsername, spaceSlug, workSlug }` and the SDK reverse-looks-up the workId via the anonymous `works.getBySlug` API, caches it, and starts broker mode. Explicit `workId` still takes precedence, and bridge mode (inside the Cohub iframe) is unaffected.
- 9188401: Unify billing gate responses. Every billing-gated 402 (negative balance limit and plan entitlement) now returns a flat `{ code, message, billing: { conversion, status?, netUsd?, hardNegativeLimitUsd? } }` body, and soft debt warnings ride the same `billing` payload on success responses. The SDK adds `BILLING_ACCESS_BLOCKED_ERROR_CODE`, `isBillingAccessBlockedError`, `isBillingAccessBlockedCode`, `extractBillingPayload`, and a `BillingResponsePayload` type so clients extract the conversion intent with one call. Websocket `session.request.error` events now carry the same `billing` payload. The CLI surfaces the conversion title/message on 402.

### Patch Changes

- 10989f6: Record multimodal generation usage against the shared credit balance after successful provider calls. Add `generation.music` usage type, resolve image/video/music kinds for billing gates, and surface post-success `billing` metadata on generation task results.

  Also add hourly generation usage stats (mirroring LLM token rollups) so multimodal usage appears in trending and usage endpoints.

## 2.7.1

### Patch Changes

- 55eeac2: Remove the Guides table from the README top section; the Work runtime overview section at the bottom already links to the guide.

## 2.7.0

### Minor Changes

- 348f62a: Add `docs/work-runtime-guide.md` — a self-contained guide for building published Works that use Cohub capabilities from browser-side JavaScript. Covers the two-scope model (work scopes for reads vs viewer scopes for actions), bridge vs broker deployment modes, initialization recipe, capability reference (LLM chat, image generation, model listing, file reads, account-level data, commerce), a complete working example, and a pitfalls checklist.

  Also ship the guide with the npm package (`docs` added to `files`) and add a Guides table + Work runtime overview to the README.

## 2.6.0

### Minor Changes

- 805d300: Add preview session creation for private HTML previews and preserve viewer-scoped authorization when work runtime tokens refresh.

## 2.5.0

### Minor Changes

- 1fe514d: Extracted the work bridge host logic into a framework-agnostic `createWorkBridgeCore` (pure TS, no Svelte runes) so external hosts like Neta-Studio (React) can reuse the same message handling, token minting, authorization, and purchase flow.

  - **New exports**: `createWorkBridgeCore`, `WorkBridgeCore`, `WorkBridgeCoreConfig`, `WorkBridgeCoreWork`, `WorkBridgeDialogState`, `WorkAuthorizeRequest`, `WorkPurchaseRequest`, `WorkBridgeGetAccessToken`, `WorkBridgeGetViewerUuid`, `WorkBridgeRequestSignIn`.
  - **Grant cache moved to SDK**: `hasGrantedWorkScopes`, `setGrantedWorkScopes`, `clearGrantedWorkScopes` are now exported from `@neta-art/cohub` (previously internal to the web app). The web app's `work-grant-cache.ts` re-exports them for backward compatibility.
  - **`bridge-host.svelte.ts`** is now a thin Svelte 5 wrapper that delegates to the shared core, injecting auth dependencies (`getAuthToken`, `authStore`, `signInWithRedirectPath`). Zero behavior change for existing bridge (WorkSurface) and broker (`/work-auth`) consumers.

## 2.4.0

### Minor Changes

- 661b5b8: Added support for standalone (non-iframe) work deployments via a new auth broker transport (`PopupBrokerTransport`). Works can now run on their own origin and open a Cohub broker popup for auth, authorization, and purchase — with a ready-handshake and one-shot `window.close()`.

  - **New exports**: `PopupBrokerTransport`, `resolveWorkTransport`, `WorkRuntimeModeConfig`.
  - **`CohubClientOptions.work`**: configure `mode: "broker" | "bridge"`, `brokerOrigin`, and `workId`. Auto-detection falls back to bridge when in an iframe.
  - **Token persistence**: `WorkRuntimeApi` now caches restricted tokens in `localStorage` when a `workId` is provided, surviving page reloads; `forceRefresh` clears the cache.
  - **`WorksApi.getPublicById(id)`**: loads a published work's metadata by id without requiring space membership.
  - Non-interactive messages (`context`, `checkout-state`) are answered locally in broker mode without opening a popup.

## 2.3.0

### Minor Changes

- ace4b41: Ship pending SDK changes accumulated since 2.2.1 that the CLI already
  consumes (references, label patching) and must release together.

  - **feat: resource reference index** — add `ReferencesApi` exposed as
    `cohub.references` on both `CohubClient` and `CohubHttpClient`. `query()`
    lists references touching a resource (space/session/checkpoint); `aggregate()`
    returns grouped counts for a space. Plus the full `Reference*` type set
    (`ReferenceQueryableType`, `ReferenceKind`, `ReferenceDirection`,
    `ReferenceAggregateGroupBy`, `ReferenceRecord`, …).
  - **feat: incremental resource label patching** — add
    `SpaceLabelsApi.patchResourceLabels(resourceType, resourceRef, { addLabelRefs,
removeLabelRefs })` returning `{ labels, assignments, changed }`, alongside the
    existing full `setResourceLabels`. Adds `PatchResourceLabelsInput` /
    `PatchResourceLabelsResponse` types.
  - **feat: local sandbox provider** — add `SpaceSandboxProvider` (`"cloud" |
"local"`) on `SpaceSandboxConfig` / `SpaceConfigInput` / `SpaceSandboxRecord`
    so spaces can declare a local sandbox provider.
  - **feat: session auto-compact** — extend `CreateSpacePromptInput.intent` with
    `"compact"` for agent-driven context compaction.
  - **fix: each_key_duplicate crash in generation stream** — merge intermediate
    messages that share a `tool_use.id` but landed under different dedupe keys
    (ordinal-keyed snapshot path vs id-keyed persisted-message path), as
    defense-in-depth for records lacking `meta.messageOrdinal`.

## 2.2.1

### Patch Changes

- 7907e1d: Show buyer profiles on commerce orders and enforce the minimum product price.

## 2.2.0

### Minor Changes

- 2a29102: Add credit benefits and consumption to work commerce, closing the monetization loop.

  - Add virtual `cohub_credit` token type and `work.consumption` usage type to billing declarations. Credit amounts are plain integers at business scope — creators never see token types.
  - Add `createBusinessBillingOperations` / `createDisabledBusinessBillingOperations` for business-scoped entitlement lookups, credit status, and credit consumption. Shares the same credit mapping helpers as platform billing so the two never drift.
  - Space commerce now supports `credits` benefit type (amount + optional expiry). Token type, scope, and grant kind are fixed and hidden from creators.
  - Product serialization fills `display.creditBenefits` from bound credit benefits so Works can show "includes 500 credits".
  - Work commerce replaces `POST entitlements/check` with `GET entitlements` — one call returns feature entitlements and credit balance. Adds `POST credits/consume` with idempotent `operationId`.
  - SDK `cohub.work.commerce` gains `getEntitlements()` and `consumeCredits()`, replacing `checkEntitlements()`.
  - CLI `works commerce` gains `entitlements` and `credits consume` commands; `spaces commerce benefits create` gains `--type credits --amount`.
  - Web benefit editor supports both feature and credits types.

- 2a29102: Add SDK commerce APIs for Spaces and Works.

  - Add `cohub.work.commerce` helpers for product resolution, entitlement checks, checkout creation, checkout state lookup, and order retrieval inside published Works.
  - Expand Space commerce SDK APIs and types for products, benefits, bindings, and recent orders so Space-level commerce management is fully scriptable.
  - Improve transport and error handling for uninitialized commerce setups.

## 2.1.0

### Minor Changes

- 5220dc0: Gate space commerce management behind dedicated permissions and a Max/Internal entitlement.

  - Add `space.commerce.view` / `space.commerce.manage` permissions (host only), replacing `space.edit` on commerce routes so commerce access is decoupled from content editing.
  - Add the `space.commerce` billing feature; setup and product/benefit configuration now require an active entitlement (granted by Max and Internal plans). Reads remain permission-gated only.
  - 402 responses carry a `feature_not_entitled` billing conversion intent so the shared upgrade UI can present plan options. Add `createFeatureGateConversionIntent` helper for reuse by future entitlement gates.

## 2.0.0

### Major Changes

- f853227: Rework work publishing around explicit visibility and version publication.

  SDK breaking changes: remove the `draft` work status and `publishVersion` update flag, add `WorkVisibility` on work create/update records, add `WorksApi.publishVersion()`, and slim `WorkVersionRecord` fields to match the API response.

  CLI breaking changes: remove draft status flags and `cohub works update --publish-version`, replace version publication with `cohub works publish-version`, add work visibility controls, and support role-qualified generation media inputs.

## 1.34.0

### Minor Changes

- Add Space default resolution and presence APIs, including presence snapshots, websocket presence updates, and `presence.updated` events.

## 1.33.1

### Patch Changes

- 1caff2c: Fix realtime room routing in the websocket SDK and keep the package publish flow aligned with the updated gateway routing.

## 1.33.0

### Minor Changes

- a8c3181: Release enriched work responses, mod prompt templates, streaming snapshot recovery fixes, and Cohub Ask rendering updates.

## 1.32.0

### Minor Changes

- Add generation stream snapshot recovery APIs, improve active generation resume behavior, and polish workspace preview interactions with immersive preview, per-session composer drafts, Mermaid touch zoom, and mobile member role controls.

## 1.31.0

### Minor Changes

- 3936634: Add SDK and CLI support for work presentation metadata, including Cohub bar visibility controls, and expose billing feature entitlement checks.

## 1.30.0

### Minor Changes

- 8455e51: Add `UserApi.listSessions()` for paginated cross-space session listing and `UserApi.getUsage(days)` for aggregated account-level usage. New permission scopes: `user.space.list`, `user.session.list`, `user.usage.read`.

## 1.29.0

### Minor Changes

- 4393131: Add `env` field to `CreateSpacePromptInput` and `SendMessageCronJobPayload` for prompt-scoped environment variables.
- 4393131: Enhance `CheckpointRecord` type with optional `rootCheckpointId` and `saveVersion` fields, and make `meta` optional.
- 4393131: Add WeChat channel login methods `startWeChatLogin()` and `waitWeChatLogin()` on `ChannelsApi`, with optional verify code flow support.

## 1.28.2

### Patch Changes

- Release work management, public asset, and CLI attachment updates.

## 1.28.1

### Patch Changes

- Release checkpoint pagination and work runtime stability fixes.

## 1.28.0

### Minor Changes

- e79488b: Add generation.create permission
- e79488b: Add works management APIs (get, update, delete) and WorkUpdateInput type

## 1.27.1

### Patch Changes

- Release the SDK with the latest updates.

## 1.27.0

### Minor Changes

- 9a523d0: Refactor billing API: replace `getUsageRecords` / `getOverages` with unified `getBalanceActivities`, replace `purchaseAddon` / `subscribePlan` with `createOrder` / `createSubscription`, add `createRedemption`, remove `getOrders` / `cancelOrderCheckout`, and update `cancelSubscriptionCheckout` / `cancelSubscriptionAutoRenew` method signatures. Remove related legacy types.
- 9a523d0: Remove `SessionMessagesClient.send()` method and related `SessionSendMessageInput` type. Messages are now sent exclusively through the websocket-based generation stream API.

## 1.26.0

### Minor Changes

- Release scheduled job management updates, including SDK support for cron job detail, patch updates, and paginated run listing, plus CLI commands for scheduled job inspection and updates.

## 1.25.2

### Patch Changes

- Publish work sharing and publishing updates.

## 1.25.1

### Patch Changes

- Expose the existing checkpoint save response flag in the SDK type.

## 1.25.0

### Minor Changes

- Add checkpoint file browsing APIs and CLI support, plus Suno music generation compatibility.

## 1.24.0

### Minor Changes

- Release v1.49.0 with realtime canvas persistence and operation sync, space layout customization, custom space styles, label-scoped search, guest prompt access hardening, loading state refinements, and turn navigator polish.

## 1.23.1

### Patch Changes

- Expose generation waiting lifecycle updates and refine runtime status rendering.

## 1.23.0

### Minor Changes

- Release v1.48.0 with background task controls, billing account expansion, session queue stability, active label highlighting, file preview support, and agent wakeup hardening.

## 1.22.0

### Minor Changes

- Add browser voice input support with Volc ASR, including the new `voice-input` SDK export, realtime WebSocket reuse during idle periods, and related split-view stability fixes.

## 1.21.0

### Minor Changes

- Release label refs in prompts, automatic session source labels, label item management, and CLI label command updates.

## 1.20.0

### Minor Changes

- Release billing balance details, billing plans and redemption flow, and label-based space organization APIs.

## 1.19.0

### Minor Changes

- 2312811: Release Mirror updates with read-only prompt access, shared session visibility improvements, and session participant metadata.

## 1.18.1

### Patch Changes

- 1ade102: Publish npm packages for the latest release.

## 1.18.0

### Minor Changes

- ce0e5fb: Expose generation policy helpers and metadata propagation for session generation tasks.

  Add CLI-side generation policy enforcement from environment variables and filter model listings accordingly.

## 1.17.0

### Minor Changes

- 1f860ba: Clean up legacy realtime turn progress/snapshot events and add session/task lifecycle realtime events.

## 1.16.1

### Patch Changes

- 884b3d0: feat(cli): improve generation task feedback and output labels; fix fetch failure diagnostics and surface generation provider details; upgrade neta generation to 0.1.2

## 1.16.0

### Minor Changes

- 109cf4d: feat: add multimodal model show command, billing credits integration, and async task refactor

  - Add multimodal model show command for CLI
  - Integrate billing credits support
  - Refactor generations to async tasks
  - Fix CLI auth, space defaults, and JSON output flag
  - Recover from transient unauthorized responses

## 1.15.1

### Patch Changes

- 02519c6: Restore named space mod mounts and sandbox restart metadata in the SDK and CLI.

## 1.15.0

### Minor Changes

- 133275c: Release SDK support for public asset uploads, space slugs, space public profiles, and default space mods.

  Release CLI avatar upload commands for user and space profiles, plus updated space mod management output.

## 1.14.0

### Minor Changes

- 872b08c: Add timing tracking for session messages and turns, expose persisted duration metadata in SDK streams, and add run command support for space sandboxes via new SDK API.

## 1.13.1

### Patch Changes

- fc1dc64: Update sandbox upload materialization types and CLI space handling.

## 1.13.0

### Minor Changes

- 48bdf1b: Add SDK and CLI support for usernames, sectioned Explore spaces, space pins, and sandbox lifecycle controls.

## 1.12.0

### Minor Changes

- Expose space access permissions in the SDK and improve CLI/API error messages.

## 1.11.0

### Minor Changes

- 4eed38f: Add space mod APIs and CLI commands.

## 1.10.2

### Patch Changes

- bfe50bf: update eventstream logging

## 1.10.1

### Patch Changes

- 3846078: Add a tree-shakeable debugger subpath for browser-side console and network collection, with JSON log and HAR export helpers.

## 1.10.0

### Minor Changes

- 78a111b: Publish the latest SDK, CLI, and web updates, including space file upload support, refreshed realtime protocol handling, batch file APIs, command palette and streaming tool call UI improvements, and package build tooling improvements.

## 1.9.0

### Minor Changes

- 31f5713: Release updated protocol, SDK, and CLI packages.

  - Rename generation model listing response types to match the `/api/models?modelType=multimodal` API shape.
  - Add SDK helpers for multimodal models and search access.
  - Improve CLI auth flow, search commands, command help, and self-update behavior.

### Patch Changes

- Updated dependencies [31f5713]
  - @cohub/protocol@2.0.0

## 1.8.0

### Minor Changes

- Add multimodal generation protocol types, SDK APIs, and CLI commands.

### Patch Changes

- Updated dependencies
  - @cohub/protocol@1.6.0

## 1.7.1

### Patch Changes

- 4e62670: Make `session.subscribeGeneration(...)` keep independent stream reducer state per subscription, preventing cached session clients from sharing generation progress, patch, and intermediate-message state across repeated subscribers.

## 1.7.0

### Minor Changes

- c53aaec: Introduce SessionGenerationStreamClient and normalized generation subscription, redesign session fork architecture with segment-based turns

### Patch Changes

- Updated dependencies [c53aaec]
  - @cohub/protocol@1.5.0

## 1.6.0

### Minor Changes

- 341bfc0: Add turn abort/steer reason, continuedByTurnId to turn summary; add turnId/userMessageId to websocket events
- Add `SessionGenerationStreamClient` and `session.subscribeGeneration(...)` for normalized generation events across turn patches, persisted assistant commits, finalized turns, and errors.

### Patch Changes

- Updated dependencies [341bfc0]
  - @cohub/protocol@1.4.0

## 1.5.1

### Patch Changes

- c469fb2: Fix websocket compact stream buffering after reconnecting into an active session turn from a snapshot.

## 1.5.0

### Minor Changes

- c688cc5: feat: unified space prompt scheduling, session patch stream isolation, and SDK/CLI improvements

  - Add unified space prompt scheduling with `CreateSpacePromptInput` and `clientMessageId` support
  - Add `getSessionTurnPatchStreamKey()` to isolate session patch streams by message
  - Add `sourceMessageId` and `messageOrdinal` fields to `SessionTurnPatchEvent`
  - SDK: add spaces API, update tasks/cron-jobs APIs, extend types, simplify websocket stream logic
  - CLI: add spaces commands, update cron-jobs/tasks commands
  - Clean up stale `.d.ts`/`.js` artifacts from protocol source directory

### Patch Changes

- Updated dependencies [c688cc5]
  - @cohub/protocol@1.3.0

## 1.4.0

### Minor Changes

- d5b8d41: - `SessionPatchReducer`：支持对 `/message/content/blocks/{n}/...` 下任意 JSON 子路径的 `append`（字符串前缀追加）与 `replace`（深度赋值），不再仅识别 `text` / `thinking` 等固定路径。
  - 开发用 `tsconfig`：为 `@cohub/protocol/ports` 增加 `paths` 映射，修复 typecheck 无法解析该子路径的问题；`tsconfig.build.json` 同步增加 `ports` 的 dist 映射以便构建。

## 1.3.1

### Patch Changes

- Release current package updates.
- Updated dependencies
  - @cohub/protocol@1.2.3

## 1.3.0

### Minor Changes

- f469947: Add SDK support for explore spaces, space profile and pinned-resource APIs, sandbox status/ports/recreate APIs, session turn pagination/index/window/detail/signed-url APIs, authenticated file downloads, user rules, and raw/blob transport helpers.

  Improve realtime handling with turn updated/finalized and ports changed events, plus buffered out-of-order patch frames for more reliable compact streams.

## 1.2.2

### Patch Changes

- a2cb8ff: 现在在刷新会话页面时会自动接续未完成的 stream
- Updated dependencies [a2cb8ff]
  - @cohub/protocol@1.2.2

## 1.2.1

### Patch Changes

- 66b4ef8: Add lightweight WebSocket compact frames for session patch streaming, with SDK negotiation and decoding support.
- Updated dependencies [66b4ef8]
  - @cohub/protocol@1.2.1

## 1.2.0

### Minor Changes

- 0797485: Add environment-aware SDK and CLI defaults for production and development Cohub endpoints, and publish updated protocol filesystem realtime types.

### Patch Changes

- Updated dependencies [0797485]
  - @cohub/protocol@1.2.0
