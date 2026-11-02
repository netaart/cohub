---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Apps can be liked. `client.user.likes.isLiked("app", id)` and `client.user.likes.set("app", id, liked)` read and set the viewer's like, which is stored as their `Liked` label; App details carry the public `likeCount`, and App stats add `summary.totalLikes`. `LabelResourceType` gains `app`. The CLI adds `cohub apps like <app>` and `cohub apps unlike <app>`, and `apps get` and `apps stats` show likes.
