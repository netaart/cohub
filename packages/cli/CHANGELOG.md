# @neta-art/cohub-cli

## 7.1.1

### Patch Changes

- Updated dependencies [aae2f73]
  - @neta-art/cohub@8.20.1

## 7.1.0

### Minor Changes

- 6fbea1e: Project durable Session Turns into native Pi and Codex harness history, so a resumed local Runtime continues from the exact conversation instead of replaying it. Projections are incremental and bounded, honor compaction boundaries, keep the native harness files safe, and validate the source cursor. Turn and message fetches accept an `AbortSignal`, and the projection helpers and types are exported from the SDK.
  
  把持久化的 Session Turn 投影为 Pi 与 Codex 的原生 harness 历史，本地 Runtime 恢复时从准确位置续写而非重放整段对话。投影为增量且有界，遵循压缩边界，保证原生 harness 文件安全并校验来源游标。Turn 与消息请求支持 `AbortSignal`，投影辅助函数与类型从 SDK 导出。

### Patch Changes

- 42909b6: Local Runtime remembers a Space per canonical directory, account, and environment, so repeated `cohub runtime up` commands reuse the same Space. Explicit Space targets update the binding, and space-scoped CLI commands use the current directory binding before Home.
  
  Local Runtime 按规范化目录、账号和环境记住对应的 Space，重复执行 `cohub runtime up` 时复用同一个 Space。显式 Space 目标会更新绑定，其他 Space-scoped CLI 命令也会优先使用当前目录绑定，再回退到 Home。
- 21d5227: Expose nullable file-monitoring health in Runtime status and use a single backend-neutral watcher event source. Sandbox archive validation accepts the currently published `v1.82.4` binary-only artifact during the one-time release transition and validates the native release shape with license notices. The sandbox binary pin remains unchanged until new CDN artifacts are verified.
  
  Runtime 状态增加可空的文件监听健康信息，文件事件统一使用通用后端来源。Sandbox 归档在本次发布过渡期间接受当前已发布的 `v1.82.4` 单二进制格式，同时校验带许可证的新制品。新的 CDN 制品验证完成前保持现有 Sandbox 二进制版本 pin。
- 5394f11: Add redacted, local-only Runtime diagnostics with bounded JSONL rotation, incremental `runtime logs`, sandboxd output capture, stable runtime identity, and request/trace correlation across the Agent, Gateway, API, and Web status surfaces.
  
  增加脱敏且仅保存在本机的 Runtime 诊断能力：有界 JSONL 轮转、增量 `runtime logs`、sandboxd 输出采集、稳定 Runtime ID，以及贯通 Agent、Gateway、API 和 Web 状态页的 request/trace 关联。
- Updated dependencies [50f5c60]
- Updated dependencies [21d5227]
- Updated dependencies [5394f11]
- Updated dependencies [6fbea1e]
- Updated dependencies [25f9a5b]
  - @neta-art/cohub@8.20.0

## 7.0.1

### Patch Changes

- 65499d6: **Event-driven local Runtime recovery.** Recovery is Session-scoped and triggered by real
  events: the local Runtime reports pending executions in bounded batches after connecting,
  Gateway peer disconnects and transport uncertainty enqueue reconciliation for that Session,
  and only the affected Chat exposes stop confirmation. Realtime and channel notifications are
  best effort; committed messages and terminal turns stay authoritative. `runtime.hello` drops
  `pendingExecutions`, `RuntimeStatus` drops the Space-wide `recovery` / `canManage` fields, and
  `confirmRuntimeStopped(sessionId, …)` requests `expectedTurnId`. The local Runtime was never
  live, so these type changes ship as a patch.
  
  **事件驱动的本地 Runtime 恢复。** 恢复改为 Session 粒度并由真实事件触发：本地 Runtime 连接后
  分批上报待恢复执行，Gateway peer 断开与传输结果不确定都会为该 Session 入队协调，仅受影响的
  Chat 暴露停止确认。实时与渠道通知降级为 best effort，已提交的消息与终态 turn 仍是权威数据。
  `runtime.hello` 移除 `pendingExecutions`，`RuntimeStatus` 移除 Space 级 `recovery` / `canManage`，
  `confirmRuntimeStopped(sessionId, …)` 需要 `expectedTurnId`。本地 Runtime 从未上线，因此这些类型
  变更为 patch。
- Updated dependencies [c19a941]
- Updated dependencies [65499d6]
  - @neta-art/cohub@8.19.0

## 7.0.0

### Major Changes

- 566be22: Add local Runtime support: `cohub runtime up|status` connects a local workspace and
  dispatches turns to local Pi or Codex Harnesses. Sessions, turns, messages, streaming
  and resumption stay on the existing Cohub pipeline, and disconnections reconcile
  automatically.
  
  The previous `cohub sandbox up|status` commands are removed; use `cohub runtime` instead.

### Minor Changes

- eff7ca6: Add structured App authorization with explicit targets, viewer-controlled fallback, host capability negotiation, and incremental consent. Preserve legacy authorization return types. Fix logged-out consent, login recovery, canonical App slug resolution, and viewer cache isolation. Add `apps authorize --extend`.
  
  新增结构化 App 授权、明确目标、用户 Space 回退、宿主能力协商与增量授权，保留旧接口返回类型。修复未登录授权、登录恢复、App slug 解析与账户缓存隔离；CLI 新增 `apps authorize --extend`。

### Patch Changes

- Updated dependencies [eff7ca6]
- Updated dependencies [566be22]
  - @neta-art/cohub@8.18.0

## 6.12.0

### Minor Changes

