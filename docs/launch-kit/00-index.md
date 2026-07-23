# Nova Solana AI Sniper — Public Launch Kit (index)

Everything in this folder is new; nothing in the application source was
touched. Files:

| File                               | What it is                                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `01-content-package.md`            | Branding, tagline, short/long descriptions, feature list, how-it-works, security/risk disclosure, SEO title/description |
| `02-public-readme.md`              | Public-safe README/FAQ — does not expose the private source repo                                                        |
| `03-listing-descriptions.md`       | Copy adapted to each target platform's actual field structure/limits                                                    |
| `04-brand-assets.md`               | What was generated vs. what needs an external image tool, + ready prompts, + screenshot requirements                    |
| `05-public-presence-audit.md`      | Verified inventory of existing public presence (bot/website/social/GitHub) and the gaps                                 |
| `06-directory-submission-guide.md` | Per-platform eligibility, requirements, and the final tracking table                                                    |
| `landing-page.html`                | Published artifact — usable as the "official website" for listings                                                      |
| `brand-assets.html`                | Published artifact — exportable logo/wordmark/banner sheet                                                              |

## Verified facts this whole kit is built from

- 960/960 automated tests passing, full workspace build clean (verified
  2026-07-22, this session)
- Fixed profit split: 80% trader / 10% L1 referrer / 5% L2 referrer / 5%
  platform, on realized profit only (`packages/shared/src/fee.ts`)
- Live Telegram bot: `@Solanxaxsniper_bot`
- GitHub repo confirmed **private** (`gh repo view` → `isPrivate: true`) —
  not linked anywhere in this kit
- No public website, no official X/Twitter account, no audit report exist
  today — none of these are claimed or faked anywhere in this kit

## What's genuinely ready vs. what needs you

**Ready to use as-is:** all written copy, the landing page, the brand asset
sheet.

**Needs your action before anything goes live externally:**

1. Decide where to host `landing-page.html` (or just share the artifact
   link) so directories that require a website have one to point to.
2. Create an X/Twitter account if you want one (required to log into the
   Solana Ecosystem Directory specifically, and useful generally) — I
   cannot create this on your behalf.
3. Take the real screenshots described in `04-brand-assets.md` from your
   own test account — I did not touch the live bot/dashboard to do this.
4. Actually submit to each directory in `06-directory-submission-guide.md`
   — every one requires your login/CAPTCHA/email verification/ToS
   acceptance, which I cannot complete for you.

**Nothing has been published or submitted externally yet.** This is the
approval checkpoint: review the package, tell me if you want any copy,
branding, or the disclaimer language changed, and then work through the
per-platform actions in `06-directory-submission-guide.md` at your own
pace — I'm glad to keep helping at each step (e.g. reviewing what a
directory shows back to you before you hit submit).
