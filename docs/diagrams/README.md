# Diagram Sources

Mermaid (`.mmd`) source for every rendered PNG in `docs/images/` and
`docs/presentation/assets/`. Regenerate any diagram with
[`@mermaid-js/mermaid-cli`](https://github.com/mermaid-js/mermaid-cli):

```bash
npx @mermaid-js/mermaid-cli \
  -i docs/diagrams/<name>.mmd \
  -o docs/images/<group>/<name>.png \
  -b white -s 2 \
  --puppeteerConfigFile docs/diagrams/puppeteer-config.json \
  -c docs/diagrams/mermaid-config.json
```

`puppeteer-config.json` points at a local Chromium executable — update
`executablePath` to match whatever headless Chrome/Chromium is available
in your environment (e.g. the one Playwright or `npx puppeteer` installs).

| File                          | Used in                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| `architecture-overview.mmd`   | `ARCHITECTURE.md`, `docs/images/architecture/`, presentation §22 |
| `architecture-deployment.mmd` | `ARCHITECTURE.md`, `docs/images/architecture/`, presentation §31 |
| `security-layers.mmd`         | `SECURITY.md`, `docs/images/security/`, presentation §17         |
| `security-concurrency.mmd`    | `SECURITY.md`, `docs/images/security/`                           |
| `db-erd.mmd`                  | presentation §23 (Database Diagram)                              |
| `flow-user.mmd`               | presentation §24 (User Flow)                                     |
| `flow-trading.mmd`            | presentation §25 (Trading Flow)                                  |
| `flow-wallet.mmd`             | presentation §26 (Wallet Flow)                                   |
| `flow-referral.mmd`           | presentation §27 (Referral Flow)                                 |
| `flow-profit.mmd`             | presentation §28 (Profit Distribution Flow)                      |
| `flow-withdrawal.mmd`         | presentation §29 (Withdrawal Flow)                               |