- 50d6f00: **App version history and provenance.** Published apps now expose their immutable version history, and every version carries the session it was published from.
  
  - Public app pages gain a Cohub bar version switcher: `?cohub_v=<n>` selects a version, `getBySlug(…, { version })` fetches that version's content, and `listPublicVersions()` returns the history. SSR resolves the requested version; switching is a client-side fetch that keeps the URL shareable.
  - `AppVersionRecord.source` and `AppVersionSource` describe provenance (`sessionId`, `turnId`, `turnSequence`, `via`). The raw `meta.source` stamped at publish time is no longer exposed, provenance is validated against the app's own space, and session identity/title is included only when the caller holds `session.view` for the source session — so a private session never leaks through a published app, and viewer-scoped responses are never shared-cached.
  - `cohub apps versions` prints a Source column: the source session title when visible, otherwise the publishing channel.
  - The public page docks the Cohub bar above the App instead of floating over it, keeps the Cohub wordmark in that bar, and opens a version's source session in a new tab. Version history loads off the public page's critical path, so the first render never waits for it.

### Patch Changes

- Updated dependencies [50d6f00]
- Updated dependencies [4071454]
- Updated dependencies [f33c6ca]
- Updated dependencies [c89672c]
- Updated dependencies [f33c6ca]
- Updated dependencies [f33c6ca]
  - @neta-art/cohub@8.17.0

## 6.11.2

### Patch Changes

- Updated dependencies [96a30a9]
  - @neta-art/cohub@8.16.0

## 6.11.1

### Patch Changes

- Updated dependencies [eff8a32]
- Updated dependencies [a5ffd93]
  - @neta-art/cohub@8.15.0

## 6.11.0

### Minor Changes

- 1363e2c: Show pricing in `cohub models ls` and `cohub models show`.
  
  - `models ls` prints each LLM's per-million-token cost, e.g. `$3 /M input · $15 /M output · $0.30 /M cache read`.
  - `models ls --model-type multimodal` and `models show` render a compact unit price such as `$0.04 / image` or `$0.10–$0.50 / second · resolution`.
  - `models ls --model-type multimodal --json` now includes the raw `pricing` object for machines.
  - `models ls` now hides models marked `hidden` (matching the web picker) for both human and `--json` output, and omits providers left with no visible models.

### Patch Changes

- Updated dependencies [c7b6df3]
- Updated dependencies [fd5fdd5]
- Updated dependencies [785f9a9]
  - @neta-art/cohub@8.14.0

## 6.10.0

### Minor Changes

- 5232f9f: Add space webhook triggers (`on.event: webhook`) and hook `uses` App Actions.

### Patch Changes

- Updated dependencies [5232f9f]
  - @neta-art/cohub@8.13.0

## 6.9.1

### Patch Changes

- Updated dependencies [2fe6bee]
- Updated dependencies [95622b1]
  - @neta-art/cohub@8.12.1

## 6.9.0

### Minor Changes

- 311c47d: Board edit history is now replayable. `createBoardReplayPlayer()` (SDK) turns a Board's transaction log into render documents — it rewinds through the server-computed inverses and plays forward through payloads, handling version gaps and paging in both directions — and `cohub boards transactions <board>` (CLI, alias `history`) pages through the same log. The API exposes `GET /spaces/:id/boards/:boardId/transactions`, which returns newest-first pages read under one repeatable-read snapshot with the current rows as the replay anchor. Read-only: nothing is ever written to the Board. In the web workspace, "Replay history" opens a private read-only stage with a scrubber, play/pause, speed control, step, camera follow and live tail appends.
- a869400: Board motion is now optional and preset-based. Boards default to no motion; the built-in `effects.deal` preset can be selected as the default enter motion (`appearance.motion.enter`) or applied to an individual node with an `on-enter` effect. `kindVersion` defaults to `1` on effect and preset input. Reduced-motion handling is preserved.
  
  The Board-local theme registry is removed from `@neta-art/cohub/board/render`: `getBoardThemeRenderer`, `registerBoardThemeRenderer`, `BoardThemeRenderer`, `BoardThemeContext` and `cleanBoardTheme` no longer exist. The registry was never wired to `appearance.theme` and always resolved to the single built-in background; use `createBoardBackground` / `updateBoardBackground` instead. Board colors continue to come from Cohub theme tokens, and `appearance.theme` / `appearance.mood` are now optional and ignored by rendering.
- 41b2ae5: Apps can open as an **overlay**: a transparent, chrome-free layer above the Space workspace instead of a preview tab. `cohub desktop open <app> --as overlay` requests it, and a page published with `<meta name="cohub:surface" content="overlay">` opens that way by default. Inside the App, `context.invocation.surface` reads `"overlay"`, and `cohub.app.requestConfigure({ geometry, inputRegion })` controls where the overlay sits and which rectangles accept pointer events — everything else (context, auth, Space APIs, realtime, `surface.handle()` + `--call`, composer chips, navigation, commerce) works as in a tab. Overlays close through `cohub.app.requestClose()` or `Escape` in the workspace.
  
  Republishing now updates page-derived metadata (title, description, icon, image, lang, theme color, surface) when the current value is the one extraction last wrote; values a publisher set by hand that differ from the page are kept.

### Patch Changes

- Updated dependencies [a1df456]
- Updated dependencies [311c47d]
- Updated dependencies [a869400]
- Updated dependencies [41b2ae5]
- Updated dependencies [35be140]
- Updated dependencies [bea9903]
  - @neta-art/cohub@8.12.0

## 6.8.2

### Patch Changes

- Updated dependencies [1f326f4]
- Updated dependencies [a34dc95]
- Updated dependencies [925d712]
  - @neta-art/cohub@8.11.0

## 6.8.1

### Patch Changes

- a8201f0: CLI help now resolves the command path before printing, so unknown prefixes like `cohub cli apps publish --help` error instead of dumping top-level help. Local uploads honor `http_proxy`/`https_proxy` via Node's `--use-env-proxy`, send `Content-Length`, and retry transient PUT failures.
- Updated dependencies [5f4f0bc]
  - @neta-art/cohub@8.10.2

## 6.8.0

### Minor Changes

- 8633eb5: CLI commands now fall back to the Home space when `-s` / `COHUB_SPACE_ID` are omitted (`GET /api/spaces/default`, cached per login). `apps publish` infers `--source` from runtime (workspace in a sandbox, local otherwise). `getCohubContext()` treats runtime as sandbox only when an execution token is present.

### Patch Changes

- Updated dependencies [8633eb5]
  - @neta-art/cohub@8.10.1

