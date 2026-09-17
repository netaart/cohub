# Debug Diagnostics

The mobile client records diagnostic sessions in SQLite by default; the switch in About turns recording off. It keeps the most recent sessions and prunes older ones on the next launch, and it submits one session only when a user sends feedback. It never uploads credentials, message bodies, attachment bytes, image data, or raw Cohub IDs.

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

## Retention and export

A session is one app process lifetime; a relaunch starts a new one and marks the previous session closed when it is next read. The newest `SESSION_RETENTION` sessions are kept and the rest pruned at session start. Export writes every retained session to one JSONL file, newest first: each session contributes one `cohub-diagnostics-v1` header line followed by its events, so a single-session file still parses like before. Feedback sends only the most relevant session: the live one when it captured activity beyond its start markers, otherwise the most recent stored session (typically the frozen session that a relaunch shadowed). The chat scroll trace stays opt-in: it records only while the Scroll Diagnostics screen's Recording switch is on, and its events are written to the current session. Turning recording off deletes every stored session, retained ones included.
