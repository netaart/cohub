---
"@neta-art/cohub": patch
---

Fix `boards/:boardId/apply` returning 500: the bounds-only batch update interpolated a raw `Date` into a drizzle `sql` template, where raw `execute` does not serialize by column type. Convert it to an ISO string cast to `timestamptz` to match the column.