## 6.7.0

### Minor Changes

- 6f9d3d5: Publish local app sources from the CLI: upload your app source to the server and have the worker publish its assets. The SDK execution context and task waiting APIs are hardened accordingly, with new public-assets helpers for app source publishing.

### Patch Changes

- Updated dependencies [6f9d3d5]
  - @neta-art/cohub@8.10.0

## 6.6.0

### Minor Changes

- c59bc31: Add published App Actions backed by existing Run Command Task Runs, with owner-funded execution, viewer-scoped App Commerce access, and private owner diagnostics.

### Patch Changes

- Updated dependencies [c59bc31]
  - @neta-art/cohub@8.9.0

## 6.5.0

### Minor Changes

- 0cd4d32: Turn browsing now matches the Web session view:
  
  - `spaces turns ls --session <sessionId>` lists full turns from one session (the same endpoint the Web session view uses), with `--cursor <sequence>` and `--direction older|newer` pagination.
  - New `spaces turns intermediate <sessionId> <turnId>` command reads a turn's persisted intermediate messages from its CDN archive; `--json` returns the raw archive without reducing its content blocks.

### Patch Changes

- Updated dependencies [9275e77]
- Updated dependencies [0cd4d32]
  - @neta-art/cohub@8.8.0

## 6.4.0

### Minor Changes

- f9b6156: Board CLI improvements:
  
  - `boards create` now reports the created Board file path (including in JSON output).
  - `boards items list/get` show derived layout columns (x/y/width/height) for draw and arrow items.
  - Board example templates are updated to the normalized geometry authoring format.

### Patch Changes

- Updated dependencies [f9b6156]
  - @neta-art/cohub@8.7.0

## 6.3.0

### Minor Changes

- 6685de4: Streamline Board CLI commands:
  
  - Add `boards batch` to apply an atomic batch of semantic Board changes in one round-trip.
  - Add `boards connections` (list/get) for managing typed connections between Board items.
  - Split effect, composition, animation, and item commands into `list`/`get` subcommands with consistent JSON and table output.
  - Remove the low-level `boards nodes` command in favor of the semantic item commands.
  - Import board helpers from the public SDK.

### Patch Changes

- Updated dependencies [6685de4]
  - @neta-art/cohub@8.6.0

## 6.2.2

### Patch Changes

- Updated dependencies [a279343]
  - @neta-art/cohub@8.5.1

## 6.2.1

### Patch Changes

- 3dd452b: Run CLI self-updates in a detached background worker so foreground commands are not blocked. Successful updates take effect on the next invocation.

## 6.2.0

### Minor Changes

- 6a83978: fix(cli): upload directory contents directly under --dir

  `spaces files upload <dir> --dir <target>` used to nest the source
  directory name under the target (`target/<dir>/...`). It now contributes
  the directory's contents directly (`target/...`), matching common cloud
  CLIs (`aws s3 cp dir`, `rclone copy`).
  File arguments are unchanged. Inputs whose contents collide on the same
  relative path now fail fast instead of silently overwriting.

## 6.1.6

### Patch Changes

- Updated dependencies [9884704]
  - @neta-art/cohub@8.5.0

## 6.1.5

### Patch Changes

- Updated dependencies [7baf58e]
- Updated dependencies [7baf58e]
  - @neta-art/cohub@8.4.0

## 6.1.4

### Patch Changes

- 38b9451: Apps publish: explain Space-path targets instead of failing with a bare 404.

  - `apps publish` / `apps update` now preflight `--file` / `--dir` targets against the target Space's workspace and fail before publishing with an explicit message, e.g. `"dist" does not exist in the Space workspace (--dir takes a Space workspace path, not a local path).`
  - When the publish worker still rejects a target (e.g. removed between check and snapshot), the bare worker error is translated to the same explicit wording.
  - Help text and docs now state that `--file` / `--dir` take Space workspace paths, not local paths.

## 6.1.3

### Patch Changes

- Updated dependencies [0511cbe]
  - @neta-art/cohub@8.3.1

## 6.1.2

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@8.3.0

## 6.1.1

### Patch Changes

- Updated dependencies [5d2a4b7]
  - @neta-art/cohub@8.2.0

## 6.1.0

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

### Patch Changes

- Updated dependencies [9bec315]
  - @neta-art/cohub@8.1.0

## 6.0.1

### Patch Changes

- Updated dependencies [7e0f977]
  - @neta-art/cohub@8.0.1

## 6.0.0

### Major Changes

- 5c0c0b2: Rename the Work commands to App/Desktop vocabulary in the CLI.

  **Breaking changes**

  - `cohub apps` is the canonical command for managing published Apps (replacing `cohub works`).
  - `cohub desktop open` is the canonical command for opening a surface/tab (replacing `cohub ui preview`).

  **Compatibility**

  - `cohub works` and `cohub ui preview` remain as deprecated aliases, so existing scripts and muscle-memory keep working until the next breaking release.
  - The CLI now reads and writes the canonical App wire vocabulary end to end.

### Patch Changes

- Updated dependencies [53ca326]
- Updated dependencies [ef6d8dd]
- Updated dependencies [8bfcc4e]
- Updated dependencies [5c0c0b2]
  - @neta-art/cohub@8.0.0

## 5.0.0

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

### Patch Changes

- Updated dependencies [24c7201]
  - @neta-art/cohub@7.0.0

## 4.0.0

### Major Changes

- 1db3791: Replace Board sequences with atomic animation compositions built from typed tracks, keyframes, procedural clips, markers, and explicit playback policies. Board mutations now return durable idempotency receipts, and the CLI exposes composition-first authoring commands.

### Patch Changes

- 19d15a2: Document and expose viewer-authorized `taskrun.view` access for published Works.
- Updated dependencies [1db3791]
- Updated dependencies [19d15a2]
- Updated dependencies [342f6d5]
  - @neta-art/cohub@6.0.0

## 3.12.0

### Minor Changes

- 057a590: Add persisted Board backgrounds, semantic camera focus clips, summary and mutation SDK helpers, semantic CLI commands for nodes, connections, appearance, playback policy, effects and sequences, safe Board target resolution, and atomic exports.

