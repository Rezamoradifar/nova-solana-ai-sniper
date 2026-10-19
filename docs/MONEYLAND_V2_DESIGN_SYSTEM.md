# Moneyland V2 — Design System & UI Implementation

## Identity & UX objectives

A high-clarity, high-conversion cryptocurrency interface that gathers Solana market intelligence, DEX research, spot/futures UI, copy trading, arbitrage, token launches, flash-loan modeling and bots under one coherent product shell. **No competitor assets, logos, layout source, or proprietary content are copied.**

The redesign is shipped as React + TypeScript components in the existing Vite/Tailwind app. Old account, wallet, API, and trading routes are preserved. The new interface is a frontend release, **not evidence that every backend trading product is implemented or audited.**

### Tokens

| Role | Token | Hex |
| --- | --- | --- |
| Main background | moneyland.ink | `#0A0B0F` |
| Surfaces | moneyland.panel | `#11141F` |
| Primary interaction | moneyland.cyan | `#00E5FF` |
| Secondary accent | moneyland.purple | `#8B5CF6` |
| Profit / verified positive | moneyland.profit | `#22C55E` |
| Loss / risk | moneyland.loss | `#EF4444` |
| Primary copy | --ml2-text | `#F2F5FC` |
| Secondary copy | --ml2-secondary | `#A5AEC3` |
| Border | --ml2-border | translucent slate-blue 1px |
| Glass surface | --ml2-glass | 149deg indigo/ink gradient |
| Corner radius | --ml2-radius | 16px |

Token sources: `apps/dashboard/tailwind.config.js` and `apps/dashboard/src/moneyland-v2/moneyland-v2.css`.

### Fonts and spacing

- **Inter**: body UI, button text, navigation and forms.
- **Space Grotesk**: display, page heading, brand.
- **JetBrains Mono**: token prices, time, sizes, addresses and verified metrics.
- Type scale: 10px micro / 11–12px data and utility / 14–16px body / 21–25px card / 29–49px workspace headings / 55–98px hero.
- Spacing: 4px base grid, common increments 8 / 12 / 16 / 24 / 32 / 48 / 64px.
- Layout maximum: 1440px content, 1536px top navigation.
- Responsive breakpoints: **1360 / 1140 / 1020 / 760 / 480px**.
- Body is dark from first paint; no light-theme flash. Motion is disabled with prefers-reduced-motion.

### Components

**Reusable React building blocks**:

| Component | What it provides |
| --- | --- |
| `MoneylandFrame` | header, mega-menu, mobile nav, keyboard-aware navigation, footer, route shell |
| `Panel` | translucent bordered content cards, headings and actions |
| `Pill`, `ModeTag` | operational state badges (verified data, simulation, preview, offline) |
| `Glyph` | internal lightweight SVG icon paths with consistent stroke |
| `Skeleton` | animated placeholder in loading data feeds |
| `Modal` | accessible dialog role, Escape key and backdrop dismissal |
| `ToolHeading` | bilingual workspace headings, trust/source badges and actions |
| `Notice` | risk, info and verified-safe explanatory notices |
| `Stat` | factual KPI cell with note for source scope |
| `EmptyState` | honest no-data fallback |
| `FormField` | labeled, keyboard-friendly inputs and controls |
| `Sparkline` | strictly labelled illustrative trend motif; never actual ROI series |
| `useMLFeed` | 30s Solana market observations with abort/visibility awareness |
| `useMLToast` | local notification feedback for demo actions |
| `useML` | persistent EN/FA locale switch and RTL/LTR root direction |

All shared components are implemented under `apps/dashboard/src/moneyland-v2/`. TradingView's existing external embed provides a real reference chart. Accessibility affordances include focus rings, semantic links, aria labels, status announcements, substantial tap targets and high-contrast text.

### Route map

