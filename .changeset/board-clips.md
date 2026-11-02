---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Boards edit video. Any item can be a clip on a timeline: `visible` (new, animatable) shows it only for a span, and video, audio and nested animations play through their `props.time` or `time` track. Video and audio play on the canvas and sound while their time moves forward; `props.volume` (new) fades them. The timeline shows clips as bars to drag, trim and split, takes items dragged from the canvas or files dropped on it, and cuts or inserts time. `cohub boards place` prints a patch that lays clips end to end, and video exports draw each video's frame at its time and mix the sound of every playing clip with its speed and volume; audio that no track plays is no longer mixed in. The SDK adds `boardPlaceTarget`, `boardTrimTarget`, `boardSplitTarget`, `boardInsertTime`, `boardRemoveTime`, `boardMediaSpans` and `BoardStage.media`.

Hosts: no action.
