# Model tasks

Platform and user configuration can define auxiliary model tasks in `.cohub/model-tasks.json`.

```json
{
  "sessionTitle": {
    "enabled": true,
    "model": {
      "provider": "cohub",
      "id": "title-model"
    },
    "prompt": "Write a concise session title in the user's language that captures the main topic. Return only the title."
  },
  "imageToText": {
    "enabled": true,
    "model": {
      "provider": "cohub",
      "id": "vision-model"
    },
    "prompt": "Describe the image accurately and concisely."
  }
}
```

A task model resolves `provider` and `id` from a model catalog. The `imageToText` model must support image input. Set a task's `enabled` field to `false` to disable it.

Platform tasks resolve against the platform catalog only. A user can change a task's `prompt` or `enabled` without changing its platform model, even when the user's catalog contains a provider with the same name.

When a user supplies `model`, it replaces the entire platform task model and must specify both `provider` and `id`. It does not inherit platform task credentials, headers, transport settings, or model overrides. For a selected platform provider, parameter-only overrides in the user's `models.json` merge into the catalog first, then the task's parameters apply. The provider's platform connection remains intact (see [Model credentials](model-credentials.md)).

For a platform catalog provider, user tasks may select the model and override `name`, `reasoning`, `defaultThinkingLevel`, `thinkingLevelMap`, `hidden`, `input`, `cost`, `contextWindow`, and `maxTokens`. Cost and thinking-level maps merge their supplied entries. Tasks and ordinary chat share the allowed parameter fields. They cannot override its `api`, `baseUrl`, `apiKey`, `headers`, `compat`, `requestProfile`, `imageUrlInput`, or unknown extension fields. The `cohub` provider is reserved: a user task must select one of its configured platform models. Define a separate user provider to use a different connection.

For a user provider, task model fields can override that user's catalog entry, including supplying the task's own literal key when the catalog provider has none. Only the selected final model is checked for usable credentials; unused catalog entries do not disable tasks. A standalone user task requires a complete model (`provider`, `id`, `api`, `baseUrl`) and an explicit literal `apiKey`. User models use API-key-based adapters; ambient cloud credentials are reserved for platform configuration.

Only platform configuration can resolve `apiKey` from a service environment variable. The loader resolves platform references in memory after reading the raw cache; image-to-text and session-title execution consume the resulting literal credentials. Resolved values must not be written to config files, Redis config caches, discovery responses, or logs.
