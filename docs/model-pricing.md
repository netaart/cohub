# Model pricing

Platform model prices are configured in `.cohub/models.json`. Rates are USD per one million tokens. A model's `cost` contains `input`, `output`, and optional `cacheRead` and `cacheWrite` rates. Omitted cache rates are zero.

`cost.tiers` defines prices for larger requests. Every tier supplies all four rates and a unique, nonnegative integer `inputTokensAbove`. Pi selects the highest threshold strictly below the request's total input tokens, including cache reads and cache writes. The selected rates apply to the entire request, including output. Array order does not affect selection.

The same prices apply to agent conversations, completions, and auxiliary model tasks. User overrides cannot change platform model prices or their tiers. Model collections refresh when rates or prompt-cache lifetimes change.

## GPT-6.2

Official sources checked on November 18, 2026:

- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
- [GPT-6.2 Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra)
- [GPT-6.2 Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol)

Standard rates:

| Model | Input | Output | Cache read | 30-minute cache write |
| --- | ---: | ---: | ---: | ---: |
| GPT-6.2 Astra | $8 | $40 | $0.40 | $10 |
| GPT-6.2 Sol | $2 | $10 | $0.10 | $2.50 |

For requests with more than 272,000 input tokens, input and cache rates double, and output rates increase by 50%. A request with exactly 272,000 input tokens uses the short-context rates.

The following model entries use Responses, a 1,050,000-token context window, a 128,000-token output limit, and the 30-minute prompt cache. Add them to the existing platform provider's `models` array, retaining that provider's connection configuration.

```json
[
  {
    "id": "gpt-6.2-astra",
    "name": "gpt-6.2-astra",
    "api": "openai-responses",
    "reasoning": true,
    "defaultThinkingLevel": "medium",
    "thinkingLevelMap": { "off": null, "minimal": null, "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": "max" },
    "input": ["text", "image"],
    "contextWindow": 1050000,
    "maxTokens": 128000,
    "promptCache": { "short": 1800 },
    "cost": {
      "input": 8,
      "output": 40,
      "cacheRead": 0.4,
      "cacheWrite": 10,
      "tiers": [{ "inputTokensAbove": 272000, "input": 16, "output": 60, "cacheRead": 0.8, "cacheWrite": 20 }]
    }
  },
  {
    "id": "gpt-6.2-sol",
    "name": "gpt-6.2-sol",
    "api": "openai-responses",
    "reasoning": true,
    "defaultThinkingLevel": "medium",
    "thinkingLevelMap": { "off": null, "minimal": null, "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": "max" },
    "input": ["text", "image"],
    "contextWindow": 1050000,
    "maxTokens": 128000,
    "promptCache": { "short": 1800 },
    "cost": {
      "input": 2,
      "output": 10,
      "cacheRead": 0.1,
      "cacheWrite": 2.5,
      "tiers": [{ "inputTokensAbove": 272000, "input": 4, "output": 15, "cacheRead": 0.2, "cacheWrite": 5 }]
    }
  }
]
```

Astra and Sol reject reasoning effort `none`; integrations should also avoid `minimal`. Tool calling uses Responses. Twelve-hour cache writes and service tiers such as Fast, Batch, and Ultrafast have separate official prices; these entries declare Standard pricing with the short prompt cache.
