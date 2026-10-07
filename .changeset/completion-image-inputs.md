---
"@neta-art/cohub": minor
---

`completion()` and `streamCompletion()` messages accept plain-string `content` and the OpenAI Chat (`image_url`) and Responses (`input_image`) image parts alongside Cohub content blocks. Image URLs reach the model as-is.

`completion()` 和 `streamCompletion()` 的消息支持字符串形式的 `content`，以及 OpenAI Chat（`image_url`）和 Responses（`input_image`）图片格式，与 Cohub 内容块并列使用。图片 URL 会原样交给模型。