### Patch Changes

- Updated dependencies [057a590]
  - @neta-art/cohub@5.10.0

## 3.11.0

### Minor Changes

- 7844146: Support Space file previews from the CLI: `cohub ui preview` accepts `file://<path>` or a relative Space path (resolved against the active space), alongside the existing Work refs and the new `work://` scheme. The SDK now exports `UiFilePreviewTarget` for the extended `preview.show` command.

### Patch Changes

- Updated dependencies [7844146]
  - @neta-art/cohub@5.9.0

## 3.10.2

### Patch Changes

- Updated dependencies [8dcd9a4]
  - @neta-art/cohub@5.8.2

## 3.10.1

### Patch Changes

- d32ab93: Accept UUID v6-v8 identifiers consistently across SDK and CLI resource parsing.
- 4decc5c: Add generic and Meta Work promotion links with aggregated landing and readiness analytics.
- Updated dependencies [d32ab93]
- Updated dependencies [4decc5c]
- Updated dependencies [de8d59e]
  - @neta-art/cohub@5.8.1

## 3.10.0

### Minor Changes

- 1ed2878: Add a shared native Board node contract, semantic node builder, machine-readable validation diagnostics, and capability discovery for SDK and CLI clients.
- 6be8f7e: Add direct, space-scoped public file uploads and inspection with OSS-native overwrite protection in the SDK and CLI.

### Patch Changes

- 0dbc522: Use `cohub.live` endpoints and hosted app origins across the SDK and CLI.
- 8736c29: Send the Sandbox runtime version as request provenance when Cohub CLI requests inherit a valid Sandbox environment.
- Updated dependencies [2539eb6]
- Updated dependencies [1ed2878]
- Updated dependencies [6be8f7e]
- Updated dependencies [10d93b2]
- Updated dependencies [0dbc522]
- Updated dependencies [8736c29]
  - @neta-art/cohub@5.8.0

## 3.9.6

### Patch Changes

- Updated dependencies [0d6e57d]
- Updated dependencies [48ec699]
  - @neta-art/cohub@5.7.0

## 3.9.5

### Patch Changes

- Updated dependencies [03f9ee7]
  - @neta-art/cohub@5.6.0

## 3.9.4

### Patch Changes

- Updated dependencies [82c244c]
  - @neta-art/cohub@5.5.0

## 3.9.3

### Patch Changes

- a44a111: Print file modification times as ISO timestamps in `spaces files ls` and `spaces checkpoints ls-tree`, instead of the raw epoch float the API returns (`1786553072104.8674`). Table columns accept an optional `format` mapper, so `--json` output keeps the machine-readable value.

## 3.9.2

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@5.4.3

## 3.9.1

### Patch Changes

- Preserve original avatar formats (JPEG/PNG/GIF/WebP) and upload avatars as immutable assets with stable URLs, so replacing a profile or space avatar no longer breaks previously served images.
- Updated dependencies
  - @neta-art/cohub@5.4.2

## 3.9.0

### Minor Changes

- **`boards inspect` connections**: `--include connections` is now accepted by the CLI (its local section list previously rejected the request), and the human-readable output reports a Connections count alongside the other structural stats.

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@5.4.1

## 3.8.4

### Patch Changes

- Updated dependencies [278a194]
  - @neta-art/cohub@5.4.0

## 3.8.3

### Patch Changes

- Updated dependencies [9a0eeb1]
  - @neta-art/cohub@5.3.3

## 3.8.2

### Patch Changes

- 7d42fe1: Relaunch the CLI after an automatic update so the current command runs with the newly installed version.
- Updated dependencies [0a82a02]
- Updated dependencies [0628b24]
  - @neta-art/cohub@5.3.2

## 3.8.1

### Patch Changes

- Updated dependencies [89e0b1c]
  - @neta-art/cohub@5.3.1

## 3.8.0

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

### Patch Changes

- Updated dependencies [6d68beb]
  - @neta-art/cohub@5.3.0

## 3.7.0

### Minor Changes

- Add `cohub works stats` for viewing published Work view analytics by ID, URL, mention URI, or public slug.

## 3.6.4

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@5.2.0

## 3.6.3

### Patch Changes

- Updated dependencies [6602d1d]
  - @neta-art/cohub@5.1.1

## 3.6.2

### Patch Changes

- a5fd97b: Remove redundant content verification status fields from Work download results.

## 3.6.1

### Patch Changes

- b568eae: Allow Work downloads to restore CDN-rewritten content without comparing published file sizes or checksums. Download results report that content verification was skipped.

## 3.6.0

### Minor Changes

- a7b9292: Add structured Work mentions, public-reference resolution, immutable artifact manifests, and verified file or directory Work downloads.

### Patch Changes

- Updated dependencies [a7b9292]
  - @neta-art/cohub@5.1.0

## 3.5.2

### Patch Changes

- e2dd355: Clarify Work realtime room APIs, runtime-only CLI boundaries, operational limits, and CDN usage in the SDK and product documentation.
- 0f39153: Align Space creation across the SDK and CLI: support checkpoint bootstrap from the CLI, require API-mandated creation fields, expose typed bootstrap lifecycle metadata, preserve the bootstrap task ID in human-readable CLI output, and prevent Git credentials from leaking through bootstrap metadata or task responses.
- Updated dependencies [e2dd355]
- Updated dependencies [0f39153]
- Updated dependencies [e307ac2]
  - @neta-art/cohub@5.0.0

## 3.5.1

### Patch Changes

- Updated dependencies [aea39ee]
  - @neta-art/cohub@4.9.0

## 3.5.0

### Minor Changes

- 93c1267: Add platform-managed Cohub Balance components to Work Commerce products, including SDK response types, retry-safe checkout attempts, and CLI creation and listing support.

### Patch Changes

- Updated dependencies [93c1267]
  - @neta-art/cohub@4.8.0

## 3.4.1

### Patch Changes

- Updated dependencies [3931642]
  - @neta-art/cohub@4.7.1

## 3.4.0

### Minor Changes

