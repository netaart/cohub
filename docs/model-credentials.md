# Model credentials

A provider's credentials and destination form one trust boundary. User model configuration cannot read service environment variables or redirect platform credentials.

## Configuration sources

- Platform: `<platformConfigRoot>/platform/.cohub/models.json`, loaded through `PLATFORM_MODELS_REDIS_KEY`.
- User: `<platformConfigRoot>/users/<userId>/.cohub/models.json`, loaded through `getUserModelsRedisKey(userId)`.

The loader determines the source from these paths and cache keys. A `scope` or `trusted` field in user JSON does not confer platform trust. Access to platform configuration must remain restricted to platform operators; this boundary does not protect a platform file or Redis key already writable by an attacker.

Only a platform `apiKey` can refer to a service environment variable. A user `apiKey` is always literal, even if it happens to be the name of an existing service variable. API and agent runtime loaders resolve platform references before applying user providers; registries never read `process.env`. Session-title and image-to-text tasks follow the same boundary. Reused agent sessions rebind their complete model object whenever runtime identity is refreshed, even when provider and model IDs are unchanged, so an old user endpoint cannot receive credentials from a new platform registry.

`mergeModelsConfigs(platform, ...userConfigs)` replaces an entire provider with the later provider of the same name. Credentials, headers, models, compatibility fields, and extensions remain within their source. Discovery, availability checks, and runtime loading validate each user model's explicit key and adapter. Invalid credentials stop catalog resolution immediately with an error identifying the provider, model, and reason. Valid providers replace same-name platform providers as complete units.

Raw file/cache values stay unresolved. Runtime resolution returns an in-memory copy and does not mutate or republish the cached config. Existing raw Redis cache entries are checked on use, so no cache schema change or flush is required for this fix.

## User provider example

Prefer a distinct provider name to keep platform models available:

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

User models require an explicit, non-empty API key. Endpoints that do not use authentication can provide an explicit non-secret placeholder; omitting the key must not trigger SDK fallback to service credentials. Header-only configurations also need a placeholder key, and their adapter must support the intended header behavior.

User configuration supports `anthropic-messages`, `azure-openai-responses`, `google-generative-ai`, `mistral-conversations`, `openai-codex-responses`, `openai-completions`, `openai-responses`, and `pi-messages`. Cloud adapters with ambient credentials, including Bedrock and Vertex, are platform-only. Selecting an existing platform catalog model for a task remains allowed, with its platform destination fixed.

## Migration

This intentionally changes unsafe inheritance behavior:

1. Replace user `apiKey` environment references with the user's own literal key. Do not copy a platform key into user configuration.
2. Replace partial same-name provider overrides with a complete user provider: API, URL, key and models. A different provider name avoids shadowing the platform catalog.
3. For [model tasks](model-tasks.md), repeat both `provider` and `id` when replacing `model`. Prompt-only changes need no migration. To change the transport, select a user-owned provider instead of changing a platform model's connection fields.
4. Upgrade API, agent and worker together with the shared infra package. An old replica still has the vulnerable interpretation; an infra-only partial rollout is not sufficient. In-flight agent sessions/old processes must be drained or restarted before considering the old interpretation gone.

This fix closes configuration-driven environment resolution and credential inheritance. It does not rotate previously exposed credentials, remediate writable shared storage, or implement a general SSRF/redirect policy for custom model endpoints. Those require their own changes. After the entry point is closed, affected platform credentials still need separate revocation/rotation.

## Local regression coverage

`packages/infra/src/config-runtime/models.test.ts` covers platform resolution, user literals, complete provider replacement, credential errors with provider/model context, valid user and platform cloud adapters, and cache immutability. `model-tasks.test.ts` covers both auxiliary tasks, transport rejection, prompt-only inheritance, standalone user credentials, isolation from unused catalog entries, final-model credential validation, and file/cache parity using temporary files and in-memory Redis.

API completion and agent registry tests exercise the final credential consumers. The agent request-context regression switches a reused session from a user provider to a same-ID platform provider and checks the next request's URL, headers, and key. Existing provider request snapshots still resolve their trusted fixture through the platform boundary; they must keep the same outbound request shape when run with the repository dependencies installed. Unit tests prohibit network connections.
