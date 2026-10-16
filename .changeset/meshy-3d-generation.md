---
"@neta-art/cohub": patch
"@neta-art/cohub-cli": patch
---

Generations support 3D results and models with operations. Task views report each 3D output with its `format` and its task's still; Board task cards for 3D results show the still and open the model in place, and their results lay out as model file items with `metadata.origin`. `boardModelTarget` names the model a Board item opens, and `boardItemOrigin` reads origins from file items.

`cohub generate` takes `--3d` model inputs, `--block` content blocks for passing an earlier result back with its `meta`, roles a model declares, and no prompt when other content is present. `cohub models show` prints array parameters and each operation's inputs and parameters, and `models ls` shows the model category.
