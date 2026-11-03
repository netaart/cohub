---
"@neta-art/cohub-cli": minor
"@neta-art/cohub": minor
---

Large, lively Boards stay smooth. Videos on screen get the decoders first, so looping videos elsewhere on the Board no longer freeze the ones in view. Off screen, a script that only moves or draws its own item steps four times a second, with the same state as before. Items a script walks across the Board stay live while they move, so they no longer repaint the cards around them or replan what is drawn, and moves and fades skip schema validation. A wide blur renders at the density it keeps, about half the cost. A shader pass whose picture changes only every few units takes `texel` and shades once per texel, so pixel maps cost the same at any zoom. Scripts import `.json` data `with { type: "json" }`, shared and frozen across instances instead of parsed by each. `boards profile` suggests `texel` for heavy full-box passes and names models too large for phones.

Hosts: no action.
