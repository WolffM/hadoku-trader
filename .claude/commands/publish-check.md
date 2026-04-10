Pre-publish verification checklist.

Run these checks before pushing to main:

1. **Versions**: Check `package.json`, `worker/package.json`, `fidelity-api/pyproject.toml` versions are consistent
2. **Frontend build**: `pnpm build` — must succeed with zero errors
3. **Worker build**: `cd worker && pnpm run build` — must succeed
4. **Worker tests**: `cd worker && pnpm test` — all green, zero warnings
5. **No data files tracked**: `git ls-files -- rankings.json signals_45d.json trader-db-export.json` — should return nothing
6. **Git status**: no unintended staged files

Report pass/fail for each check.
