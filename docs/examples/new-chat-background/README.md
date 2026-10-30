# New Chat background

Declare what fills an empty New Chat in a Space with `ui.newChat.background` in
`.cohub/space.json`. It shows until the first message is sent, behind the
composer, for every member. Changes apply live.

| Field      | Values                                    | Meaning                                                |
| ---------- | ----------------------------------------- | ------------------------------------------------------ |
| `url`      | URL or Space path                         | What to show; see the types below.                     |
| `type`     | `board` \| `html` \| `image` \| `video`   | Inferred: a `.board` path is a Board, otherwise `html`. |
| `fit`      | `cover` \| `contain` \| `fill`            | Image and video only; default `cover`.                 |
| `position` | CSS `object-position`                     | Image and video only; default `center`.                |
| `opacity`  | `0`–`1`                                   | Default `1`.                                           |
| `enabled`  | `false`                                   | Turns it off without deleting it.                      |

- **Board**: a Space `.board` path. It opens as it would in a Board window,
  live and editable. A launch hash picks where it opens: `#focus=<id>`,
  `#view=<x>,<y>,<zoom>` or `#play=<animation>`.
- **HTML**: an `https://` URL, a published App URL, or a Space file path.
- **Image / video**: an `https://` URL, drawn with `fit` and `position`.

In the web app, *Use as new chat background* in a Board window's ⋯ menu sets or
clears the Board background and leaves the rest of the file as written.
