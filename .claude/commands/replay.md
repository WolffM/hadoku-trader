Run a 45-day signal replay test against the trading engine.

Steps:

1. `cd worker && pnpm test replay-45d.ts`
2. Compare output against expected results in `docs/E2E_TEST_SIGNALS.md`
3. Verify: correct agents activated, scores within expected range, budget caps respected
4. Report any mismatches between expected and actual decisions
