# Claude Code Instructions for hadoku-trader

## Working Style

**BE PROACTIVE. DO NOT ASK UNNECESSARY QUESTIONS.**

- When asked to make a change, MAKE IT. Don't ask for confirmation.
- When asked to commit, COMMIT AND PUSH. Deployment is automatic.
- When something is obviously needed (like wiring up a route for an exported function), DO IT without being asked.
- If you need to bump versions, bump them. If tests need to run, run them.
- NEVER say "let me know when you're ready" - just do the work.

## What This Repo Is

Congressional trade copying system. Three independently-published packages in one repo:

| Package                 | Type                     | Location              | Exports                                                                             |
| ----------------------- | ------------------------ | --------------------- | ----------------------------------------------------------------------------------- |
| `@wolffm/trader`        | React dashboard          | `src/entry.tsx`       | `mount(el)`, `unmount(el)`                                                          |
| `@wolffm/trader-worker` | CF Worker engine         | `worker/src/index.ts` | `createTraderHandler(env)`, `createScheduledHandler(env)`, `analyzeSignals()`, etc. |
| `hadoku-fidelity`       | Python broker automation | `fidelity-api/`       | `hadoku-trader` CLI, FastAPI app                                                    |

## Cross-Repo Contracts

- **hadoku_site** (`../hadoku_site/`) imports `@wolffm/trader-worker`, mounts `@wolffm/trader`
- **hadoku-scrape** (`../hadoku-scrape/`) provides signals via `GET /api/v1/politrades/signals/pull`
- **Tunnel**: local fidelity-api via cloudflared at `hadoku.me/mgmt/api/fidelity`
- **Dispatch**: `publish.yml` sends `packages_updated` event to `WolffM/hadoku_site`
- Version bumps are automatic via pre-commit hook (`.husky/pre-commit`)

## Price Semantics (CRITICAL)

| Field              | What It Is                   | Used For                                |
| ------------------ | ---------------------------- | --------------------------------------- |
| `trade_price`      | Price when politician traded | Scoring, filtering (`price_change_pct`) |
| `disclosure_price` | Price when publicly filed    | Observability only                      |
| `current_price`    | Current market price         | Signal evaluation                       |

`price_change_pct = (current - trade_price) / trade_price × 100` — used in production for hard filters and scoring.

## Important Constraints

- Never execute real trades without explicit confirmation
- Signal deduplication is critical — check by `source_id`
- Monthly budget caps: $1,000/agent, enforced
- All trades need audit logging with full reasoning chain
- Stop-loss/exit monitoring runs every 15 minutes during market hours

## Development

```bash
pnpm install && pnpm dev    # Frontend dev server
pnpm build                  # Production build
cd worker && pnpm test      # Engine tests
```

The Python broker (`fidelity-api/` → `hadoku-fidelity`, the `hadoku-trader`
CLI / FastAPI app) runs from a **per-repo `.venv`**, not the system Python.
hadoku_site's deploy creates `.venv` and `pip install -e ./fidelity-api/`
into it; the PM2 wrapper launches `.venv/bin/hadoku-trader`. Local
Python work: `python -m venv .venv` at the repo root, then
`.venv/bin/python -m pip install -e ./fidelity-api/`. Never install into
the system Python.

## Does NOT contain

- File structure trees (run `ls`)
- Full API route reference (see `worker/README.md`)
- Full engine spec (see `docs/ENGINE_SPEC.md`)
- Full type inventories (grep `worker/src/types.ts` and `worker/src/agents/types.ts`)
- Code style rules (see `eslint.config.js`, `.prettierrc`)
- Integration guides (see `docs/HADOKU_SITE_INTEGRATION.md`, `docs/SCRAPER_INTEGRATION.md`)

## Auth & secrets (hadoku ecosystem)

- **Browser fetches** (if this repo serves any UI) must hit `hadoku.me/{prefix}/*` via edge-router — NEVER `*.hadoku.me` direct subdomains. The `hadoku_session` cookie (`Domain=.hadoku.me`, 30d sliding) is set on `/auth` and resolved server-side into `X-User-Key`.
- **Secrets**: vault-broker model, NO `.env` files. Production runtime secrets are injected by the PM2 wrapper at `../hadoku_site/services/pm2/<service>-wrapper.mjs` — wrapper waits for vault unlock, fetches needed keys, execs the service with them in `process.env`. To add or change a key, see `../hadoku_site/docs/operations/SECRETS.md`. For local dev, the broker pattern (`.devvault.json` + `node ../hadoku_site/scripts/secrets/dev-vault.mjs`) is documented at `../hadoku_site/docs/child-apps/USING_VAULT.md`.
- **Auth model**: 1:1 named user-keys. `/auth` accepts key + name; whoami returns the name. Admin endpoints `GET/POST/DELETE /session/admin/keys` manage the registry. See `../hadoku_site/docs/planning/next-work.md`.
