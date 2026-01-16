# Unified Trading Engine Design

## Goal

Build ONE engine that supports all three agent strategies with minimal custom code per agent. Maximize shared infrastructure, minimize per-agent complexity.

---

## Analysis: What's Actually Different?

| Aspect | ChatGPT | Claude | Gemini | Can Unify? |
|--------|---------|--------|--------|------------|
| **Signal source** | All politicians | All politicians | 5 Titans only | Config: `politician_whitelist` |
| **Asset types** | Stock, ETF, Option | Stock, ETF, Option | Stock only | Config: `allowed_asset_types` |
| **Max signal age** | 45 days | ~46 days (via decay) | 45 days | ✅ Standardize: 45 days |
| **Max price move** | 25% | ~30% (via scoring) | 15% | Config: `max_price_move_pct` |
| **Scoring** | 5 components, weighted | 4 components, weighted | None (pass/fail) | See below |
| **Execute threshold** | 0.70 (full) / 0.55 (half) | 0.55 | N/A (all accepted = execute) | Config: `execute_threshold` |
| **Position sizing** | score² × 20% | $200 × score | Equal split | Config: `sizing_mode` |
| **Stop-loss** | 2.5σ in 5 days | 15% hard | 20% trailing | Config: `stop_loss_config` |
| **Take-profit** | None | 25%→50%, 40%→rest | None | Config: `take_profit_config` |
| **Time exit** | 120/90/30 days | Staged 60/90/120 | None | Config: `time_exit_config` |

---

## Simplification Proposals

### 1. Drop ChatGPT's Volatility-Based Features

**Current:** ChatGPT uses volatility for:
- Decay speed (7 vs 14 day half-life)
- Price movement normalization (σ-based)
- Stop-loss (2.5σ in 5 days)

**Problem:** Requires fetching/computing volatility data for every ticker. Adds complexity.

**Proposal:** Replace with fixed thresholds that approximate the intent:

| Original | Simplified Replacement | Rationale |
|----------|----------------------|-----------|
| 7-day half-life (high vol) | Use 10-day half-life for all | Split the difference |
| 14-day half-life (low vol) | Use 10-day half-life for all | Conservative |
| Volatility-normalized price check | Fixed 25% threshold | Already there as hard filter |
| 2.5σ stop-loss | 18% hard stop | ~2.5σ for typical 2% daily vol over 5 days |

**Impact:** Slight loss of precision, but removes need for volatility data pipeline entirely.

**ChatGPT Response:** ✅ **APPROVED** with one required addition:

> **Time-based soft stop (NEW):** If no positive movement after 30 days (stock/ETF) or 10 days (option), exit at market. This replaces volatility shock logic with "time failure" logic.

**ChatGPT's rationale:** "Volatility-awareness is a refinement, not the core edge. The primary alpha comes from time decay, price already realized, politician skill, and position size."

---

### 2. Simplify Claude's Sector Concentration

**Current:** Max 30% per sector, requires Yahoo Finance API calls.

**Proposal:** Drop for v1. Rely on max 2 positions per ticker + general diversification from low max-position-count.

**Claude Response:** ✅ **APPROVED**

> "With $1,000/month and max $250/trade, I'll have 4-10 positions at any time. The 'max 2 per ticker' rule provides enough diversification for this scale. Sector limits would matter more at $50K+ portfolios."

**Impact:** Removes Yahoo Finance dependency. Sector limits can be added in v2 if needed.

---

### 3. Standardize Exit Strategies

**Current chaos:**
- ChatGPT: Time expiry + weekly re-eval + volatility shock
- Claude: Stop-loss + take-profit + staged time exit
- Gemini: Trailing stop only

**Proposal:** Unified exit engine with configurable rules:

```typescript
interface ExitConfig {
  // Stop-loss (pick one mode)
  stop_loss: {
    mode: 'fixed' | 'trailing' | 'none';
    threshold_pct: number;  // e.g., 15 or 20
  };

  // Take-profit (optional)
  take_profit?: {
    first_threshold_pct: number;   // e.g., 25
    first_sell_pct: number;        // e.g., 50
    second_threshold_pct: number;  // e.g., 40
    second_sell_pct: number;       // e.g., 100
  };

  // Time-based exit
  max_hold_days: number;  // e.g., 120
}
```

**Simplified agent configs:**

| Agent | stop_loss | take_profit | max_hold_days | soft_stop |
|-------|-----------|-------------|---------------|-----------|
| ChatGPT | `fixed: 18%` | none | 120 | 30d no-progress (stock/ETF), 10d (option) |
| Claude | `fixed: 15%` | `25%→50%, 40%→100%` | 120 | none |
| Gemini | `trailing: 20%` | none | none (∞) | none |

**Impact:** Drops ChatGPT's weekly re-evaluation and volatility shock. Drops Claude's "staged" 60/90 day checks.

**Claude Response:** ✅ **APPROVED**

> "The 15% stop-loss catches the real danger (big losers). The staged 60/90 logic was trying to optimize around small losers (-5%) sitting too long, but at $150 average position size, the opportunity cost is negligible."

