# Moneyland Neon 2.0 — frontend handoff

## Scope
A high-fidelity, bilingual React/TypeScript landing page and trading-workspace redesign on the existing Nova/GSP recovery branch. This is a frontend implementation, not a new custody, matching, derivatives, cross-chain or flash-loan execution engine. Existing protected account routes, backend services, trading flags, encryption keys and databases are unchanged.

## Run locally
From the repository root:

```sh
npm ci
npm run build --workspace @nova/dashboard
npm run dev --workspace @nova/dashboard -- --host 127.0.0.1
```

Open the Vite URL printed in the terminal. Add `?demo=1` to inspect sample-filled screens. Without that query parameter, the public market adapter requests `/api/public/markets`; unavailable data remains unavailable rather than being replaced by demo fixtures. Local development without the API can use design preview without any server credentials. Do not enter production secrets to preview this UI.

## Screen map
| Route | Screen | Implemented interaction |
| --- | --- | --- |
| `/` | Landing, ticker, bento, trust, FAQ | Wallet modal, product links, FAQ expansion, API market refresh |
| `/trade` | DEX research terminal | Chain selector, input/output tokens, reversal, slippage dialog, indicative swap preview |
| `/exchange` | Spot/futures interface | Paper order entry and cancellation; limit/market/stop states; empty positions/history |
| `/copy` | Trader discovery | Search, risk filter, 30/90-day sample views |
| `/copy/:traderId` | Fictional profile | Allocation and loss-limit validation, consent-gated preview |
| `/opportunities` | Arbitrage model | Notional and spread filters, cost estimate, paper-cycle toggle, review modal |
| `/meme-hub` | Meme coin discovery | Trending/new filters, sample risk cards, quick-buy/sniper preview |
| `/flash-loans` | Flash-loan builder | Keyboard-reorderable intermediate blocks, parameter validation, arithmetic cost model |
| `/bots` | Bot marketplace and builder | Five strategy templates, session-only configs, start/pause UI state, illustrative report |
| `/portfolio` | Portfolio overview | Sample balance hide/show, period controls, allocation and history layout, actual wallet connection state |
| `/design-system` | Component library | Tokens, typography, spacing, buttons, badges, forms, toggles, modal, toast, skeleton |
| `/classic` | Previous homepage | Retained for rollback/reference |

The existing `/arbitrage`, `/copy-trading`, `/flash-arbitrage`, `/research`, `/executions`, `/markets`, `/wallet`, `/tools`, `/telegram`, `/security`, `/pricing`, `/login` and protected `/dashboard/*` routes remain available. They intentionally retain their established connected workflows rather than silently acquiring a fake execution adapter.

## Design system
- Background `#0A0B0F`; panel `#121620`; raised panel `#171C29`.
- Electric cyan `#00E5FF`; purple `#8B5CF6`; profit `#22C55E`; loss `#EF4444`. Small loss text uses a lighter red for dark-background legibility.
- Primary text `#F5F7FC`; muted text `#A1ABC0`; translucent 1px borders.
- Inter for UI; Space Grotesk for display; JetBrains Mono for numbers; Vazirmatn for Persian. CSS requests web fonts; local fallbacks remain functional.
- Spacing: 4, 8, 12, 16, 24, 32, 48, 64px. Cards 16px, large features up to24px, controls9px.
- Responsive widths: 1440px desktop and390px mobile in browser captures; intermediate layouts adjust at1250/960/700/370px.
- All design rules are scoped below `.neon`; the optional `apps/dashboard/moneyland-tailwind.preset.cjs` exposes the same tokens to Tailwind3 consumers without overriding legacy GSP tokens.
- Native modal dialog, visible keyboard focus, skip link, Escape handling, logical layout properties, numeric LTR isolation, reduced-motion and forced-color support.
- Automated accessibility checks are not a certification. Screen readers, zoom, touch targets and all live-integrated content require a complete release audit.

## Data and financial boundaries
| Capability | Status in this redesign |
| --- | --- |
| Existing Solana public market API | Reused; controlled response contract tested |
| Browser Solana wallet | Existing Wallet Standard address-only connector reused |
| Account balances and live operations | Remain in the existing authenticated GSP dashboard |
| Exchange fills / futures positions | Not connected; session-only paper orders |
| New copy profiles / performance | Fictional fixtures, opt-in demo only |
| New arbitrage one-click execution | Not connected; arithmetic/review only; existing scanner linked |
| Meme safety data / buy / sniper | Labeled sample checks and preview; no buy or token approval |
| Flash-loan provider / simulation | Template selection and explicit user assumptions; not EVM simulation |
| Bot workers / real backtesting | Not started; UI state and sample report only |
| Ethereum / BSC / Arbitrum / Base adapters | Not implemented; chain options clearly labeled preview |
| Platform-wide volume / TVL / users | Unknown in normal mode; no fabricated totals |
| Security audits / partnerships | No audit or endorsement claimed; links must be supplied and verified |
| X / Discord | Unconfigured; no invented official links |

The sample flash model computes net = amount × spread% − gas − amount × feeBps /10000. Defaults give10000×0.5%−8−10000×5/10000 =37USDC. Doubling notional gives82USDC because the provider fee doubles too. This is not executable profit. Sample profiles, volume and portfolio amounts are never presented as real customer or platform performance.

## Verification
The `Moneyland neon UI verification` workflow runs TypeScript, focused input/model tests, the production frontend build, Playwright screen captures and interaction tests, and axe checks. Its artifact contains a machine-readable `qa-report.json`; treat that report and the particular GitHub run's conclusion as the source of truth for pass/fail. Planned coverage is11 routes × desktop/mobile × English/Persian =44 captures. No live user funds or production wallet identities are used.

## Deployment boundary
No DNS, registrar, Cloudflare or VPS changes are made by this redesign. Build the frontend and verify the API origin on a staging environment before publishing to `moneyland.tr`. Do not run a legacy whole-stack reset or enable trading just to deploy a UI. Review existing dependency vulnerabilities and security configuration before exposing any real-funds workflow; npm reported security advisories in the inherited lockfile during CI, and this redesign deliberately does not perform an unrelated force-upgrade.

## Source organization
- `src/neon/model.ts`: product metadata, clearly synthetic fixtures, formatting and model functions.
- `src/neon/ui.tsx`: shared component library, language/data provider, wallet dialog, navigation and feedback.
- `src/neon/Home.tsx`: landing sections.
- `src/neon/Trade.tsx`: DEX and exchange UI.
- `src/neon/Research.tsx`: copy, arbitrage and meme UI.
- `src/neon/Automation.tsx`: flash loans, bots, portfolio and design-system showcase.
- `src/neon/neon.css`: reusable, responsive styling and design tokens.
- `src/neon/model.test.ts`: numeric validation and model invariant tests.
- `scripts/qa-moneyland-neon.cjs`: local browser test and capture harness.

No native Figma file has been created. React components, the token preset and the screen captures are the delivered design/development artifacts.