| New route | UI screen | Real data/execution boundary |
| --- | --- | --- |
| `/` | Conversion landing, feature grid, market watchlist, trust and FAQ | Real Solana price, pool volume and liquidity; decorative hero chart explicitly illustrative |
| `/terminal` | Overview and live external chart | API-backed market feed; account valuation not invented |
| `/terminal/dex` | Multi-chain selector, swap inputs, slippage modal, order book and trades surfaces | Real Solana spot-reference data only; swap quote and execution *not* attached |
| `/terminal/exchange` | Spot/futures, pair list, chart, order types, book and activity slots | Chart and reference prices only; no centralized execution or margin service |
| `/terminal/copy` | Backend-ranked wallets, ROI and win-rate columns, local allocation modal | Public copy feed; drawdown/follower counts and 30/90-day histories unavailable unless source supplies them |
| `/terminal/arbitrage` | Read-only real route scanner with venue, estimate, fee allowance and freshness | Uses existing `scanLiveRoutes`; **never signs, sends or auto-executes transactions** |
| `/terminal/memes` | GMGN feed, risk checklist and sniper entry | Safety checks not verified, quick buy locked |
| `/terminal/flash` | Visual borrow/route/repay blocks + editable assumptions cost model | Arithmetic-only simulation; provider availability, atomicity, security not verified |
| `/terminal/bots` | Template gallery, configuration builder, local demo bot list | No live bots, backtests, fills or balance effects are invented |
| `/terminal/portfolio` | Approved Solana public address, SOL balance, recent signatures | No full multi-asset valuation or realized PnL inferred |

**Preserved connected routes:** `/wallet`, `/markets`, `/arbitrage`, `/copy-trading`, `/flash-arbitrage`, `/research`, `/executions`, `/telegram`, `/dashboard`. Existing servers, signing and auth logic remain unchanged.

### Data integrity & safety principles

1. Pool volume is **observed volume for returned selected pools**, not platform trading volume.
2. Observed liquidity is **not protocol-wide TVL**.
3. No live user counts, fills, audited security badges, or token safety status are fabricated.
4. Read-only wallet connection and verified public address are separate from custodial bot accounts.
5. No fake recent trades, order books, equity curves, unrealized gains, followers or bot PnL.
6. Non-Solana chains are clearly labelled `PREVIEW`.
7. Every high-risk financial module includes warnings. Simulation inputs may generate illustrative mathematical results, not a guarantee of real transaction profitability.
8. Social/community links are only shipped when verified. Do not insert placeholders masquerading as official Discord or X links.
9. All trade execution calls remain in the existing audited-by-operator workflows (if enabled), not in the redesigned presentation shell.

### Build/test

~~~bash
npm ci
npx tsc --noEmit -p apps/dashboard/tsconfig.json
npm run build --workspace @nova/dashboard
npm run test
~~~

The `moneyland-v2-ui.yml` workflow validates the frontend and production bundle on its dedicated branch. Review the CI result and test any deployment behind HTTPS before linking a wallet with funds.

### Deployment

Moneyland domain registration/DNS is separate from the web app. A validated frontend build does not imply that `moneyland.tr` resolves or that the VPS is hosting the latest release. Follow `docs/MONEYLAND_DEPLOY.md` for nameserver/Cloudflare checks and deployment safety gates. The current origin deploy script should always use a reviewed merged commit and should not replace or reset production branches blindly.

### Acceptance / UX checklist

- [ ] EN ↔ FA changes all main navigation and major UI copy, root direction switches to RTL.
- [ ] Mega-menu works with mouse and keyboard; Escape closes it.
- [ ] Header and sidebar operate at desktop / tablet / narrow mobile.
- [ ] Market request loading, success, empty and error states are visible.
- [ ] Live data numbers never fall back to invented values.
- [ ] TradingView reference chart renders or gracefully shows its frame when blocked.
- [ ] Swap and exchange amount fields respond and show **non-executable** calculations.
- [ ] Arb scanner yields time-stamped read-only routes or source-availability feedback.
- [ ] Flash-loan inputs update a simulation, with a prominent warning.
- [ ] Bot template selection and local start/stop states work without transactions.
- [ ] Wallet balance and on-chain signatures render only for an approved public address.
- [ ] Route refreshes, no-JavaScript content, accessibility and external-source outages reviewed in deployment QA.
