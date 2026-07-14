# Security Diagrams

Real diagrams rendered directly from this repository's own Mermaid source
(`.doc-assets/security-*.mmd`) via `@mermaid-js/mermaid-cli`.

- `security-layers.png` — the request path's defense-in-depth layers, from
  the network firewall through to the immutable ledger.
- `security-concurrency.png` — the six database-enforced concurrency guards
  that make the specific duplicate-action scenarios they're paired with
  physically impossible, not just unlikely.

See `SECURITY.md` at the repository root for the full written detail behind
each of these.
