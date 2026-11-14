# Speech

Chat replies can be read aloud. The audio is rendered once per reply and voice, stored on the turn, and shared by every viewer with that voice.

## Configuration

A voice is set in `.cohub/speech.json`. The file has the same shape at three levels:

| Level | Location |
| --- | --- |
| Space | `.cohub/speech.json` in the Space |
| User | `.cohub/speech.json` in the user's Home Space |
| Platform | `.cohub/speech.json` in the platform Space |

```json
{
  "tts": {
    "model": "qwen-audio-3.1-tts-flash",
    "meta": { "voice_prompt": "A calm, clear narrator with a warm tone" },
    "parameters": { "instructions": "Speak at a relaxed pace." }
  }
}
```

`tts` is a [generation](generations.md) request without its text: `model` is a speech model from `GET /api/models?modelType=multimodal`, and `meta` and `parameters` are validated against that model's declaration. `references` lists `https` recordings to clone a voice from; each becomes an `audio` input block.

The first level that defines `tts` wins as a whole: Space, then user, then platform. Levels are never merged, because voice fields are specific to each model. Without a voice at any level, the read-aloud button is hidden. A missing or invalid file is treated as no voice at that level. A Space that is still preparing returns 503 rather than falling back to another level.

User and platform files take effect once their Home Space or platform Space is saved and published. Space files apply as soon as they are written.

## API

```http
POST /api/sessions/:sessionId/turns/:turnId/speech
```

Requires `session.view` and `generation.create`. Returns `{ speech: TurnSpeech }` for the caller's voice. Its segments are stored at `turn.meta.speech[voice]` and pushed with `session.turn.updated`. Members with different voices each get their own entry and never overwrite one another.

```ts
type TurnSpeech = {
  voice: string; // hash of the voice configuration
  segments: Array<{ taskId: string; status: "pending" | "completed" | "failed"; url?: string }>;
};
```

Only a completed agent turn's final reply is spoken. Code blocks, links, URLs and Markdown markup are dropped. Text over 6,000 characters is cut at a sentence boundary. The text is split into segments. The first is short so playback can start early; later ones hold up to about 480 characters.

The call is idempotent:

- Stored segments for the voice are returned as they are.
- Failed segments are rendered again. So are pending segments whose task finished without settling them, or never started within a minute.

Concurrent callers race on a compare-and-swap of `turn.meta.speech[voice]`, so a reply is rendered at most once per voice.

Each segment is a `generation.speech` task in the turn's Session: a generation that `data.speech` ties to its turn segment. The task follows the Session's access rules; its separate type keeps it out of generation feeds and Session stats. The caller is billed like any generation. When the task ends, the worker records the audio URL, or the failure, on that segment and publishes the turn. A segment whose task no longer matches is left untouched.

| Error | Status |
| --- | --- |
| `turn_not_speakable` | 409: not a completed agent reply, or nothing to read |
| `speech_unavailable` | 404: no voice configured |
| `speech_config_preparing` | 503: the Space is still preparing |
| `invalid_generation_input`, `generation_model_not_found` | 400 / 404: the voice does not fit its model |
| billing | 402: standard conversion payload |

`GET /api/spaces/:id/startup` reports the caller's `speechVoice` (or null). Clients cache it to show the button, and to play stored audio of that voice with no request. When the voice config cannot be read, the field is left out and clients keep their cached value.

## Clients

- Web: the speaker button under a reply plays the segments in order and starts as soon as the first is ready. One reply plays at a time.
- SDK: `client.space(spaceId).session(sessionId).turn(turnId).speak()`.
- CLI: `cohub spaces sessions turns speak <sessionId> <turnId>` waits for the audio and prints its URLs. Pass `--no-wait` to return at once. The exit code is 1 unless every segment completed.
