---
"@neta-art/cohub-cli": minor
---

`cohub generate --3d [motion=]<path-or-url>` sends 3D model and motion inputs; local files upload to an unlisted public URL like other media, and `-o` saves 3D outputs. A 3D input URL from one of your generations in the last 3 days carries that task's provider meta, so Meshy `animation` and `text-to-3d-refine` work from the previous step's output URL; the CLI rejects a local file for them. Failed generations now name provider failures such as "Generation provider returned no output" with the gateway's message and request ID, and a single provider request that returned no output, an upstream failure, or a 5xx is retried once.
