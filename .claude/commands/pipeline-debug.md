Debug the full signal processing pipeline.

Check each stage in order:

1. **Scraper connectivity**: Can we reach the scraper API? Check SCRAPER_URL env var and test the endpoint.
2. **Signal count**: Query D1 `SELECT COUNT(*) FROM signals` and `SELECT COUNT(*) FROM signals WHERE status = 'pending'`
3. **Agent budgets**: Query `SELECT * FROM agent_budgets` — any agents at $0 remaining?
4. **Market price freshness**: Query `SELECT ticker, MAX(date) as latest FROM market_prices GROUP BY ticker ORDER BY latest ASC LIMIT 10` — any stale?
5. **Tunnel health**: Test `TUNNEL_URL/health` endpoint
6. **Recent trades**: Query `SELECT * FROM trades ORDER BY created_at DESC LIMIT 5`

Reference known issues: `docs/issues/trader-pipeline-issues.md`

Report status of each stage and identify the blocking issue.