- ec5ffdb: Add generation model discovery helpers and hide generation declarations marked `hidden` from default CLI discovery while preserving exact-ID and explicit-policy access.

### Patch Changes

- Updated dependencies [ec5ffdb]
  - @neta-art/cohub@4.7.0

## 3.3.1

### Patch Changes

- Updated dependencies [4735eea]
  - @neta-art/cohub@4.6.0

## 3.3.0

### Minor Changes

- 59443a9: Add friendly-first space invite URLs, invitation location metadata, reliable invitation limits and usage tracking, and CLI commands for creating, listing, and revoking invite links.

### Patch Changes

- Updated dependencies [59443a9]
  - @neta-art/cohub@4.5.0

## 3.2.0

### Minor Changes

- f514b5e: Add paginated Space-level Turn listing with author and time boundaries, including CLI access.

### Patch Changes

- Updated dependencies [f514b5e]
  - @neta-art/cohub@4.4.0

## 3.1.6

### Patch Changes

- 651476c: Expose mounted Mod provenance in skill catalog entries and show the source slug in CLI listings.
- Updated dependencies [651476c]
  - @neta-art/cohub@4.3.0

## 3.1.5

### Patch Changes

- Updated dependencies [4e9e994]
- Updated dependencies [22c00f4]
  - @neta-art/cohub@4.2.0

## 3.1.4

### Patch Changes

- Updated dependencies [3a9a51d]
  - @neta-art/cohub@4.1.0

## 3.1.3

### Patch Changes

- Updated dependencies [1fb5002]
  - @neta-art/cohub@4.0.1

## 3.1.2

### Patch Changes

- Updated dependencies [9350706]
- Updated dependencies [9350706]
- Updated dependencies [c1eb8ef]
- Updated dependencies [95ae57d]
- Updated dependencies [b9e6840]
- Updated dependencies [a98f930]
- Updated dependencies [9350706]
- Updated dependencies [ba7d325]
  - @neta-art/cohub@4.0.0

## 3.1.1

### Patch Changes

- 54cd4d0: Move the Board document model, renderers, and image exporters into the Cohub SDK, organised by dependency so each entry only carries what it needs:

  - `@neta-art/cohub/board` — document schema, geometry, shapes, timeline compilation, and export planning. No PixiJS, so it runs on servers, agents, and edge workers.
  - `@neta-art/cohub/board/render` — the PixiJS card renderers, themes, and palette the editor draws with.
  - `@neta-art/cohub/board/export` — rendering a planned export to a canvas in the browser.
  - `@neta-art/cohub/board/headless` — Node.js image export on `@napi-rs/canvas`.

  `pixi.js` and `@napi-rs/canvas` stay optional peers, needed only for the rendering and export entries. Board modules also keep their build boundaries, so consumers tree-shake unused schemas and renderers instead of pulling in the whole model.

- Updated dependencies [54cd4d0]
  - @neta-art/cohub@3.2.0

## 3.1.0

### Minor Changes

- 7140fbe: Add board image export, shared between the web editor and the CLI.

  The board renderers, geometry and codec now live in a new `@neta-art/cohub-board`
  package, so the same PixiJS card renderers draw a board on screen and in a
  headless Node export. `cohub boards export <board> -o out.png` renders a board id
  or `.board` path, with `--frame`, `--items` and `--rect` regions, `--scale`,
  `--theme`, `--background transparent` and PNG/JPEG/WebP output. In the editor,
  Shift+Cmd/Ctrl+E (or the context menu) opens an export dialog that can download
  or copy the image, reusing the live renderer and the current theme.

  Two rendering fixes came out of this: non-Latin text (CJK) rendered as
  missing-glyph boxes because the renderers asked for a Latin-only font with no
  fallback, and shape label colors in the hard-coded fallback palette had drifted
  from the CSS tokens, making note text dark-on-dark wherever the CSS was not
  available.

### Patch Changes

- Updated dependencies [94a8f99]
- Updated dependencies [7140fbe]
- Updated dependencies [b47510a]
- Updated dependencies [7135f11]
- Updated dependencies [fd41a7f]
  - @neta-art/cohub@3.1.0
  - @neta-art/cohub-board@0.2.0

## 3.0.0

### Major Changes

- 760a6ec: Align the CLI with the Board domain rename in `@neta-art/cohub` 3.0.0. The CLI now targets the Board transaction and playback APIs; canvas-era SDK surfaces it depended on are gone.

### Minor Changes

- e5e7060: Add space-scoped Board creation, inspection, transaction, playback, and realtime watch commands with structured JSON input.

### Patch Changes

- Updated dependencies [077ce83]
- Updated dependencies [ac1a3ce]
  - @neta-art/cohub@3.0.0

## 2.7.0

### Minor Changes

- 7dfa1d8: Add optional `thinkingLevel` to session prompts, scheduled prompts, channel model config, and space hooks. The level is fully optional — omitted values inherit the session default, matching existing provider/model behavior. UI, CLI, and SDK all support per-model thinking level selection driven by models config (`reasoning`, `defaultThinkingLevel`, `thinkingLevelMap`). Effective thinking level is persisted to turn meta and exposed on turn records for multi-client recovery.

### Patch Changes

- Updated dependencies [7dfa1d8]
- Updated dependencies [7dfa1d8]
  - @neta-art/cohub@2.15.0

## 2.6.1

### Patch Changes

- dad311e: Recover WebSocket sessions from a transient authentication failure by forcing one access-token refresh, reconnecting once, and restoring room subscriptions without entering an infinite retry loop.
- Updated dependencies [dad311e]
  - @neta-art/cohub@2.14.1

## 2.6.0

### Minor Changes

- f72fa82: Expose structured canvas transaction conflicts and richer published Work metadata through the Cohub SDK and CLI dependency bundle.

  - Export `CanvasTransactionError` with status, code, and `isVersionConflict` so clients can rebase and retry rejected canvas transactions.
  - Add `lang` and `themeColor` to published Work metadata types.

### Patch Changes

- Updated dependencies [f72fa82]
  - @neta-art/cohub@2.14.0

