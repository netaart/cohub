# Message queue

Messages sent while an Agent turn is running wait in the Chat queue as follow-ups. Each time the Agent is free, the queued follow-ups are claimed for the next turn. The sender's Home Space decides whether they are claimed together or one by one.

Create `.cohub/agent.json` in the Home Space:

```json
{
  "version": 1,
  "followupDelivery": "one_by_one"
}
```

| Field | Values | Default |
|---|---|---|
| `version` | `1` | Required |
| `followupDelivery` | `together`, `one_by_one` | `together` |

- `together` merges every queued follow-up into one turn. The Agent reads them all at once and answers them in one run. Follow-ups that exceed the message count or byte budget of one turn wait for the next claim.
- `one_by_one` runs each queued follow-up as its own turn, in the order they were sent. The next follow-up starts after the previous turn finishes.

The config belongs to the user who sent the follow-up. The earliest queued follow-up decides the delivery mode for the claim. Steer messages always run on their own and are not affected by this setting.

A steer jumps the queue without cutting off work in progress. The running Turn finishes its in-flight tool calls, then stops before its next model request, and the steer runs next with those tool results in context. If the running Turn ends without another model request, it completes normally and the steer runs right after. Turns on a local Harness stop at once. Stop still interrupts everything immediately.

A missing Home Space or a missing `.cohub/agent.json` uses `together`. The file must be a regular file inside the Home Space workspace and at most 4096 bytes; a symlink that points outside the workspace or to a missing target is rejected. An invalid file (unknown version, unknown `followupDelivery` value, unknown field, or a rejected path or size) makes the claim throw, so the queued follow-ups stay queued. After the file is fixed, they start at the next claim, which runs when a new message is sent or the previous turn ends.
