# Directory Submission Guide

Researched live (WebSearch/WebFetch) on 2026-07-22 against each platform's
actual current submission process. **I did not create any external
accounts or submit any forms** — every one of these requires at least one
of: login, wallet signature, CAPTCHA, email verification, or Terms
acceptance, all of which need to be done by you personally (per your own
instruction to stop at that exact step, and because I have no credentials
for any of these services).

A structural note on eligibility: most of these directories were originally
built to track **non-custodial, on-chain dApps** with a deployed smart
contract they can pull on-chain metrics from (unique wallets, volume,
transactions). Nova Solana AI Sniper is a **custodial, off-chain Telegram
bot** that routes trades through _existing_ Solana DEX programs (via
Jupiter) — it does not deploy its own on-chain program. This does not
disqualify it (DappRadar already lists comparable products — e.g. "Sigma
Trading Bot", "BotPad" — as trading-bot dapps without their own contract),
but expect "smart contract address" fields to be left blank/N/A, and don't
fabricate one.

---

### 1. DappRadar

- **URL:** https://dappradar.com/submit-a-project
- **Eligibility:** Yes — DappRadar already lists other custodial Solana
  trading bots in a comparable category.
- **Requires:** DappRadar account login, then a form (name, category,
  chain, description, logo, screenshots, website; contract address
  optional/blank here).
- **Cost:** Free.
- **What I prepared:** category recommendation, short + long description,
  in `03-listing-descriptions.md`.
- **Your action:** log in (or create an account), fill the form with the
  prepared copy, upload the logo/banner from the artifact, submit for
  DappRadar's review.

### 2. Alchemy Dapp Store

- **URL:** https://www.alchemy.com/dapps (intake form linked from their
  "Submit" flow) — contact `dappstore@alchemy.com` if no self-serve form is
  visible.
- **Eligibility:** Plausible — the store covers "dapps and developer tools"
  broadly, not exclusively on-chain-contract projects, but listings are
  **editorially written/reviewed by Alchemy**, not fully self-serve.
- **Requires:** submitting the intake form; Alchemy's team writes the final
  copy themselves from what you give them.
- **Cost:** Free.
- **What I prepared:** the "what does your dapp do" short answer and
  category in `03-listing-descriptions.md`.
- **Your action:** fill and submit the intake form (or email the address
  above if the form isn't visible when you check), attach the logo.

### 3. Solana Ecosystem Directory (solana.com/ecosystem)

- **URL:** https://solana.com/ecosystem → "Submit Project"
- **Eligibility:** Yes — open, community-submitted directory, broad
  category set including AI/Developer Tools.
- **Requires:** **log in with your X/Twitter account**, then a 3-field form
  (Project, Tagline, Website).
- **Cost:** Free.
- **What I prepared:** exact Project/Tagline/Website values in
  `03-listing-descriptions.md`.
- **Your action:** you'll need an X/Twitter account to log in (see the gap
  noted in `05-public-presence-audit.md`) — this is a hard blocker on this
  one specific directory until you have one. Then submit.

### 4. solanaecosystem.com (community directory)

- **URL:** https://www.solanaecosystem.com/ → "Submit a Project" (Airtable
  form)
- **Eligibility:** Yes — general Solana tools directory, "AI" and "DeFi"
  categories both plausible fits.
- **Requires:** filling the Airtable form (name, tagline, category, link,
  logo).
- **Cost:** Free.
- **Your action:** open the Airtable form, paste the prepared copy, submit.

### 5. Telegram bot directories

- **Examples:** various community-run Telegram bot directories/catalogs.
- **Eligibility:** Yes — this is literally a Telegram bot.
- **Requires:** varies by directory; typically a form with bot
  username + description, sometimes requiring you to add their verification
  bot as an admin of a test group, or email verification.
- **Cost:** Free (watch for any that ask for payment — skip those per your
  instruction not to pay for listings).
- **What I prepared:** bot name/description in `03-listing-descriptions.md`.
- **Your action:** pick specific directories you trust, check their current
  form, and submit — I did not enumerate every such site since quality and
  legitimacy vary widely and change quickly; vet each one for how long
  it's been operating and whether it asks for anything beyond a
  description/link before you submit.

### 6. Product Hunt (optional, general audience — not Solana-specific)

- **URL:** https://www.producthunt.com/
- **Eligibility:** Uncertain/discretionary — no explicit ban on trading
  bots found, but Product Hunt's audience and moderation lean toward
  consumer/dev tools rather than custodial financial products. Given this
  platform holds user funds, weigh reputational risk before listing here;
  I'd treat this as optional, not core to the "Solana ecosystem directory"
  ask.
- **Requires:** Product Hunt account, a "maker" post with tagline,
  description, gallery images/GIF, and a specific launch-day timing
  strategy if you want visibility.
- **Cost:** Free.
- **Your action:** your call whether to include this one at all.

---

## What I recommend you skip

- Any directory or "listing service" that **asks for payment** to list or
  to "boost" a listing — you asked me not to pay for anything, and
  reputable directories (all of the above) list for free.
- Any "directory" you can't independently verify is a real, currently
  operating, reputable site — several Telegram-bot "directories" that show
  up in casual search results are low-quality/abandoned; I did not
  recommend specific ones by name for that reason.

---

## Final tracking table

Fill this in as you complete each submission — every row starts "Not
submitted" because no submission has been made on your behalf.

| Platform                   | Status        | Submission URL                         | Submission/Reference ID | Date | Required Next Action                                                 |
| -------------------------- | ------------- | -------------------------------------- | ----------------------- | ---- | -------------------------------------------------------------------- |
| DappRadar                  | Not submitted | https://dappradar.com/submit-a-project | —                       | —    | Log in, fill form with prepared copy, upload logo, submit for review |
| Alchemy Dapp Store         | Not submitted | https://www.alchemy.com/dapps          | —                       | —    | Submit intake form or email dappstore@alchemy.com                    |
| Solana Ecosystem Directory | Not submitted | https://solana.com/ecosystem           | —                       | —    | Requires X/Twitter login — create account first, then submit         |
| solanaecosystem.com        | Not submitted | https://www.solanaecosystem.com/       | —                       | —    | Fill Airtable submission form                                        |
| Telegram bot directories   | Not submitted | (platform-specific)                    | —                       | —    | Choose specific directories, verify legitimacy, submit               |
| Product Hunt (optional)    | Not submitted | https://www.producthunt.com/           | —                       | —    | Decide whether to include; if yes, create maker account and post     |