## 2.5.1

### Patch Changes

- Upgrade `@neta-art/generation` dependency to `^0.1.16`.

## 2.5.0

### Minor Changes

- Carry request provenance via `X-Cohub-Source-*` headers for cross-space traceability.

  - **SDK**: `requestSource` on client options (static or per-request getter); transport stamps `X-Cohub-Source-*` automatically; re-export provenance helpers (`readRequestSourceFromEnv`, `requestSourceToHeaders`, `mergeRequestSourceIntoMeta`, …).
  - **CLI**: every request sends `via: cli` and sandbox `COHUB_*` identity when present; drop ad-hoc `meta.source` / `versionMeta` / `meta.cohub` merge on works and generations.
  - **Breaking note**: `WorkCreateInput.versionMeta` removed — publish provenance is taken from request headers instead.

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@2.13.0

## 2.4.0

### Minor Changes

- d21c200: Ship the resource-references graph-edge model and empty-account Home space bootstrap that the API and agent already expose.

  - **feat(references): graph-edge model with agent file access stats** — turn-level sources, file targets, and agent tool file kinds (`agent_tool_file_read|write|edit|ls|find|grep`); drop redundant `participant` edges; `ReferenceRecord` uses `sourceSpaceId` / `sourceSessionId`; aggregate supports `groupBy=target` and `limit`.
  - **feat: auto-create Home space for empty accounts** — `spaces.getDefault()` creates a blank Home space (`slug=home`) when the account has no accessible space.
  - **CLI**: `references query` accepts `turn:<uuid>`; aggregate `--group-by target` / `--limit`; file targets render as short space id + path.

### Patch Changes

- Updated dependencies [d21c200]
  - @neta-art/cohub@2.12.0

## 2.3.3

### Patch Changes

- 1d27866: Stop silent SSO login callback redirect loops by letting bootstrap `getMe` skip the unauthorized handler, and ship Apache-2.0 LICENSE/NOTICE with the published packages.
- Updated dependencies [1d27866]
  - @neta-art/cohub@2.11.2

## 2.3.2

### Patch Changes

- 43b7653: Record optional provenance on work versions via `meta` (CLI auto-fills `source` from COHUB\_\* env).
- Updated dependencies [43b7653]
  - @neta-art/cohub@2.11.1

## 2.3.1

### Patch Changes

- 6c0b75f: Add durable chat attachments that no longer require a session.

  SDK: `publicAssets.uploadChatAttachment()` for any file mime, optional `spaceId`/`sessionId` association only, and space upload `downloadUrl` materialize (skip client PUT when the file is already a durable public asset). `sandbox_tmp` destination `sessionId` is optional; plan entries may omit `uploadUrl`/`objectKey` for remote sources.

  CLI: `spaces prompt --image` works without `--session`; file upload complete skips remote `downloadUrl` entries that the server pulls itself.

- 86e11a7: Expose generation model discount billing details in SDK results and CLI output.
- Updated dependencies [6c0b75f]
- Updated dependencies [86e11a7]
  - @neta-art/cohub@2.11.0

## 2.3.0

### Minor Changes

- a45d3e8: Add referral links, account referral management, and CLI referral commands.

### Patch Changes

- Updated dependencies [a45d3e8]
  - @neta-art/cohub@2.10.0

## 2.2.10

### Patch Changes

- 74a3b9d: Add raw space LLM completions that skip the agent turn queue. Callers fully control message history and an optional space-relative system prompt file.

  SDK: `space.completion()` (JSON) and `space.streamCompletion()` (SSE deltas with abort-safe streaming).
  CLI: `cohub completion` / `cohub spaces completion` with `--stream`, `--system-prompt`, model/provider, temperature, max tokens, and thinking level.

- Updated dependencies [74a3b9d]
  - @neta-art/cohub@2.9.0

## 2.2.9

### Patch Changes

- 10989f6: Record multimodal generation usage against the shared credit balance after successful provider calls. Add `generation.music` usage type, resolve image/video/music kinds for billing gates, and surface post-success `billing` metadata on generation task results.

  Also add hourly generation usage stats (mirroring LLM token rollups) so multimodal usage appears in trending and usage endpoints.

- 9188401: Unify billing gate responses. Every billing-gated 402 (negative balance limit and plan entitlement) now returns a flat `{ code, message, billing: { conversion, status?, netUsd?, hardNegativeLimitUsd? } }` body, and soft debt warnings ride the same `billing` payload on success responses. The SDK adds `BILLING_ACCESS_BLOCKED_ERROR_CODE`, `isBillingAccessBlockedError`, `isBillingAccessBlockedCode`, `extractBillingPayload`, and a `BillingResponsePayload` type so clients extract the conversion intent with one call. Websocket `session.request.error` events now carry the same `billing` payload. The CLI surfaces the conversion title/message on 402.
- Updated dependencies [4c28633]
- Updated dependencies [10989f6]
- Updated dependencies [9188401]
  - @neta-art/cohub@2.8.0

## 2.2.8

### Patch Changes

- Updated dependencies [55eeac2]
  - @neta-art/cohub@2.7.1

## 2.2.7

### Patch Changes

- Updated dependencies [348f62a]
  - @neta-art/cohub@2.7.0

## 2.2.6

### Patch Changes

- Updated dependencies [805d300]
  - @neta-art/cohub@2.6.0

## 2.2.5

### Patch Changes

- Updated dependencies [1fe514d]
  - @neta-art/cohub@2.5.0

## 2.2.4

### Patch Changes

- Updated dependencies [661b5b8]
  - @neta-art/cohub@2.4.0

## 2.2.3

### Patch Changes

- e854b0e: Bump the pinned `sandboxd` binary version to v1.82.4, which includes the local
  sandbox `/workspace` path mapping fix.

## 2.2.2

### Patch Changes

- ce4fc3c: Bump the pinned `sandboxd` binary version to v1.82.2. This is the first
  release whose archives were actually published to the public CDN — the
  `publish-cdn` job had been failing on every tag since the managed-download
  workflow landed, so the previous pin (v1.80.2) 404'd on download. With this
  bump, `sandbox up` resolves a version that exists on the CDN.
