Search for existing utility functions before writing new ones.

Before creating any new function in the worker package, search these locations:

1. `grep -r "$ARGUMENTS" worker/src/agents/ worker/src/utils.ts worker/src/types.ts --include="*.ts" -l`
2. Check `worker/src/agents/index.ts` for available exports
3. Check `worker/src/agents/types.ts` and `worker/src/types.ts` for type definitions
4. Check `worker/src/agents/test-utils.ts` for test utility functions

Known duplication traps:

- `daysBetween()` — canonical location: `worker/src/agents/filters.ts`
- `insertSignalRow()` — canonical location: `worker/src/utils.ts`
- `calculateDisclosureLagDays()` — canonical location: `worker/src/utils.ts`
- `ScoringBreakdown` type — canonical location: `worker/src/agents/types.ts`

Report what you find. Do not create a new function if one already exists.
