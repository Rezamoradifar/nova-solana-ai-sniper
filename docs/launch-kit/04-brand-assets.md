# Brand Assets

## What I could actually produce vs. what needs an external tool

**I do not have an image-generation tool in this environment** — I cannot
render a PNG/JPG illustration, photo-real mockup, or app-icon file directly.
What I _can_ do, and have done:

- A real, usable **vector logo + OG/banner image**, built as SVG/HTML (see
  the published artifact — link provided separately in this conversation).
  SVG scales losslessly to any size (favicon through billboard) and every
  major directory accepts SVG or a PNG exported from it. You can export a
  PNG at any resolution by opening the artifact and taking a screenshot, or
  by opening the raw SVG in any browser/design tool (Figma, Inkscape,
  even Chrome's "Print to PDF") and exporting.
- A complete **landing page** (also published as an artifact) using the same
  logo/palette — usable as the "official website" for every listing that
  requires one.

What I could **not** do, and where you'd need an external image generator
(Midjourney, DALL·E, Ideogram, Stable Diffusion, or a designer) if you want
a more illustrated/stylized mark than the geometric SVG version:

- A fully illustrated, non-geometric logo (e.g. a mascot or 3D render)
- Photographic-style app screenshots/mockups (phone-in-hand renders, etc.)
- Any image requiring a raster generative model

### Ready-to-use prompts for an external image generator

**Logo (square, transparent background):**

> Minimalist geometric logo mark for a Solana blockchain trading bot called
> "Nova Sniper AI". A crosshair/target motif fused with a radiating
> star/nova burst, rendered in a gradient from violet (#9945FF) to teal
> green (#14F195) on a transparent or near-black (#0B0E14) background. Flat
> vector style, sharp edges, no text, no photorealism, no mascot/character,
> centered composition, suitable as an app icon at small sizes.

**Banner / OG cover image (1200×630, and a 1500×500 wide variant for social
headers):**

> Dark near-black (#0B0E14) tech background with a subtle radial glow in a
> violet-to-teal gradient (#9945FF → #14F195), abstract circuit/network
> line pattern faintly visible, large clean sans-serif wordmark space
> reserved on the left third for "Nova Solana AI Sniper", a crosshair/nova
> icon on the right third, flat vector/UI style, no photorealism, no stock
> crypto clichés (no rockets to the moon, no piles of coins).

**App-store-style icon variant (rounded square, 512×512):**

> Same crosshair/nova-burst mark as the logo prompt, on a solid dark
> (#0B0E14) rounded-square background, centered with generous padding,
> flat vector style, no text.

## Screenshot requirements

**Hard rule: never use real production data.** Screenshots must not expose
any real user's Telegram ID, wallet address, balance, position, or PnL —
per this project's own data-handling standard and to avoid ever publishing
another user's information. Two acceptable ways to get compliant
screenshots:

1. Use your own admin/test account, funded with a small amount of your own
   SOL, in a throwaway or clearly-labeled test position — no other user's
   data on screen.
2. Take screenshots of empty/default states (e.g. the bot's home menu, the
   settings screen, an empty portfolio view) where no user-specific
   financial data is displayed at all.

**Recommended screenshot set** (map directly to the "Screenshots" upload
field most directories have — usually 3-5 images):

1. Telegram bot **home/main menu** screen (empty-state or your own test
   account)
2. **Snipe configuration** screen (buy amount, take-profit/stop-loss
   settings)
3. A **trade notification card** (buy or sell) — from your own test
   position only
4. **Dashboard** portfolio/positions view (your own test account, or a
   deliberately empty/demo state)
5. **Referral** or **withdrawal** screen (structure/UI, not real balances)

None of these currently exist as ready-made image files in the repository —
`docs/images/*` contains only architecture and security _diagrams_
(system-design boxes-and-arrows, not product screenshots), which are useful
for a technical/investor audience but not as directory listing screenshots.
Generating the actual screenshots above requires you (or me, with your
explicit go-ahead and a safe test account) to open the live bot/dashboard
and capture them — this wasn't done automatically here because it would
mean interacting with the live production bot, which the task explicitly
asked me not to do without your sign-off.

## Existing internal assets (not public-listing-ready as-is)

- `docs/presentation/assets/*.png` — architecture and security diagrams,
  investor-deck style. Useful for a "How it's built" trust section if you
  want one, not as app-store screenshots.
- `docs/presentation/Presentation_EN.pdf` — the existing investor deck.
  Don't submit this to public directories as-is; it's written for
  investors, not end users, and contains a stale test count (997 vs. the
  current verified 960) that should be corrected before any external reuse.
