# Public Presence Audit

Verified by inspecting the repository, `.env`/`.env.example`, and (for
GitHub) `gh repo view` — not assumed.

| Surface                  | Status                 | Detail                                                                                                                                                                                                                                         |
| ------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Telegram bot**         | ✅ Exists, live        | [@Solanxaxsniper_bot](https://t.me/Solanxaxsniper_bot) — referenced in live notification/caption code (`apps/telegram-bot/src/cards/captions.ts`). This is your primary, ready-to-use public entry point.                                      |
| **Telegram channel**     | ❌ None found          | No announcement/community channel referenced anywhere in the codebase or config.                                                                                                                                                               |
| **X / Twitter**          | ❌ None found          | `TWITTER_*` env vars exist, but they configure the platform's own _monitoring_ of other people's tweets (for token-trend signals) — not an official project account. No handle found anywhere.                                                 |
| **Website**              | ❌ None deployed       | `DASHBOARD_URL` in `.env` is `http://localhost:5173` — a local dev URL, not a public deployment. No domain is referenced anywhere in the repo.                                                                                                 |
| **GitHub / public repo** | ⚠️ Exists, but private | `github.com/Rezamoradifar/nova-solana-ai-sniper` — confirmed **private**, license Proprietary/UNLICENSED (`gh repo view` → `"isPrivate": true`). Per your instructions this stays private; no listing in this package links to it.             |
| **Documentation**        | ⚠️ Internal only       | Extensive `README.md`/`ARCHITECTURE.md`/investor deck exist, but they live inside the private repo and describe internals not meant for a public audience. `docs/launch-kit/02-public-readme.md` (this package) is the public-safe substitute. |

## What this means for listings

- Every directory that **requires a website** needs the landing page from
  this package deployed somewhere public before you submit (see
  `06-directory-submission-guide.md` for exactly which ones).
- Every directory that **requires or benefits from a social account**
  (X/Twitter is the common one) has no existing handle to point to. You'll
  need to create one yourself — I have no ability to create external
  accounts on your behalf, and doing so requires an email/phone you control
  plus CAPTCHA/ToS acceptance only you can complete.
- No public GitHub link is used anywhere in this package, per your
  instruction not to expose the private repository.

## Recommended (optional) additions before or during launch

- Create an official **X/Twitter account** (e.g. `@NovaSniperAI` or similar,
  subject to availability) — most directories treat a live, active social
  account as a trust signal, and several submission forms have an optional
  X-handle field.
- Consider a Telegram **announcement channel** separate from the bot itself,
  if you want a place for release notes/status updates distinct from the
  bot's own interactive UI.
