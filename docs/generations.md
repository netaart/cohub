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

`content` contains the prompt and any reference media:

```ts
type GenerationSource =
  | { type: "url"; url: string }
  | { type: "base64"; mediaType: string; data: string };

type GenerationContentBlock =
  | { type: "text"; text: string; meta?: Record<string, unknown> }
  | { type: "image"; source: GenerationSource; meta?: Record<string, unknown> }
  | { type: "video"; source: GenerationSource; meta?: Record<string, unknown> }
  | { type: "audio"; source: GenerationSource; meta?: Record<string, unknown> };
```

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
2. **Post-success charge** — after a successful provider call, the worker applies the request-time model discount snapshot to the official provider `cost` (USD), then attempts to record the effective charge amount:

```ts
operationId: `generation:${taskRunId}`  // idempotent
usageType: "generation.image" | "generation.video" | "generation.music" | "generation"
officialCostUsd: result.cost
amountUsd: officialCostUsd * discountMultiplier
```

The server resolves `pro_model_discount_v1` and `max_model_discount_v1` entitlements from billing benefit metadata. Eligible models are the metadata keys themselves (for example `metadata["gpt-image-2"] = 0.6`); there is no code allowlist. A benefit without the requested model key is ignored for that request. If both supported benefits apply to the same model, the lower multiplier wins. The resolved multiplier is snapshotted before enqueue, verified against authoritative entitlements by the worker, and reused by any billing retry. If the applicable multiplier changes while a task is queued, the worker fails before provider execution and the caller can retry at the new price. Benefit and grant identifiers are retained only in internal logs. Pricing snapshots and billing amounts are visible only to the task creator; collaborator task views redact them because the multiplier can reveal subscription tier.

A zero multiplier is a valid free generation: both balance gates are bypassed, no zero-value ledger transaction is created, and the task records `billing.reason = "discounted_free"`. Present but invalid pricing configuration fails before provider execution instead of silently charging full price.

Usage type is resolved from the model adapter (preferred) or output content types. Missing/non-positive provider `cost` skips charging and stores `billing.status = "skipped"` with reason `missing_cost` (task still succeeds — cost gaps are platform issues and must not break the user path; they are logged for ops follow-up). Transient billing write failures still complete the generation task, then enqueue an idempotent `generation.billing_retry` job (`operationId = generation:${taskRunId}`, up to 8 attempts with exponential backoff). Retries preserve the original official cost, multiplier, and effective amount.

Completed tasks may include:

```ts
billing?: {
  officialCostUsd?: number;
  amountUsd: number;
  discountMultiplier?: number;
  usageType: string;
  status: "recorded" | "overage" | "skipped";
  reason?: string | null;
} | null
```

`GenerationTaskResult.cost` and usage statistics continue to report the official provider cost. `billing.amountUsd` is the effective charge amount after the plan discount; `billing.status` indicates whether that amount was recorded, treated as overage, or skipped.

### Discount rollout safety

API and worker deployments roll independently. Release discount support in three phases:

1. Deploy the task-response privacy filters first and wait for the API rollout to complete. This prevents collaborator-visible task endpoints from exposing pricing when the worker starts applying discounts.
2. Deploy the backward-compatible worker and shared billing/protocol changes. It resolves discounts for legacy API payloads that do not contain a snapshot. Wait for both user and system worker rollouts to complete.
3. Deploy the generation API route that snapshots pricing and bypasses the balance gate for free models.

Do not deploy the API activation before all workers understand discount snapshots: an older worker would ignore the new field and charge official cost. To roll back, revert the API activation first and let accepted generation jobs drain; keeping the privacy filters and backward-compatible worker is safe.

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
