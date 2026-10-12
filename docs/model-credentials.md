# Model credentials

A provider's credentials and destination form one trust boundary. User model configuration cannot read service environment variables or redirect platform credentials.

## Configuration sources

- Platform: `<platformConfigRoot>/platform/.cohub/models.json`, loaded through `PLATFORM_MODELS_REDIS_KEY`.
- User: `<platformConfigRoot>/users/<userId>/.cohub/models.json`, loaded through `getUserModelsRedisKey(userId)`.

The loader determines the source from these paths and cache keys. A `scope` or `trusted` field in user JSON does not confer platform trust. Access to platform configuration must remain restricted to platform operators; this boundary does not protect a platform file or Redis key already writable by an attacker.

Only a platform `apiKey` can refer to a service environment variable. Custom user connection keys are always literal, even when they name an existing service variable. Redundant connection declarations for `cohub` are compared with the raw platform configuration before resolving credentials. After validation, runtime loaders apply only user model parameters and resolve the platform-owned key; registries never read `process.env`. Session-title and image-to-text tasks follow the same boundary. Reused agent sessions rebind their complete model object whenever runtime identity is refreshed, even when provider and model IDs are unchanged, so an old user endpoint cannot receive credentials from a new platform registry.

`mergeModelsConfigs(platform, ...userConfigs)` merges platform model parameters by model ID. A parameter-only provider contains just `models`; each entry selects an existing model and overrides allowed parameters. Unmentioned models and connection fields remain intact. A provider other than `cohub` that supplies connection settings is a complete user-owned provider and requires its own credentials. Discovery, availability checks, and runtime loading apply the same rules and report invalid entries with their provider, model, and field or reason.

The name `cohub` is reserved for platform connections. Users may adjust parameters of its existing models and repeat matching connection declarations for compatibility with full catalog copies. Changed connection settings, unknown extensions and new model IDs are rejected. Custom connections must use a different provider name.

Raw file/cache values stay unresolved. Runtime resolution returns an in-memory copy and does not mutate or republish the cached config. Existing raw Redis cache entries are checked on use, so no cache schema change or flush is required for this fix.

## Model parameter overrides

To change one platform model's context window, put only its ID and the changed parameter in the user's `.cohub/models.json`:

```json
{
  "providers": {
    "cohub": {
      "models": [
        { "id": "claude-sonnet-5", "contextWindow": 200000 }
      ]
    }
  }
}
```

This keeps the platform model's API, destination, key, headers, and remaining parameters. Every other platform model stays available. No user key is required for parameter-only overrides, including for platform cloud models.

Allowed fields are `id`, `name`, `reasoning`, `defaultThinkingLevel`, `thinkingLevelMap`, `hidden`, `input`, `contextWindow`, and `maxTokens`. `thinkingLevelMap` merges its supplied entries; arrays such as `input` replace the previous array. Explicit `false` and thinking-level `null` values are preserved. An empty `models` list leaves the catalog intact.

`cost` defines actual per-token prices used by the SDK to calculate usage charges, including raw completion billing. Platform prices always come from trusted platform configuration. A user may omit `cost` or repeat the complete matching platform price object for compatibility; the repeated value is discarded and the platform value retained. Any changed price, including zero prices or partial price overrides in auxiliary tasks, is rejected. User-owned connections may define their own prices.

Connection declarations (`api`, `baseUrl`, `apiKey`, `headers`, `compat`, `requestProfile`, `imageUrlInput`) may repeat platform values. Provider fields must match the raw provider declaration. Model fields are checked against their effective platform connection, including model-specific API/URL overrides and merged headers. Object property order is ignored; nested values must match. Unknown extensions and model IDs are rejected. Accepted connection declarations are discarded from the user override so the resulting connection always comes from the platform.

For example, a user `cohub` entry with the platform URL and `apiKey: "NEW_API_KEY"` is accepted when those declarations match the platform. Changing either the provider URL or a model URL is rejected even when the key alias matches. Changing headers or nested compatibility settings is also rejected. Key equality uses the raw alias, never the resolved service secret; errors identify only the field and configuration entry.

The same model parameter rules apply to other existing providers. Their complete user-owned replacements require explicit credentials and inherit no platform connection settings or models. A custom provider with `apiKey: "NEW_API_KEY"` sends that literal string.

## User provider example

Use a separate name for a custom connection:

```json
{
  "providers": {
    "my-provider": {
      "api": "openai-completions",
      "baseUrl": "https://models.example.test/v1",
      "apiKey": "user-owned-literal-key",
      "models": [{ "id": "my-model" }]
    }
  }
}
```

Custom user connections require an explicit, non-empty API key. Endpoints that do not use authentication can provide an explicit non-secret placeholder; omitting the key must not trigger SDK fallback to service credentials. Header-only configurations also need a placeholder key, and their adapter must support the intended header behavior.

User configuration supports `anthropic-messages`, `azure-openai-responses`, `google-generative-ai`, `mistral-conversations`, `openai-codex-responses`, `openai-completions`, `openai-responses`, and `pi-messages`. Cloud adapters with ambient credentials, including Bedrock and Vertex, are platform-only. Selecting an existing platform catalog model for a task remains allowed, with its platform destination fixed.

## Migration

This intentionally changes unsafe inheritance behavior:

1. Replace custom user connection `apiKey` environment references with the user's own literal key. A matching `cohub` platform key declaration may remain as a redundant declaration. Do not copy a platform secret into user configuration.
2. Existing `cohub` catalog copies remain valid when all connection declarations and prices match the platform and every model ID exists. Allowed parameters may differ. For custom connections, use a provider name other than `cohub` and supply API, URL, key and models. A distinct name keeps platform models available.
3. For [model tasks](model-tasks.md), repeat both `provider` and `id` when replacing `model`. Prompt-only changes need no migration. To change the transport, select a user-owned provider instead of changing a platform model's connection fields.
4. Upgrade API, agent and worker together with the shared infra package. An old replica still has the vulnerable interpretation; an infra-only partial rollout is not sufficient. In-flight agent sessions/old processes must be drained or restarted before considering the old interpretation gone.

This fix closes configuration-driven environment resolution and credential inheritance. It does not rotate previously exposed credentials, remediate writable shared storage, or implement a general SSRF/redirect policy for custom model endpoints. Those require their own changes. After the entry point is closed, affected platform credentials still need separate revocation/rotation.

## Local regression coverage

`packages/infra/src/config-runtime/models.test.ts` covers platform resolution, user literals, custom provider replacement, credential errors with provider/model context, valid user and platform cloud adapters, and cache immutability. `model-parameters.test.ts` covers parameter merging, nested values, retained sibling models, reserved provider restrictions, cache parity, and auxiliary-task selection. `model-connection-compatibility.test.ts` covers full catalog copies, inherited connection declarations, raw key comparison, provider/model/task redirection rejection, nested connection changes, literal custom keys, and cache parity. `model-tasks.test.ts` covers both auxiliary tasks, transport rejection, prompt-only inheritance, standalone user credentials, isolation from unused catalog entries, final-model credential validation, and file/cache parity using temporary files and in-memory Redis.

API completion and agent registry tests exercise the final credential consumers. Pricing tests cover catalog/cache/task rejection of changed platform prices, matching legacy declarations, user-owned prices, and Pi SDK `calculateCost` using platform prices after parameter overrides. The agent request-context regression switches a reused session from a user provider to a same-ID platform provider and checks the next request's URL, headers, and key. Existing provider request snapshots still resolve their trusted fixture through the platform boundary; they must keep the same outbound request shape when run with the repository dependencies installed. Unit tests prohibit network connections.
