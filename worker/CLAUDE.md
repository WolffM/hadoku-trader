# @wolffm/trader-worker — Multi-Agent Trading Engine

Consumed by hadoku-site as `@wolffm/trader-worker`. Three independent agents:

| Agent                       | Strategy                  | Signals                               | Sizing       |
| --------------------------- | ------------------------- | ------------------------------------- | ------------ |
| ChatGPT ("Decay Edge")      | Score-based, soft stops   | All politicians                       | score² × 20% |
| Claude ("Decay Alpha")      | Score-based, take-profits | All politicians                       | $200 × score |
| Gemini ("Titan Conviction") | Pass/fail on 5 Titans     | Pelosi, Green, McCaul, Khanna, Larsen | Equal split  |

## Signal Processing

Deduplicate → route to agents → hard filters → score (7 components) → decide → size → execute → audit log.

## Critical Test Files (DO NOT DELETE)

| File                            | Purpose                                         |
| ------------------------------- | ----------------------------------------------- |
| `simulation.test.ts`            | Portfolio simulation, backtesting, tax analysis |
| `politician-analysis.test.ts`   | Individual politician performance               |
| `scoring-retrospective.test.ts` | Scoring algorithm validation                    |
| `strategy-variations.test.ts`   | A/B testing strategy parameters                 |

These use `trader-db-export.json` (261MB, gitignored). Run: `pnpm test <filename>`

## No Hardcoded Lists in Tests

NEVER hardcode politician lists or Top 10 rankings. Compute dynamically:

```typescript
const top10 = computeTop10FromSignals(signals, { windowMonths: 24, minTrades: 15 })
```

Use `computePoliticianRankings()` from `rankings.ts`.

## Key Constraints

- Monthly budget cap: $1,000/agent
- Stop-loss monitoring: every 15min during market hours (cron in hadoku-site's wrangler.toml)
- Full reasoning chain logged for every trade decision

## Does NOT contain

- API route reference (see `worker/README.md`)
- Full engine spec (see `docs/ENGINE_SPEC.md`)
- Database schema (see `worker/schema.sql`)
- Integration guides (see `docs/HADOKU_SITE_INTEGRATION.md`)
