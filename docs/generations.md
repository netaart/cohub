# Generations

Cohub generations provide a small task-based multimodal generation API. Model declarations are loaded from `.cohub/generations` and use the `@neta-art/generation` declaration schema.

## API

```http
GET  /api/models?modelType=multimodal
POST /api/generations
```

`POST /api/generations` accepts:

```ts
type CreateGenerationTaskRequest = {
  spaceId: string;
  model: string;
  content: GenerationContentBlock[];
  parameters?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};
```

`content` contains the prompt and any reference media or 3D models:

```ts
type GenerationSource =
  | { type: "url"; url: string }
  | { type: "base64"; mediaType: string; data: string };

type GenerationContentBlock =
  | { type: "text"; text: string; meta?: Record<string, unknown> }
  | { type: "image"; source: GenerationSource; meta?: Record<string, unknown> }
  | { type: "video"; source: GenerationSource; meta?: Record<string, unknown> }
  | { type: "audio"; source: GenerationSource; meta?: Record<string, unknown> }
  | { type: "3d"; source: GenerationSource; meta?: Record<string, unknown> };
```

`3d` blocks carry 3D asset files such as GLB, OBJ or FBX models. 3D models (for example `meshy`, adapter `meshy.tasks`) return them as output, and operations such as retexture and remesh take them as input; pass an output block back unchanged so the provider can reuse its task from `meta.task_id`. A `3d` URL input without `meta.task_id` that matches a `3d` output URL of the same user's completed generations from the last 3 days gets that output's `meta` on submission, so operations that only take a task (Meshy `animation`, `text-to-3d-refine`) also work from the bare URL (`cohub generate --3d <url>`). Local model files upload as generation inputs (`publicAssets.uploadGenerationInput`) when they are GLB, glTF, OBJ, FBX or STL and `filename` ends with the format's extension. Providers read the format from the URL extension, so the upload keeps the extension and stores the file with that extension's type (`model/gltf-binary`, `model/gltf+json`, `model/obj`, `model/stl`, or `application/octet-stream` for FBX); the client may send that type or `application/octet-stream`.

The API queues a generation task and returns a task ID. Use task polling, or the SDK / CLI helpers, to wait for the final `GenerationTaskResult`:

```ts
type GenerationTaskResult = {
  model: string;
  output: GenerationContentBlock[];
  /** Provider response `request_id` from `@neta-art/generation` */
  requestId?: string;
  /** Official request price from provider `usage.cost` */
  cost?: number;
  meta?: Record<string, unknown>;
};
```

`requestId` and `cost` are observed provider fields captured via `generateResult()`. Older completed tasks may omit them.

`meta` is model-owned input and is validated against the model declaration. Cohub request provenance and task context are stored separately and are never forwarded to generation providers.

## Billing

Generation requests share the platform credit balance with LLM turns.

