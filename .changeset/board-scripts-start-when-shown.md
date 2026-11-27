---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Scripts without setup, `shader` or `bend` can only draw their own box, so they start once it shows: exports and profiles skip them outside the exported view, and an opening Board starts them after the view in sight has drawn. Exports draw scripts at the output's resolution rather than up to twice it, sharper at 1:1 and cheaper when scaled down.
