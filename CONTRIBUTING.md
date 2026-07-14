# Contributing

This is a private, proprietary repository (see `LICENSE`). This guide is for
authorized team members and contractors working under a separate written
agreement — it is not an open-source contribution guide, and unsolicited
external pull requests will not be accepted.

## Workflow

1. Branch from the current production branch.
2. Make the smallest coherent change that accomplishes the task — this
   codebase favors small, well-documented, extensively-commented changes
   over broad refactors (see "Code style" below).
3. Run the full validation suite before opening a PR:
   ```bash
   npm run build
   npm run typecheck
   npm run lint
   npm run test
   ```
4. Commit — a pre-commit hook (`husky` + `lint-staged`) automatically runs
   ESLint and Prettier on staged files; a failing lint error blocks the
   commit.
5. Open a PR describing **why**, not just what — this repository's own
   commit history and inline doc comments consistently explain the
   motivation and any prior incident behind a change, not just the diff.

## Code style

- TypeScript, strict mode, throughout.
- Prettier: single quotes, semicolons, trailing commas, 100-column width,
  2-space indent (`.prettierrc.json`) — run `npm run format` or rely on the
  pre-commit hook.
- ESLint (`eslint.config.mjs`) must report zero errors. Warnings
  (unused-var, `no-explicit-any`) are tolerated but should be justified,
  not silently accumulated.
- Comments should explain **why**, not what — especially for anything that
  fixes a specific historical production incident. Several files in this
  codebase document a live-verified bug and its fix in detail; follow that
  convention when you fix something non-obvious.

## Testing expectations

- Every new code path that touches money (trading, wallet, ledger,
  withdrawal, referral, profit distribution) needs a test, and a
  concurrency/race test where two callers could plausibly act on the same
  resource at once — this is not optional given this codebase's history of
  exactly that class of bug.
- Prefer a genuinely stateful test fake (see `profitDistributionAudit.
test.ts`'s `FakeDb` or `positionCloseLock.test.ts`) over a mock that
  always resolves — a stateful fake is what actually catches a race
  condition; an always-succeeds stub cannot.
- Run the specific test file you're working on first (`npx vitest run
<path>`), then the full suite before committing.

## Database changes

- Every schema change is a reviewed, plain SQL migration file
  (`apps/api/prisma/migrations/`) — never an auto-applied destructive
  migration without review.
- A new uniqueness/concurrency guard should be a real database constraint
  (unique index, partial unique index, or a dedicated single-purpose claim
  table), not just an application-level check — see `SECURITY.md`'s
  concurrency table for the existing pattern to follow.
- After any schema change: `npm run prisma:generate` and verify
  `npx prisma migrate status` reports the schema up to date before
  committing.

## Do not

- Do not commit `.env` or any real secret.
- Do not run `npm audit fix --force` without reviewing exactly what it
  changes — see `SECURITY.md`'s "known accepted findings" for why several
  advisories are deliberately left unfixed today.
- Do not add a "quick fix" that bypasses `LIVE_TRADING` / `KILL_SWITCH` or
  any of the money-moving concurrency guards described in `SECURITY.md`.
- Do not deploy without running `npm run build` first and confirming the
  running PM2/Docker process was restarted afterward — this codebase has a
  documented historical incident where the running process silently
  diverged from `src/` for hours because a rebuild+restart was missed.
