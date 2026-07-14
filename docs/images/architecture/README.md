# Architecture Diagrams

Real diagrams rendered directly from this repository's own Mermaid source
(`.doc-assets/architecture-*.mmd`) via `@mermaid-js/mermaid-cli` — not
illustrations, not stock diagrams.

- `architecture-overview.png` — full system component diagram (discovery
  sources → trading pipeline → financial core → user surfaces).
- `architecture-deployment.png` — production deployment topology (Nginx,
  PM2-supervised services, PostgreSQL, Redis, Solana RPC, Telegram Bot API).

See `ARCHITECTURE.md` at the repository root for the same diagrams in
context, plus a sequence diagram of the discovery → auto-buy → exit data
flow.