- Updated dependencies [ace4b41]
  - @neta-art/cohub@2.3.0

## 2.2.1

### Patch Changes

- 7907e1d: Show buyer profiles on commerce orders and enforce the minimum product price.
- Updated dependencies [7907e1d]
  - @neta-art/cohub@2.2.1

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

### Patch Changes

- Updated dependencies [2a29102]
- Updated dependencies [2a29102]
  - @neta-art/cohub@2.2.0

## 2.1.0

### Minor Changes

- ba31079: Expand CLI commerce support.

  - Replace the compact space commerce commands with explicit product, benefit, bind, unbind, and paginated order subcommands under `cohub spaces commerce`.
  - Add work commerce debugging commands under `cohub works commerce` for product resolution, entitlement checks, checkout creation, and order lookup.

### Patch Changes

- Updated dependencies [5220dc0]
  - @neta-art/cohub@2.1.0

## 2.0.0

### Major Changes

- f853227: Rework work publishing around explicit visibility and version publication.

  SDK breaking changes: remove the `draft` work status and `publishVersion` update flag, add `WorkVisibility` on work create/update records, add `WorksApi.publishVersion()`, and slim `WorkVersionRecord` fields to match the API response.

  CLI breaking changes: remove draft status flags and `cohub works update --publish-version`, replace version publication with `cohub works publish-version`, add work visibility controls, and support role-qualified generation media inputs.

### Patch Changes

- Updated dependencies [f853227]
  - @neta-art/cohub@2.0.0

## 1.20.6

### Patch Changes

- Add Space default resolution and presence APIs, including presence snapshots, websocket presence updates, and `presence.updated` events.
- Updated dependencies
  - @neta-art/cohub@1.34.0

## 1.20.5

### Patch Changes

- Updated dependencies [1caff2c]
  - @neta-art/cohub@1.33.1

## 1.20.4

### Patch Changes

- a8c3181: Release enriched work responses, mod prompt templates, streaming snapshot recovery fixes, and Cohub Ask rendering updates.
- Updated dependencies [a8c3181]
  - @neta-art/cohub@1.33.0

## 1.20.3

### Patch Changes

- 6eee05e: Show Space slugs in CLI output and allow `spaces get` to use the configured target Space.

## 1.20.2

### Patch Changes

- 20a4cc1: Add CLI commands for updating profile usernames and Space slugs.

## 1.20.1

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.32.0

## 1.20.0

### Minor Changes

- 3936634: Add SDK and CLI support for work presentation metadata, including Cohub bar visibility controls, and expose billing feature entitlement checks.

### Patch Changes

- Updated dependencies [3936634]
  - @neta-art/cohub@1.31.0

## 1.19.0

### Minor Changes

- 8455e51: Add `cohub me sessions` (paginated cross-space session list) and `cohub me usage [days]` (aggregated account-level usage summary) commands. Update `--work-scope` / `--viewer-scope` help text with full valid scope values including new user-level scopes.

### Patch Changes

- Updated dependencies [8455e51]
  - @neta-art/cohub@1.30.0

## 1.18.0

### Minor Changes

- 4393131: Add `--env` option to `prompt` and `spaces send` commands for setting per-turn environment variables. Use `--env KEY=value` and repeat for multiple variables.

### Patch Changes

- Updated dependencies [4393131]
- Updated dependencies [4393131]
- Updated dependencies [4393131]
  - @neta-art/cohub@1.29.0

## 1.17.5

### Patch Changes

- Release work management, public asset, and CLI attachment updates.
- Updated dependencies
  - @neta-art/cohub@1.28.2

## 1.17.4

### Patch Changes

- Release checkpoint pagination and work runtime stability fixes.
- Updated dependencies
  - @neta-art/cohub@1.28.1

## 1.17.3

### Patch Changes

- Updated dependencies [e79488b]
- Updated dependencies [e79488b]
  - @neta-art/cohub@1.28.0

## 1.17.2

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.27.1

## 1.17.1

### Patch Changes

- Release the CLI with the latest generation SDK dependency update.

## 1.17.0

### Minor Changes

- 9a523d0: Upgrade `@neta-art/generation` dependency to `^0.1.4`.

### Patch Changes

- Updated dependencies [9a523d0]
- Updated dependencies [9a523d0]
  - @neta-art/cohub@1.27.0

## 1.16.0

### Minor Changes

- Release scheduled job management updates, including SDK support for cron job detail, patch updates, and paginated run listing, plus CLI commands for scheduled job inspection and updates.

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.26.0

## 1.15.2

### Patch Changes

- Publish work sharing and publishing updates.
- Updated dependencies
  - @neta-art/cohub@1.25.2

## 1.15.1

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.25.1

## 1.15.0

### Minor Changes

- Add checkpoint file browsing APIs and CLI support, plus Suno music generation compatibility.

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.25.0

## 1.14.0

### Minor Changes

- Release v1.49.0 with realtime canvas persistence and operation sync, space layout customization, custom space styles, label-scoped search, guest prompt access hardening, loading state refinements, and turn navigator polish.

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.24.0

## 1.13.1

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.23.1

## 1.13.0

### Minor Changes

- Release v1.48.0 with background task controls, billing account expansion, session queue stability, active label highlighting, file preview support, and agent wakeup hardening.

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.23.0

## 1.12.1

### Patch Changes

- Add browser voice input support with Volc ASR, including the new `voice-input` SDK export, realtime WebSocket reuse during idle periods, and related split-view stability fixes.
- Updated dependencies
  - @neta-art/cohub@1.22.0

## 1.12.0

### Minor Changes

- Release label refs in prompts, automatic session source labels, label item management, and CLI label command updates.

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.21.0

## 1.11.1

### Patch Changes

- Release billing balance details, billing plans and redemption flow, and label-based space organization APIs.
- Updated dependencies
  - @neta-art/cohub@1.20.0

## 1.11.0

### Minor Changes

- 2312811: Release Mirror updates with read-only prompt access, shared session visibility improvements, and session participant metadata.