**Claude's Final v1 Exit Rules:**
- 15% stop-loss (immediate)
- 25% take-profit → sell 50%
- 40% take-profit → sell remainder
- 120-day max hold (close regardless)

**What Claude wants preserved (non-negotiable):**
1. Scoring algorithm (time decay, price movement, conviction)
2. Hard filters (auto-skip stale/exhausted trades)
3. Conviction-based position sizing
4. No shorting rule

---

### 4. Unify Scoring into Pluggable Components

Instead of 3 different scoring implementations, build ONE scoring engine with pluggable components:

```typescript
interface ScoringConfig {
  // Which components to use and their weights
  components: {
    time_decay?: { weight: number; half_life_days: number };
    price_move?: { weight: number; penalty_curve: 'linear' | 'stepped' };
    position_size?: { weight: number; thresholds: number[] };
    politician_skill?: { weight: number; min_trades: number };
    source_quality?: { weight: number };
    filing_speed?: { weight: number };
    cross_confirmation?: { weight: number };
  };

  // Hard filters (auto-skip if triggered)
  hard_filters: {
    max_days_old: number;
    max_price_move_pct: number;
    min_composite_score?: number;
  };
}
```

**Agent configs:**

```typescript
const chatgptScoring: ScoringConfig = {
  components: {
    time_decay: { weight: 0.30, half_life_days: 10 },  // simplified
    price_move: { weight: 0.25, penalty_curve: 'stepped' },
    position_size: { weight: 0.15, thresholds: [15000, 50000, 100000, 250000] },
    politician_skill: { weight: 0.20, min_trades: 20 },
    source_quality: { weight: 0.10 },
  },
  hard_filters: {
    max_days_old: 45,
    max_price_move_pct: 25,
  }
};

const claudeScoring: ScoringConfig = {
  components: {
    time_decay: { weight: 0.30, half_life_days: 14 },
    price_move: { weight: 0.35, penalty_curve: 'linear' },
    position_size: { weight: 0.15, thresholds: [50000, 100000, 250000, 500000] },
    politician_skill: { weight: 0.10, min_trades: 20 },
    filing_speed: { weight: 0.05 },
    cross_confirmation: { weight: 0.05 },
  },
  hard_filters: {
    max_days_old: 45,
    max_price_move_pct: 30,
    min_composite_score: 0.55,
  }
};

const geminiScoring: ScoringConfig = {
  components: {},  // No scoring - pass/fail only
  hard_filters: {
    max_days_old: 45,
    max_price_move_pct: 15,
    politician_whitelist: ['Nancy Pelosi', 'Mark Green', 'Michael McCaul', 'Ro Khanna', 'Rick Larsen'],
    asset_types: ['stock'],
  }
};
```

---

## Unified Engine Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      SIGNAL INGESTION                            │
│  (Shared: fetch from sources, dedupe, enrich with prices)       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SIGNAL ROUTER                               │
│  For each agent: does signal pass agent's whitelist/filters?    │
│  - ChatGPT/Claude: all politicians                              │
│  - Gemini: Titans only                                          │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│   SCORING       │ │   SCORING       │ │   SCORING       │
│   (ChatGPT      │ │   (Claude       │ │   (Gemini       │
│    config)      │ │    config)      │ │    config)      │
└─────────────────┘ └─────────────────┘ └─────────────────┘
              │               │               │
              ▼               ▼               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    DECISION ENGINE                               │
│  Shared logic:                                                   │
│  - Compare score to threshold → EXECUTE / SKIP                  │
│  - Calculate position size based on sizing_mode                 │
│  - Check budget remaining                                        │
│  - Check concentration limits                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    EXECUTION ENGINE                              │
│  Shared: queue trade → Fidelity API → confirm → log             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    POSITION MONITOR                              │
│  Shared scheduled job that checks all positions against each    │
│  agent's exit_config (stop-loss, take-profit, time exit)        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Simplified Database Schema

```sql
-- Agents with their full config as JSON
CREATE TABLE agents (
  id TEXT PRIMARY KEY,              -- 'chatgpt', 'claude', 'gemini'
  name TEXT,
  monthly_budget REAL DEFAULT 1000,
  scoring_config JSON,              -- Full ScoringConfig
  sizing_config JSON,               -- Position sizing rules
  exit_config JSON,                 -- Exit rules
  is_active BOOLEAN DEFAULT true
);

-- Unified positions table (works for all agents)
CREATE TABLE positions (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  ticker TEXT,
  shares REAL,
  entry_price REAL,
  entry_date TEXT,
  highest_price REAL,               -- For trailing stops
  cost_basis REAL,
  status TEXT DEFAULT 'open',       -- 'open', 'closed'
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Unified trade log
CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  signal_id TEXT,
  ticker TEXT,
  action TEXT,                      -- 'buy', 'sell', 'skip'
  decision TEXT,                    -- 'execute', 'skip', 'exit_stop', 'exit_time', etc.
  score REAL,                       -- NULL for Gemini
  score_breakdown JSON,             -- Component scores for debugging
  position_size REAL,
  executed_price REAL,
  executed_at TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Politician stats (shared across all agents)
CREATE TABLE politician_stats (
  name TEXT PRIMARY KEY,
  total_trades INTEGER DEFAULT 0,
  winning_trades INTEGER DEFAULT 0,
  win_rate REAL,
  last_updated TEXT
);
```

