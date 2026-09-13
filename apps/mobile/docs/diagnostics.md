# Debug Diagnostics

The mobile client records an opt-in diagnostic session in SQLite and submits it only when a user sends feedback. It never uploads credentials, message bodies, attachment bytes, image data, or raw Cohub IDs.

## Ingest contract

The client expects the configured diagnostics origin to provide:

```text
GET  /health
POST /v1/feedback
```

`POST /v1/feedback` accepts JSON with this shape:

```json
{
  "feedbackId": "feedback-...",
  "description": "The bubble overlaps the turn marker.",
  "includeSession": true,
  "includeConversation": false,
  "session": {
    "id": "debug-...",
    "startedAt": "2026-09-13T12:00:00.000Z",
    "events": [
      {
        "sessionId": "debug-...",
        "sequence": 1,
        "timestamp": "2026-09-13T12:00:00.000Z",
        "name": "chat.send.pressed",
        "payload": "{\"attachmentCount\":0}"
      }
    ]
  },
  "app": {
    "version": "2.2.2",
    "platform": "android",
    "osVersion": "36",
    "updateId": null
  }
}
```

The successful response must be JSON with a non-empty string id:

```json
{ "id": "FB-2026-00042" }
```

The endpoint should enforce HTTPS, a request size limit, rate limiting, and a short retention period. The mobile app does not include a write secret because mobile bundle secrets are extractable.

## SQLite schema

A collector can persist one feedback and its events with:

```sql
CREATE TABLE feedback (
  id TEXT PRIMARY KEY NOT NULL,
  description TEXT NOT NULL,
  session_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  app_version TEXT,
  platform TEXT NOT NULL,
  os_version TEXT,
  update_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE feedback_events (
  feedback_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  name TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (feedback_id, sequence),
  FOREIGN KEY (feedback_id) REFERENCES feedback(id) ON DELETE CASCADE
);

CREATE INDEX feedback_created_at ON feedback(created_at);
CREATE INDEX feedback_events_name ON feedback_events(name);
```

The server should reject unknown oversized fields, strip credentials and raw content fields as a second line of defence, and expire records automatically.

## Event rules

Use namespaced events such as:

```text
app.foregrounded
app.backgrounded
chat.send.pressed
chat.send.optimistic_bubble_layout
chat.send_transition.source_measured
chat.send_transition.target_measured
chat.queue.state
```

Geometry fields may include composer, bubble, marker, keyboard, and scroll frames. Message and turn identifiers must be recording-local aliases. Event payloads must not contain message text, assistant output, file paths, image bytes, access tokens, or authorization headers.

## Local verification

The client can be tested without a network by enabling diagnostics, exercising a flow, and inspecting the `debug_sessions` and `debug_events` tables in `cohub-mobile.db`. Upload failures must not affect chat sending or navigation.