### Patch Changes

- Updated dependencies [2312811]
  - @neta-art/cohub@1.19.0

## 1.10.1

### Patch Changes

- 1ade102: Publish npm packages for the latest release.
- Updated dependencies [1ade102]
  - @neta-art/cohub@1.18.1

## 1.10.0

### Minor Changes

- ce0e5fb: Expose generation policy helpers and metadata propagation for session generation tasks.

  Add CLI-side generation policy enforcement from environment variables and filter model listings accordingly.

### Patch Changes

- Updated dependencies [ce0e5fb]
  - @neta-art/cohub@1.18.0

## 1.9.1

### Patch Changes

- 1f860ba: Clean up legacy realtime turn progress/snapshot events and add session/task lifecycle realtime events.
- Updated dependencies [1f860ba]
  - @neta-art/cohub@1.17.0

## 1.9.0

### Minor Changes

- 884b3d0: feat(cli): improve generation task feedback and output labels; fix fetch failure diagnostics and surface generation provider details; upgrade neta generation to 0.1.2

### Patch Changes

- Updated dependencies [884b3d0]
  - @neta-art/cohub@1.16.1

## 1.8.0

### Minor Changes

- 109cf4d: feat: add multimodal model show command, billing credits integration, and async task refactor

  - Add multimodal model show command for CLI
  - Integrate billing credits support
  - Refactor generations to async tasks
  - Fix CLI auth, space defaults, and JSON output flag
  - Recover from transient unauthorized responses

### Patch Changes

- Updated dependencies [109cf4d]
  - @neta-art/cohub@1.16.0

## 1.7.1

### Patch Changes

- 02519c6: Restore named space mod mounts and sandbox restart metadata in the SDK and CLI.
- Updated dependencies [02519c6]
  - @neta-art/cohub@1.15.1

## 1.7.0

### Minor Changes

- 133275c: Release SDK support for public asset uploads, space slugs, space public profiles, and default space mods.

  Release CLI avatar upload commands for user and space profiles, plus updated space mod management output.

### Patch Changes

- Updated dependencies [133275c]
  - @neta-art/cohub@1.15.0

## 1.6.3

### Patch Changes

- 872b08c: Clear full auth session on 401 responses instead of only the device code, preventing stale tokens from causing repeated auth failures.
- Updated dependencies [872b08c]
  - @neta-art/cohub@1.14.0

## 1.6.2

### Patch Changes

- 8eb954c: Differentiate default sandbox idle TTL by environment (dev: 10m, prod: 12h).

## 1.6.1

### Patch Changes

- fc1dc64: Update sandbox upload materialization types and CLI space handling.
- Updated dependencies [fc1dc64]
  - @neta-art/cohub@1.13.1

## 1.6.0

### Minor Changes

- 48bdf1b: Add SDK and CLI support for usernames, sectioned Explore spaces, space pins, and sandbox lifecycle controls.

### Patch Changes

- Updated dependencies [48bdf1b]
  - @neta-art/cohub@1.13.0

## 1.5.1

### Patch Changes

- Expose space access permissions in the SDK and improve CLI/API error messages.
- Updated dependencies
  - @neta-art/cohub@1.12.0

## 1.5.0

### Minor Changes

- 4eed38f: Add space mod APIs and CLI commands.

### Patch Changes

- Updated dependencies [4eed38f]
  - @neta-art/cohub@1.11.0

## 1.4.2

### Patch Changes

- Updated dependencies [bfe50bf]
  - @neta-art/cohub@1.10.2

## 1.4.1

### Patch Changes

- Updated dependencies [3846078]
  - @neta-art/cohub@1.10.1

## 1.4.0

### Minor Changes

- 78a111b: Publish the latest SDK, CLI, and web updates, including space file upload support, refreshed realtime protocol handling, batch file APIs, command palette and streaming tool call UI improvements, and package build tooling improvements.

### Patch Changes

- Updated dependencies [78a111b]
  - @neta-art/cohub@1.10.0

## 1.3.0

### Minor Changes

- 31f5713: Release updated protocol, SDK, and CLI packages.

  - Rename generation model listing response types to match the `/api/models?modelType=multimodal` API shape.
  - Add SDK helpers for multimodal models and search access.
  - Improve CLI auth flow, search commands, command help, and self-update behavior.

### Patch Changes

- Updated dependencies [31f5713]
  - @neta-art/cohub@1.9.0

## 1.2.0

### Minor Changes

- Add multimodal generation protocol types, SDK APIs, and CLI commands.

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.8.0

## 1.1.4

### Patch Changes

- Updated dependencies [4e62670]
  - @neta-art/cohub@1.7.1

## 1.1.3

### Patch Changes

- Updated dependencies [c53aaec]
  - @neta-art/cohub@1.7.0

## 1.1.2

### Patch Changes

- 341bfc0: Add turn abort/steer reason, continuedByTurnId to turn summary; add turnId/userMessageId to websocket events
- Updated dependencies [341bfc0]
  - @neta-art/cohub@1.6.0

## 1.1.1

### Patch Changes

- Updated dependencies [c469fb2]
  - @neta-art/cohub@1.5.1

## 1.1.0

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
  - @neta-art/cohub@1.5.0

## 1.0.6

### Patch Changes

- Updated dependencies [d5b8d41]
  - @neta-art/cohub@1.4.0

## 1.0.5

### Patch Changes

- Release current package updates.
- Updated dependencies
  - @neta-art/cohub@1.3.1

## 1.0.4

### Patch Changes

- Updated dependencies [f469947]
  - @neta-art/cohub@1.3.0

## 1.0.3

### Patch Changes

- Updated dependencies [a2cb8ff]
  - @neta-art/cohub@1.2.2

## 1.0.2

### Patch Changes

- Updated dependencies [66b4ef8]
  - @neta-art/cohub@1.2.1

## 1.0.1

### Patch Changes

- 0797485: Add environment-aware SDK and CLI defaults for production and development Cohub endpoints, and publish updated protocol filesystem realtime types.
- Updated dependencies [0797485]
  - @neta-art/cohub@1.2.0