---

## What's Actually Custom Per Agent

After unification, here's what remains agent-specific:

| Component | ChatGPT | Claude | Gemini |
|-----------|---------|--------|--------|
| **Config JSON** | Scoring weights, thresholds | Scoring weights, thresholds | Whitelist, no scoring |
| **Custom code** | None | None | Succession protocol logic |
| **Extra data needs** | None (after dropping volatility) | Sector (optional) | Titan portfolio scan (semi-annual) |

**Gemini's unique needs:**
1. Hardcoded politician whitelist (but this is just config)
2. Succession Protocol - needs some logic to find replacements (but this is a rare quarterly check, could be semi-manual)
3. Consensus Core basket update - needs to scan Titan holdings (semi-annual, could be manual)

---

## Proposed Simplifications Summary

| Change | Affected Agent | Impact | Status |
|--------|---------------|--------|--------|
| Drop volatility-based decay/stops | ChatGPT | Use fixed 10-day half-life, 18% stop | ✅ Approved |
| Add time-based soft stop | ChatGPT | 30d no-progress exit (NEW requirement) | ✅ Required |
| Drop weekly re-eval | ChatGPT | Rely on stop-loss + soft stop instead | ✅ Approved |
| Drop sector concentration | Claude | Minor, covered by per-ticker limits | ✅ Approved |
| Drop Claude staged 60/90 day logic | Claude | Rely on stop-loss + 120 day max instead | ✅ Approved |
| Semi-manual Titan updates | Gemini | You provide names, we configure | ✅ Approved |

---

## Implementation Phases

### Phase 1: Core Engine (Shared)
- [ ] Signal ingestion + deduplication
- [ ] Generic scoring engine with pluggable components
- [ ] Decision engine (threshold comparison, position sizing)
- [ ] Position tracking
- [ ] Basic exit monitoring (stop-loss, time exit)

### Phase 2: Agent Configs
- [ ] Define ChatGPT config JSON
- [ ] Define Claude config JSON
- [ ] Define Gemini config JSON
- [ ] Load configs at startup

### Phase 3: Execution
- [ ] Fidelity API integration
- [ ] Trade queue + execution
- [ ] Position updates

### Phase 4: Monitoring & Analytics
- [ ] Dashboard showing all 3 agents
- [ ] Performance tracking per agent
- [ ] Win rate calculations

---

## Questions for Agents

Before finalizing, need approval on simplifications:

### ChatGPT ✅ APPROVED

All simplifications accepted with one addition:
- ✅ Fixed 10-day half-life (instead of volatility-based 7/14)
- ✅ Fixed price thresholds (instead of σ-normalized)
- ✅ Fixed 18% stop-loss (instead of 2.5σ)
- ✅ Drop weekly re-evaluation
- **NEW REQUIREMENT:** Add "time-based soft stop" - exit if no positive movement after 30d (stock/ETF) or 10d (option)

### Claude ✅ APPROVED

Both simplifications accepted:
- ✅ Drop sector concentration (rely on max 2 per ticker)
- ✅ Drop staged 60/90 day logic (rely on 15% stop + take-profits + 120d max)

**Preserved (non-negotiable):** Scoring algorithm, hard filters, conviction sizing, no shorting.

### Gemini ✅ APPROVED

Both simplifications accepted:
- ✅ Semi-manual Succession Protocol
- ✅ Semi-manual Consensus Core updates

**Initial Configuration Values (provided by Gemini):**

**First Reserve Titans:**
| If This Titan Leaves | Replace With |
|---------------------|--------------|
| Any Democrat (Pelosi/Khanna/Larsen) | Josh Gottheimer (D-NJ) |
| Any Republican (Green/McCaul) | Kevin Hern (R-OK) |

**Initial Consensus Core Basket (Q1 2026):**
| Ticker | Allocation | Rationale |
|--------|------------|-----------|
| NVDA | 25% | Held by Pelosi, Khanna, McCaul |
| MSFT | 25% | Universal across party lines |
| AMZN | 25% | High conviction Pelosi + Khanna |
| AAPL | 25% | Safety anchor |

*Note: Energy (ET) dropped from consensus - specific to Republican Titans, doesn't meet "held by all" criteria.*

**Workflow:**
- Succession: You prompt "Gemini, [Name] retired. Who replaces?" → Gemini provides name → You configure
- Basket: Calendar reminder Jan 1 / Jun 1 → You prompt "Update basket" → Gemini provides 4 tickers → You configure

---

## Estimated Complexity Reduction

| Metric | Before | After |
|--------|--------|-------|
| Scoring implementations | 3 | 1 (configurable) |
| Exit monitoring jobs | 5+ | 1 (configurable) |
| External data sources | 3 (quotes, volatility, sectors) | 1 (quotes only) |
| Custom code per agent | High | ~0 (config only) |
| Database tables | 6+ | 4 |
