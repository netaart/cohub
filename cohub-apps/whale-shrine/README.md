# 課金殿 — The Whale Shrine

A Cohub App that turns $5 payments into gacha-style echo summons. Pay-to-win,
pay-to-shout, pay-to-feel-important. The more you spend, the higher your whale
rank — from Passerby NPC all the way to 👑 Whale King.

## Concept

A shrine where whales offer tribute to summon their echoes (messages) into the
void. Each $5 offering produces one echo on the wall and contributes to your
cumulative **課力** (kakin power). The top 5 spenders are crowned on the
Hall of Whales leaderboard with escalating gacha rarities:

| Rank | Rarity | Title |
|------|--------|-------|
| #1 | 👑 LR | Whale King |
| #2 | 🐉 UR | Whale Emperor |
| #3 | ⚔️ SSR | Pay-to-Win Hero |
| #4 | ⚓ SR | Veteran Admiral |
| #5 | ✨ R | Rookie Summoner |
| — | 👤 N | Passerby NPC |

## How it works

```
Viewer clicks "Burn $5 to Summon"
  │
  ├─ getEntitlements()          check credit balance
  ├─ purchase()                 $5 credit pack if balance is 0 → checkout redirect
  ├─ consumeCredits(1)          burn 1 credit (idempotent via shout id)
  ├─ auth.authorize(fullaccess) viewer consents to shell execution (incremental grant)
  ├─ space.prompt("!node …")    direct shell command — no LLM, deterministic
  │     └─ post-shout.mjs       validates + appends to shouts.jsonl (idempotent)
  ├─ poll files.read()          wait until the new echo appears
  └─ summon animation           gacha card flip + rarity reveal
```

The `!` prefix makes Cohub run the prompt text as a **direct shell command** —
no LLM interpretation, fully deterministic. The script is idempotent (duplicate
shout IDs are silently skipped), so retries are safe. The viewer's identity
comes from `context.viewer.userUuid`, so each echo is attributed correctly
without decoding the session token manually.

## File structure

```
cohub-apps/whale-shrine/
├─ index.html              App entry point (no-build)
├─ styles.css              Shrine gacha theme
├─ app.js                  Commerce + prompt + polling + animations
├─ post-shout.mjs          Shell script (!-called) — committed
├─ data/
│  └─ shouts.jsonl         Append-only shout data — gitignored
├─ README.md
└─ commerce-setup.sh
```

## Local preview

```bash
cd cohub-apps/whale-shrine
python3 -m http.server 8080
# open http://localhost:8080
```

In preview mode the page shows local `data/shouts.jsonl` content and a banner
explaining that summoning requires a published App. Commerce, auth, and prompt
calls only function inside a published Cohub App iframe.

## Publish as a Cohub App

1. Upload these files to your Space (root or a subdirectory).
2. If using a subdirectory, update `CONFIG.DATA_PATH` and `CONFIG.SCRIPT_PATH`
   in `app.js` to match (e.g. `cohub-apps/whale-shrine/data/shouts.jsonl`).
3. Open the directory preview and click **Publish**. (Or publish from the CLI: `cohub -s <space-id> apps publish whale-shrine --dir cohub-apps/whale-shrine --app-scope file.view` — `--dir` takes the path inside the Space workspace, so upload the folder first with `cohub -s <space-id> spaces files upload <dir>`.)
4. Under **App can**, select `file.view` — the direct read access the app needs for its own Space.
5. Run the commerce setup (below) to create the $5 credit product.

Prompt access (`session.prompt.fullaccess`) is not configured at publish time: the
viewer grants it per Space through the consent dialog the first time they summon
(`auth.authorize()` inside `app.js`, targeting the Space the App runs in). Grants
last 14 days and can be revoked any time:

```bash
cohub -s <space-id> apps grants whale-shrine
cohub -s <space-id> apps revoke whale-shrine <grantId>
```

## Commerce setup

```bash
bash commerce-setup.sh
```

Or manually:

```bash
cohub -s <space-id> spaces commerce setup

cohub -s <space-id> spaces commerce benefits create \
  --type credits \
  --name "Whale Offering" \
  --amount 1

cohub -s <space-id> spaces commerce products create \
  --name "Burn One Offering" \
  --amount-usd 5 \
  --visibility public \
  --status active

cohub -s <space-id> spaces commerce bind \
  --product-key burn_one_offering \
  --benefit-key whale_offering
```

Then set `CONFIG.PRODUCT_KEY = "burn_one_offering"` in `app.js` if it differs.

## Data management (CLI)

```bash
# Read all echoes
cohub -s <space-id> spaces files cat data/shouts.jsonl

# Initialize empty file
cohub -s <space-id> spaces files write data/shouts.jsonl -c ""

# List files
cohub -s <space-id> spaces files ls data/
```

## Data format

`data/shouts.jsonl` — one JSON object per line (append-only):

```json
{"id":"uuid","ts":"ISO-8601","userId":"cohub-userUuid","name":"WhaleBoss","amountUsd":5,"message":"All hail the gacha"}
```

The leaderboard and rarity tiers are derived from this file — no redundant
state is stored. The append-only format is crash-safe and recoverable.

## Tech

- No build step — vanilla HTML/CSS/JS module
- [Cohub SDK](https://esm.sh/@neta-art/cohub) via ESM CDN import
- [anime.js](https://animejs.com) for summon animations
- [Cinzel](https://fonts.google.com/specimen/Cinzel) display font
- CSS `@property` for animated LR rainbow borders