1. **Preflight gate** — `POST /api/generations` and the worker re-check the caller's balance before enqueue/execute. Video generation requires at least `$1.01`; a lower balance returns the standard 402 `billing` conversion payload before the provider is called. Other paid generations require a positive balance. Video balance lookup failures fail closed with a temporary-unavailable error.
2. **Admission pricing** — before enqueue the API prices the request with the [pricing rules](billing-pricing.md) and per-model benefit discounts, draws any quota the rules grant (for example daily video seconds, counted from the request's `duration`), and admits only the uncovered remainder against the balance or reserve hold. The resulting `pricing` snapshot (a multiplier for each payer plus quota units covered of requested) travels in the task payload; a task whose admission fails, whose enqueue fails, or whose queued turn is cancelled returns its quota.
3. **Post-success charge** — after a successful provider call, the worker charges the official provider `cost` (USD) scaled by the snapshot:

```ts
operationId: `generation:${taskRunId}`  // idempotent
usageType: "generation.image" | "generation.video" | "generation.audio" | "generation.3d" | "generation.decision" | "generation"
officialCostUsd: result.cost
amountUsd: officialCostUsd * multiplier * (requested - covered) / requested
```

Queued tasks keep the price they were admitted at: the worker does not re-price, so turning a rule off only affects new requests. A personal benefit that makes a request free (a zero multiplier or full quota coverage) is never routed to a Space wallet; otherwise a wallet pays its own price, which ignores benefit-based discounts. Pricing snapshots, quota coverage, and billing amounts are visible only to the task creator; collaborator task views redact them because they can reveal subscription tier.

A zero multiplier is a valid free generation: both balance gates are bypassed, no zero-value ledger transaction is created, and the task records `billing.reason = "discounted_free"`. Invalid benefit discount metadata fails admission instead of silently charging full price.

Usage type comes only from the declaration's `category` (`image`, `video`, `audio`, `3d`, `decision`), so the API gate, worker gate, and post-success charge always agree; an uncategorized model bills as generic `generation` and the declaration loaders log a warning naming it. Every video model must declare `category: video` to get the video balance gate. Ledger rows written before `generation.audio` keep the legacy `generation.music` type. Missing/non-positive provider `cost` skips charging and stores `billing.status = "skipped"` with reason `missing_cost` (task still succeeds — cost gaps are platform issues and must not break the user path; they are logged for ops follow-up). Transient billing write failures still complete the generation task, then enqueue an idempotent `generation.billing_retry` job (`operationId = generation:${taskRunId}`, up to 8 attempts with exponential backoff). Retries preserve the original official cost, multiplier, and effective amount.

Completed tasks may include:

```ts
billing?: {
  officialCostUsd?: number;
  amountUsd: number;
  discountMultiplier?: number; // after quota coverage
  quota?: { tokenType: string; requested: number; covered: number } | null;
  usageType: string;
  status: "recorded" | "overage" | "skipped";
  reason?: string | null;
} | null
```

`GenerationTaskResult.cost` and usage statistics continue to report the official provider cost. `billing.amountUsd` is the effective charge amount; `billing.status` indicates whether that amount was recorded, treated as overage, or skipped.

### Pricing rollout safety

API and worker deployments roll independently. Deploy the worker (and shared billing/protocol packages) before the API: the worker reads both the new `pricing` snapshot and the legacy `modelDiscount` field, while an older worker would ignore `pricing` and charge without quota coverage. To roll back, revert the API first and let accepted generation jobs drain.

## Usage stats

Successful provider calls upsert into `v2.generation_usage_stats_hourly` (space / user / session / usageType / adapter / model / hour). Idempotency peeks Redis before write and commits the key only after a successful DB upsert, so a failed write can retry. Dimension columns are NOT NULL with sentinels. The `provider` column stores the **adapter type** (e.g. `openai.images`). Stats are success-only (`errorCount` stays 0 by design).

Gate resolves modality from request content; billing/stats re-resolve after success using output content (preferred) then request content.

These rollups feed:

- Generation trending (`/api/trending/generations/{spaces,users,models}`) — ranked by request count, then cost
- Space / user usage endpoints as an optional `generation` block alongside token stats

LLM trending (`/api/trending/{spaces,users,models}`) remains token-only and is still ranked by tokens.

## Declarations

Generation declarations live in:

```txt
.cohub/generations/*.yaml
```

Platform declarations are loaded from `platform/.cohub/generations`, and user declarations from `users/<userId>/.cohub/generations`. User declarations override platform declarations with the same `model`.

Declarations use `neta.generation.model.v1`. Adapter credentials and provider base URLs are not stored in model declarations. Worker execution uses `GENERATION_API_KEY`. An optional worker-level `GENERATION_BASE_URL` is passed to `@neta-art/generation`; when it is unset, Cohub omits the option and lets the Generation SDK select its own default.

Worker requests to the generation gateway carry `X-Cohub-Task-Id: <taskRunId>` for correlation with Cohub tasks, billing, and usage statistics. Submission, polling, and retries share the same task ID; this header is not an idempotency key. Injection is limited to the configured gateway origin and base path (the SDK's current default is `https://router.neta.art`). Tagged requests reject automatic redirects to prevent leaking the header to another destination. External media requests are not tagged.

Minimal shape:

```yaml
schema: neta.generation.model.v1
model: gpt-image-2
title: GPT Image 2
description: Image generation with optional reference images.

adapter:
  type: openai.images

content:
  input:
    - type: text
      required: true
      min: 1
      merge: newline
    - type: image
      max: 16
      sources: [url, base64]

parameters:
  size:
    type: string
    optional: true
    default: 1024x1024
  quality:
    type: string
    optional: true
    default: auto
    enum: [auto, low, medium, high]
```

Set `hidden: true` on a declaration to exclude the model from default Web and CLI discovery. Hidden models remain available through exact-ID search, `cohub models show <model>`, direct generation requests, and explicit Limited policies. The models API and SDK continue to return the complete catalog with the `hidden` field, so this is a discovery hint rather than an authorization or runtime availability control.

See the full examples:

- [`docs/examples/generations/gpt-image-2.yaml`](./examples/generations/gpt-image-2.yaml)
- [`docs/examples/generations/gemini-3.1-flash-image-preview.yaml`](./examples/generations/gemini-3.1-flash-image-preview.yaml)
- [`docs/examples/generations/seedance-2-0-fast.yaml`](./examples/generations/seedance-2-0-fast.yaml)
- [`docs/examples/generations/seedance-2-0.yaml`](./examples/generations/seedance-2-0.yaml)
- [`docs/examples/generations/seedance-2-5.yaml`](./examples/generations/seedance-2-5.yaml)
- [`docs/examples/generations/suno_music.yaml`](./examples/generations/suno_music.yaml)

## Generation reserve holds

Expensive models can require their reserve to fit the payer's balance before the
task is enqueued. A hold is a submission-time defense, not a charge: the task is
still charged once after success through the regular path, so the actual cost
is what the user pays. Only models listed in the platform config are affected.

Config path: `<platformConfigRoot>/platform/.cohub/billing/generation-reserves.yaml`

```yaml
schema: cohub.generation.billing.v1
models:
  seedance-2-0:
    reserveUsd: 5.70   # $0.38/s × 15s
  seedance-2-0-fast:
    reserveUsd: 1.95   # $0.13/s × 15s
  seedance-2-5:
    reserveUsd: 17.10  # $0.57/s × 30s
```

See [`docs/examples/generation-billing-reserves.yaml`](./examples/generation-billing-reserves.yaml).
`reserveUsd` is the list price before the user's model discount.

Behavior:

- Holds live in Redis, one hash per payer. A Lua script admits a hold only if the
  payer's balance covers it on top of their live holds, so concurrent submissions
  cannot oversubscribe the balance. The Space wallet is tried first when usable.
- Insufficient balance rejects with 402 (reserve, available, shortfall) before the
  task is enqueued.
- Success charges the actual cost and releases the hold; failure, cancellation of
  a queued turn, or an enqueue failure release it too.
- A hold expires after five minutes, so a hold a crashed worker never released
  cannot block the payer for long. Tasks running longer stop being counted, which
  may let a later submission overdraw the balance. Expiry or Redis data loss never
  moves money; it only stops counting that amount for new submissions. If Redis is
  unavailable, submissions fall back to the regular usage gate.
- Models absent from the config keep the existing path. An invalid config is
  logged and the last valid one stays in effect; it never blocks other models.

Troubleshooting: every step logs under `[GenerationReserve]` with `taskRunId`,
payer, and USD amounts — `held` (balance and other live holds), `blocked`
(available and shortfall), `released` (`reason`, `found`), `kept until the billing
retry charges`, plus warnings when Redis is unavailable or a release fails. Live
holds of a payer are in the Redis hash `generation:reserve-holds:<personal|space_wallet>:<payerId>`
(`HGETALL`; each value is `<amount in 1e-8 USD>|<expiresAtMs>`).

## CLI

```bash
cohub models ls --model-type multimodal

cohub generate "a cyberpunk cat in neon rain" \
  --model gpt-image-2 \
  --param size=1024x1024 \
  --param quality=high

cohub generate "a ceramic cup isolated on a transparent background" \
  --model gpt-image-2 \
  --param background=transparent \
  --param output_format=png

cohub generate "same character, smiling" \
  --model gpt-image-2 \
  --image ./character.png \
  --param quality=high \
  --json

cohub generate "a vibrant infographic explaining photosynthesis" \
  --model gemini-3.1-flash-image-preview \
  --param aspect_ratio=16:9 \
  --param image_size=1K

cohub generate "a cat playing piano in a cozy jazz club" \
  --model seedance-2-0-fast \
  --param duration=5 \
  --param resolution=720p

cohub generate "smoothly transition from the first frame to the last frame" \
  --model seedance-2-0-fast \
  --image first_frame=https://example.com/first.png \
  --image last_frame=https://example.com/last.png \
  --param duration=5

cohub generate "keep the character identity from all reference images" \
  --model seedance-2-0-fast \
  --image reference_image=https://example.com/reference-1.png \
  --image reference_image=https://example.com/reference-2.png \
  --param duration=5

cohub generate "Lip-sync to this spoken take" \
  --model seedance-2-0-fast \
  --image reference_image=https://example.com/portrait.png \
  --audio reference_audio=https://example.com/speech.mp3 \
  --param duration=8 \
  --param ratio=9:16

cohub generate "uplifting cinematic pop with warm piano and clear chorus" \
  --model suno_music \
  --param operation=music \
  --meta '{"title":"Warm Horizon","tags":"cinematic pop, warm piano","make_instrumental":false}'

cohub generate "write a hopeful chorus about sunrise after a storm" \
  --model suno_music \
  --param operation=lyrics
```

Role-qualified media values add `meta.role` to that content block. Repeat `--image reference_image=...` for multiple reference images. Seedance role-qualified media should use public URL inputs. Do not mix first/last frame roles with reference roles (`reference_image`, `reference_video`, `reference_audio`) in one request. Seedance 2 reference audio is additive to image or video; audio-only is rejected.

Platform `.cohub/generations` YAML is what the API/worker validate against (`includeBuiltinModels: false`). Copy the Seedance examples above onto the live PVC if you want reference audio accepted in production.
