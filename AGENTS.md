# Agent Guidelines for hadoku-trader

## Project Overview

hadoku-trader is a congressional trade copying system with:
- **Frontend**: React dashboard hosted on hadoku.me
- **Backend** (planned): FastAPI service for signal processing and trade execution
- **Broker Integration**: Forked fidelity-api for Fidelity automation

## Code Locations

### Frontend (React/TypeScript)
- `src/` - React components and hooks
- `src/App.tsx` - Main application component
- `src/entry.tsx` - Mount/unmount exports for parent integration
- `src/hooks/` - Custom React hooks
- `src/styles/` - CSS files

### Fidelity API (Python)
- `fidelity-api/fidelity/fidelity.py` - Main automation class
- `fidelity-api/tests/example.py` - Usage example

### Documentation
- `docs/requirements.md` - Full system requirements and architecture
- `docs/scrapeRequirements.md` - Signal schema for hadoku-scraper integration

## Key Patterns

### Frontend
- Uses `@wolffm/themes` for theming via CSS variables
- Uses `@wolffm/task-ui-components` for shared UI components
- Mounts as child app within hadoku_site parent
- Use `logger` from task-ui-components, not console.log

### Fidelity API
- Playwright-based browser automation
- Session state saved to JSON files
- Supports 2FA via TOTP or SMS
- All trading functions return `(success: bool, error_message: str)` tuples

## Signal Schema

Signals from hadoku-scraper follow this structure:
```json
{
  "source": "unusual_whales|capitol_trades|quiver_quant|...",
  "politician": { "name", "chamber", "party", "state" },
  "trade": { "ticker", "action", "asset_type", "disclosed_price", "disclosed_date", "filing_date", "position_size", "position_size_min", "position_size_max" },
  "meta": { "source_url", "source_id", "scraped_at" }
}
```

## Position Sizing Formula

```python
base = tier_percentage * monthly_cap  # 2-25% based on politician trade size
conviction = 1 + (0.25 * (source_count - 1))  # +25% per additional source
priced_in_factor = max(0.2, 1 - (price_move * 2) - (days_stale * 0.01))
final = min(base * conviction * priced_in_factor, monthly_budget_remaining)
```

## API Endpoints (Planned)

```
POST /signals          - Receive signals from hadoku-scraper
GET  /portfolio        - Current positions, P&L, allocation
GET  /trades           - History with reasoning
GET  /performance      - Returns vs benchmarks
GET  /budget           - Monthly cap utilization
GET  /signals          - All received signals + disposition
```

## Testing

### Frontend
```bash
pnpm dev      # Start dev server
pnpm build    # Build for production
pnpm lint:fix # Fix linting issues
```

### Fidelity API
```bash
cd fidelity-api
pip install -e .
playwright install
python tests/example.py
```

## Important Notes

1. Fidelity API uses browser automation - requires visible browser or headless mode
2. Always use dry=True for testing trades before real execution
3. Frontend deploys automatically on push to main
4. Signal deduplication is critical - use source_id for tracking
