# Decisions

Decision models answer structured questions about text, a JSON object, or images with calibrated probabilities. The request follows the OpenRouter Decisions shape.

## API

```http
POST /api/spaces/:id/decisions
```

Requires `session.prompt.readonly` on the Space.

```ts
type CreateSpaceDecisionInput = {
  provider?: string | null;
  model?: string | null;
  state: string | Record<string, unknown> | Array<string | { type: "image_url"; image_url: string | { url: string } }>;
  questions: Record<string, DecisionQuestion>; // at most 200
};

type DecisionQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> } // at least 2
  | { type: "score"; instructions: string; criteria: string[] };              // at least 2

type SpaceDecisionResult = {
  decisionId: string;
  provider: string;
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: Usage; // cost.total is the upstream-reported charge
};
```

Without `model`, selection follows catalog order like LLM completions: use the first visible model, or the first configured model if all are hidden. With `provider`, apply the same rule within that provider. An explicit model ID may select a hidden model. Put the preferred default first in the catalog; image capability does not change the order.

Images arrive as URLs. The API downloads `https` images with the safe remote fetcher and sends images upstream as data URLs. For Jev, local CLI attachments, remote URLs and inline data use PNG or JPEG with a maximum edge of 1568 pixels. Images smaller than 256 pixels per side or 78400 pixels total after fitting are rejected. Other models keep the shared image normalizer for remote URLs and pass inline data URLs through unchanged. Image counts are checked against the model's `maxImages` before any upstream call.

The SDK exposes `space.decision()`; the CLI exposes `cohub decision` and `cohub spaces decision`.

## Configuration

Platform and user configuration live in `.cohub/decisions.json`. Decision models are kept out of `models.json` so they never appear in LLM pickers or `GET /api/models`. See [`examples/decisions.json`](examples/decisions.json).

```json
{
  "providers": {
    "cohub": {
      "baseUrl": "https://router.neta.art/openrouter",
      "apiKey": "PLATFORM_ENV_NAME",
      "models": [
        { "id": "openai/gpt-6-luna-decisions", "name": "Luna", "input": ["text", "image"], "maxImages": 128 },
        { "id": "jev-latest", "name": "Jev", "input": ["text", "image"] }
      ]
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `baseUrl` | Upstream base. Requests go to `<baseUrl>/api/alpha/decisions`. |
| `apiKey` | Platform-only. Resolved from a service environment variable like `models.json`. |
| `headers` | Optional extra request headers. |
| `models[].input` | `["text"]` by default. Include `"image"` for image-capable models. |
| `models[].maxImages` | Image cap for image-capable models, 1–200. Defaults to 200. |
| `models[].hidden` | Skipped for default selection while a visible model is available. |

Saving the platform Space or a user's Home Space publishes the file to Redis (`configs:decisions:v1:*`), like other config caches. A provider without `baseUrl` or `apiKey` is skipped. With no usable model the endpoint returns 503 `decisions_unavailable`, so an environment without the file has the feature off.

User configuration may only change `name` and `hidden` of platform models. Connection fields are rejected and models of other providers are ignored, because billing follows the cost the upstream reports.

## Upstream calls

Each call sends the platform key and `x-litellm-track-extra` with `user_uuid`, `cohub_space_uuid`, and `cohub_decision_id`. Transport failures, timeouts, and 5xx responses retry once; 4xx and client aborts do not.

| Upstream | Response |
| --- | --- |
| 400 | 400 `invalid_decision_request` with the upstream message |
| 401, 403, 404, 503 | 503 `decisions_unavailable`; details stay in the archive |
| Other failures | 502 `decision_failed` |

Every call is archived to `spaces/<spaceId>/decisions/<yyyy>/<mm>/<dd>/<decisionId>.json` with the caller request and each upstream attempt's status and body.

## Billing

Decisions are the one model call billed at the cost the upstream reports, not catalog prices. The catalog has no `cost` field.

1. The usage gate checks the balance before the call (`llm.decision`, fail-open like completions).
2. After success, `usage.cost` is recorded once as `generation.decision` with `operationId: decision:<decisionId>`.
3. A missing or non-positive cost skips the charge and logs a warning; the response is still returned.
4. Failed and aborted calls are not charged.
