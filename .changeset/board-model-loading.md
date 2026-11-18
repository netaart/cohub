---
"@neta-art/cohub": minor
---

Board model objects load each file once for every item that shows it, up to three at a time nearest the view first, and stand as a soft silhouette (or their recorded cover) over their contact shadow until the model fades in, never as a white card. Model objects now fade with their opacity. Scripts hear `model:loaded` once a model object stands, also in exports and simulations, and play or read-only views hold `auto` animations and the script clock up to 1.5 s for the model objects in view, with `ctx.env.ready` reporting when they start. `loadBoardObjectModels` shares one parse among the items of a file.
