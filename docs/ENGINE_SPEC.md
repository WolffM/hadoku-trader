# Congressional Trade Copying Engine - Final Specification

**Version:** 1.0
**Status:** Approved by all agents
**Budget:** $1,000/month per agent ($3,000 total)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SIGNAL INGESTION                             │
│  Fetch from sources → Deduplicate → Enrich with current price       │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         AGENT ROUTER                                 │
│  For each signal, determine which agents should evaluate it         │
│  - ChatGPT/Claude: All signals                                      │
│  - Gemini: Only signals from Titan whitelist                        │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐
              │ ChatGPT  │ │  Claude  │ │  Gemini  │
              │  Config  │ │  Config  │ │  Config  │
              └──────────┘ └──────────┘ └──────────┘
                    │             │             │
                    └─────────────┼─────────────┘
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      UNIFIED SCORING ENGINE                          │
│  Apply agent's scoring config → Return score + breakdown            │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      DECISION ENGINE                                 │
│  Score vs threshold → Position sizing → Budget check → EXECUTE/SKIP │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      EXECUTION ENGINE                                │
│  Queue trade → Fidelity API → Confirm → Update positions → Log      │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      POSITION MONITOR                                │
│  Periodic check: stop-loss, take-profit, time exit, soft stop       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Data Models

### Signal

```typescript
interface Signal {
  id: string;
  ticker: string;
  action: 'buy' | 'sell';
  asset_type: 'stock' | 'etf' | 'option';

  // Pricing
  trade_price: number;      // Price at time of trade
  current_price: number;

  // Dates
  trade_date: string;       // When politician traded
  disclosure_date: string;  // When disclosure was filed

  // Size (dollar amount, lower bound of range)
  position_size_min: number;

  // Attribution
  politician_name: string;
  source: string;

  // Computed
  days_since_trade: number;
  days_since_disclosure: number;
  price_change_pct: number;
}
```

### Agent Configuration

```typescript
interface AgentConfig {
  id: string;
  name: string;
  monthly_budget: number;

  // Filtering
  politician_whitelist: string[] | null;  // null = all politicians
  allowed_asset_types: ('stock' | 'etf' | 'option')[];

  // Hard filters
  max_signal_age_days: number;
  max_price_move_pct: number;

  // Scoring (null = no scoring, pass/fail only)
  scoring: ScoringConfig | null;

  // Decision
  execute_threshold: number;
  half_size_threshold: number | null;  // For "REBALANCE" action

  // Position sizing
  sizing: SizingConfig;

  // Exit rules
  exit: ExitConfig;
}
```

### Scoring Configuration

```typescript
interface ScoringConfig {
  components: {
    time_decay?: {
      weight: number;
      half_life_days: number;
      use_filing_date?: boolean;  // Also factor in filing freshness
      filing_half_life_days?: number;
    };
    price_movement?: {
      weight: number;
      thresholds: {  // Score at each price change level
        pct_0: number;    // 0% change
        pct_5: number;    // 5% change
        pct_15: number;   // 15% change
        pct_25: number;   // 25% change
      };
    };
    position_size?: {
      weight: number;
      thresholds: number[];  // Dollar amounts
      scores: number[];      // Corresponding scores
    };
    politician_skill?: {
      weight: number;
      min_trades_for_data: number;
      default_score: number;
    };
    source_quality?: {
      weight: number;
      scores: Record<string, number>;  // source_name -> score
      confirmation_bonus: number;
      max_confirmation_bonus: number;
    };
    filing_speed?: {
      weight: number;
      fast_bonus: number;      // <= 7 days
      slow_penalty: number;    // >= 30 days
    };
    cross_confirmation?: {
      weight: number;
      bonus_per_source: number;
      max_bonus: number;
    };
  };
}
```

### Sizing Configuration

```typescript
interface SizingConfig {
  mode: 'score_squared' | 'score_linear' | 'equal_split' | 'smart_budget';

  // For score-based modes
  base_multiplier?: number;  // e.g., 0.20 for score² × 20%
  base_amount?: number;      // e.g., $200 for $200 × score

  // For smart_budget mode (bucket-based allocation)
  bucket_config?: SmartBudgetConfig;

  // Constraints
  max_position_pct: number;
  max_position_amount: number;
  min_position_amount: number;
  max_open_positions: number;
  max_per_ticker: number;
}

// Smart budget uses bucket-based allocation based on congressional position size
interface SmartBudgetConfig {
  small: BucketStats;   // $1K-$15K congressional trades
  medium: BucketStats;  // $15K-$50K congressional trades
  large: BucketStats;   // $50K+ congressional trades
}

interface BucketStats {
  min_position_size: number;      // Min congressional $ for this bucket
  max_position_size: number;      // Max congressional $ (Infinity for unbounded)
  expected_monthly_count: number; // Avg trades/month in this bucket
  avg_congressional_size: number; // Avg congressional $ in this bucket
}
```

**Smart Budget Sizing Algorithm:**
1. Calculate total exposure per bucket: `count × avg_congressional_size`
2. Calculate budget ratio: `bucket_exposure / total_exposure`
3. Calculate per-trade amount: `(monthly_budget × ratio) / expected_count`

This ensures larger congressional trades get proportionally larger positions.

### Decision Reasons

```typescript
// Skip reasons for agent decisions (used in trades table 'decision' column)
type SkipReason =
  // Filter rejections
  | "filter_politician"      // Politician not in whitelist
  | "filter_ticker"          // Ticker not in whitelist
  | "filter_asset_type"      // Asset type not allowed
  | "filter_age"             // Signal too old
  | "filter_price_move"      // Price moved too much
  // Scoring rejections
  | "skip_score"             // Score below threshold
  // Budget/sizing rejections
  | "skip_budget"            // No budget remaining
  | "skip_size_zero"         // Position size calculated to $0
  | "skip_max_positions"     // At max open positions
  | "skip_max_ticker"        // At max positions per ticker
  // Sell signal rejections
  | "skip_no_position"       // No position to sell (no shorting)
  | "skip_position_young";   // Position < 1 year old

// Execute reasons
type ExecuteReason = "execute" | "execute_half" | "execute_sell";

// Display names for human-readable output (1-2 words)
const SKIP_REASON_DISPLAY: Record<SkipReason, string> = {
  filter_politician: "Wrong pol",
  filter_ticker: "Wrong ticker",
  filter_asset_type: "Wrong asset",
  filter_age: "Too old",
  filter_price_move: "Price moved",
  skip_score: "Low score",
  skip_budget: "No budget",
  skip_size_zero: "Size zero",
  skip_max_positions: "Max positions",
  skip_max_ticker: "Max ticker",
  skip_no_position: "No position",
  skip_position_young: "Too young",
};
```

### Exit Configuration

```typescript
interface ExitConfig {
  // Stop-loss
  stop_loss: {
    mode: 'fixed' | 'trailing';
    threshold_pct: number;
  };

  // Take-profit (optional)
  take_profit?: {
    first_threshold_pct: number;
    first_sell_pct: number;
    second_threshold_pct: number;
    second_sell_pct: number;
  };

  // Time-based
  max_hold_days: number | null;  // null = no limit

  // Soft stop (ChatGPT only)
  soft_stop?: {
    no_progress_days_stock: number;
    no_progress_days_option: number;
  };
}
```

---

## Agent Configurations (Final)

### ChatGPT ("Decay Edge")

```typescript
const chatgptConfig: AgentConfig = {
  id: 'chatgpt',
  name: 'Decay Edge',
  monthly_budget: 1000,

  politician_whitelist: null,  // All politicians
  allowed_asset_types: ['stock', 'etf', 'option'],

  max_signal_age_days: 45,
  max_price_move_pct: 25,

  scoring: {
    components: {
      time_decay: {
        weight: 0.30,
        half_life_days: 10,  // Simplified from 7/14 volatility-based
      },
      price_movement: {
        weight: 0.25,
        thresholds: {
          pct_0: 1.0,
          pct_5: 0.8,
          pct_15: 0.4,
          pct_25: 0.0,  // Hard skip
        },
      },
      position_size: {
        weight: 0.15,
        thresholds: [15000, 50000, 100000, 250000],
        scores: [0.2, 0.4, 0.6, 0.8, 1.0],
      },
      politician_skill: {
        weight: 0.20,
        min_trades_for_data: 20,
        default_score: 0.5,
      },
      source_quality: {
        weight: 0.10,
        scores: {
          'quiver_quant': 1.0,
          'capitol_trades': 0.9,
          'unusual_whales': 0.85,
          'default': 0.8,
        },
        confirmation_bonus: 0.05,
        max_confirmation_bonus: 0.15,
      },
    },
  },

  execute_threshold: 0.70,
  half_size_threshold: 0.55,  // REBALANCE at 0.55-0.69

  sizing: {
    mode: 'score_squared',
    base_multiplier: 0.20,
    max_position_pct: 0.20,
    max_position_amount: 200,
    min_position_amount: 50,
    max_open_positions: 5,
    max_per_ticker: 2,
  },

  exit: {
    stop_loss: {
      mode: 'fixed',
      threshold_pct: 18,
    },
    max_hold_days: 120,  // 90 for ETF, 30 for options
    soft_stop: {
      no_progress_days_stock: 30,
      no_progress_days_option: 10,
    },
  },
};
```

### Claude ("Decay Alpha")

```typescript
const claudeConfig: AgentConfig = {
  id: 'claude',
  name: 'Decay Alpha',
  monthly_budget: 1000,

  politician_whitelist: null,  // All politicians
  allowed_asset_types: ['stock', 'etf', 'option'],

  max_signal_age_days: 45,
  max_price_move_pct: 30,

  scoring: {
    components: {
      time_decay: {
        weight: 0.30,
        half_life_days: 14,
        use_filing_date: true,
        filing_half_life_days: 3,
      },
      price_movement: {
        weight: 0.35,
        thresholds: {
          pct_0: 1.2,   // Bonus for dip
          pct_5: 0.8,
          pct_15: 0.4,
          pct_25: 0.2,
        },
      },
      position_size: {
        weight: 0.15,
        thresholds: [50000, 100000, 250000, 500000],
        scores: [0.55, 0.60, 0.65, 0.70, 0.75],
      },
      politician_skill: {
        weight: 0.10,
        min_trades_for_data: 20,
        default_score: 0.5,
      },
      filing_speed: {
        weight: 0.05,
        fast_bonus: 0.05,
        slow_penalty: -0.10,
      },
      cross_confirmation: {
        weight: 0.05,
        bonus_per_source: 0.05,
        max_bonus: 0.15,
      },
    },
  },

  execute_threshold: 0.55,
  half_size_threshold: null,  // No half-size mode

  sizing: {
    mode: 'score_linear',
    base_amount: 200,
    max_position_pct: 0.25,
    max_position_amount: 250,
    min_position_amount: 50,
    max_open_positions: 10,
    max_per_ticker: 2,
  },

  exit: {
    stop_loss: {
      mode: 'fixed',
      threshold_pct: 15,
    },
    take_profit: {
      first_threshold_pct: 25,
      first_sell_pct: 50,
      second_threshold_pct: 40,
      second_sell_pct: 100,
    },
    max_hold_days: 120,
  },
};
```

### Gemini ("Titan Conviction")

```typescript
const geminiConfig: AgentConfig = {
  id: 'gemini',
  name: 'Titan Conviction',
  monthly_budget: 1000,

  politician_whitelist: [
    'Nancy Pelosi',
    'Mark Green',
    'Michael McCaul',
    'Ro Khanna',
    'Rick Larsen',
  ],
  allowed_asset_types: ['stock'],  // Stocks only

  max_signal_age_days: 45,
  max_price_move_pct: 15,

  scoring: null,  // No scoring - pass/fail only

  execute_threshold: 0,  // Any signal that passes filters = execute
  half_size_threshold: null,

  sizing: {
    mode: 'smart_budget',  // Budget allocation based on congressional position size
    bucket_config: {
      small:  { min: 1000,  max: 15000,    expected: 70, avg: 8000  },
      medium: { min: 15001, max: 50000,    expected: 25, avg: 32500 },
      large:  { min: 50001, max: Infinity, expected: 5,  avg: 100000 },
    },
    max_position_pct: 0.30,
    max_position_amount: 1000,
    min_position_amount: 5,
    max_open_positions: 20,
    max_per_ticker: 3,
  },

  exit: {
    stop_loss: {
      mode: 'trailing',
      threshold_pct: 20,
    },
    max_hold_days: null,  // No time limit
  },
};

// Gemini-specific: Consensus Core basket for dry spells
const geminiConsensusCore = {
  last_updated: '2026-01-01',
  tickers: [
    { ticker: 'NVDA', allocation_pct: 25 },
    { ticker: 'MSFT', allocation_pct: 25 },
    { ticker: 'AMZN', allocation_pct: 25 },
    { ticker: 'AAPL', allocation_pct: 25 },
  ],
};

// Gemini-specific: Reserve replacements
const geminiReserves = {
  democrat_replacement: 'Josh Gottheimer',
  republican_replacement: 'Kevin Hern',
};
```

---

## Database Schema

```sql
-- Agent configuration (stored as JSON for flexibility)
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config JSON NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Agent monthly budgets
CREATE TABLE agent_budgets (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  month TEXT NOT NULL,  -- 'YYYY-MM'
  total_budget REAL NOT NULL,
  spent REAL DEFAULT 0,
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  UNIQUE(agent_id, month)
);

-- Positions (unified across all agents)
CREATE TABLE positions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  shares REAL NOT NULL,
  entry_price REAL NOT NULL,
  entry_date TEXT NOT NULL,
  cost_basis REAL NOT NULL,
  highest_price REAL NOT NULL,  -- For trailing stops
  status TEXT DEFAULT 'open',   -- 'open', 'closed'
  closed_at TEXT,
  close_price REAL,
  close_reason TEXT,  -- 'stop_loss', 'take_profit', 'time_exit', 'soft_stop', 'sell_signal', 'manual'
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Trade decisions (full audit log)
CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  action TEXT NOT NULL,  -- 'buy', 'sell', 'skip'
  decision TEXT NOT NULL,  -- 'execute', 'execute_half', 'skip_filter', 'skip_score', 'skip_budget'

  -- Scoring (null for Gemini)
  score REAL,
  score_breakdown JSON,

  -- Execution details
  position_size REAL,
  shares REAL,
  executed_price REAL,

  -- Timestamps
  signal_received_at TEXT,
  decided_at TEXT,
  executed_at TEXT,

  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Politician statistics (shared)
CREATE TABLE politician_stats (
  name TEXT PRIMARY KEY,
  total_trades INTEGER DEFAULT 0,
  winning_trades INTEGER DEFAULT 0,
  win_rate REAL,
  avg_return REAL,
  last_updated TEXT
);

-- Agent performance snapshots
CREATE TABLE agent_performance (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  date TEXT NOT NULL,
  total_value REAL NOT NULL,
  total_cost_basis REAL NOT NULL,
  total_return_pct REAL NOT NULL,
  spy_return_pct REAL,  -- Benchmark
  positions_count INTEGER,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
```

---

## Core Algorithms

### 1. Signal Processing

```typescript
async function processSignal(signal: Signal): Promise<void> {
  const agents = await getActiveAgents();

  for (const agent of agents) {
    // Check if agent should process this signal
    if (!shouldAgentProcess(agent, signal)) {
      await logDecision(agent.id, signal.id, 'skip_filter', null);
      continue;
    }

    // Calculate score (if agent uses scoring)
    let score = null;
    let breakdown = null;
    if (agent.scoring) {
      const result = calculateScore(agent.scoring, signal);
      score = result.score;
      breakdown = result.breakdown;
    }

    // Make decision
    const decision = makeDecision(agent, signal, score);

    if (decision.action === 'execute' || decision.action === 'execute_half') {
      // Check budget
      const budget = await getAgentBudget(agent.id);
      if (budget.remaining < decision.position_size) {
        await logDecision(agent.id, signal.id, 'skip_budget', score, breakdown);
        continue;
      }

      // Execute trade
      await executeTrade(agent, signal, decision);
    }

    await logDecision(agent.id, signal.id, decision.action, score, breakdown);
  }
}

function shouldAgentProcess(agent: AgentConfig, signal: Signal): boolean {
  // Check politician whitelist
  if (agent.politician_whitelist &&
      !agent.politician_whitelist.includes(signal.politician_name)) {
    return false;
  }

  // Check asset type
  if (!agent.allowed_asset_types.includes(signal.asset_type)) {
    return false;
  }

  // Check signal age
  if (signal.days_since_trade > agent.max_signal_age_days) {
    return false;
  }

  // Check price movement
  if (Math.abs(signal.price_change_pct) > agent.max_price_move_pct) {
    return false;
  }

  return true;
}
```

### 2. Score Calculation

```typescript
function calculateScore(config: ScoringConfig, signal: Signal): {
  score: number;
  breakdown: Record<string, number>;
} {
  const breakdown: Record<string, number> = {};
  let totalWeight = 0;
  let weightedSum = 0;

  // Time decay
  if (config.components.time_decay) {
    const c = config.components.time_decay;
    let decay = Math.pow(0.5, signal.days_since_trade / c.half_life_days);

    if (c.use_filing_date && c.filing_half_life_days) {
      const filingDecay = Math.pow(0.5, signal.days_since_disclosure / c.filing_half_life_days);
      decay = Math.min(decay, filingDecay);
    }

    breakdown.time_decay = decay;
    weightedSum += decay * c.weight;
    totalWeight += c.weight;
  }

  // Price movement
  if (config.components.price_movement) {
    const c = config.components.price_movement;
    const pct = Math.abs(signal.price_change_pct) * 100;

    let score: number;
    if (pct <= 0) score = c.thresholds.pct_0;
    else if (pct <= 5) score = lerp(c.thresholds.pct_0, c.thresholds.pct_5, pct / 5);
    else if (pct <= 15) score = lerp(c.thresholds.pct_5, c.thresholds.pct_15, (pct - 5) / 10);
    else if (pct <= 25) score = lerp(c.thresholds.pct_15, c.thresholds.pct_25, (pct - 15) / 10);
    else score = 0;

    // Bonus for dip on buy signals
    if (signal.action === 'buy' && signal.price_change_pct < 0) {
      score = Math.min(score * 1.2, 1.2);
    }

    breakdown.price_movement = score;
    weightedSum += score * c.weight;
    totalWeight += c.weight;
  }

  // Position size
  if (config.components.position_size) {
    const c = config.components.position_size;
    const size = signal.position_size_min;

    let idx = 0;
    for (let i = 0; i < c.thresholds.length; i++) {
      if (size >= c.thresholds[i]) idx = i + 1;
    }

    breakdown.position_size = c.scores[idx];
    weightedSum += c.scores[idx] * c.weight;
    totalWeight += c.weight;
  }

  // Politician skill
  if (config.components.politician_skill) {
    const c = config.components.politician_skill;
    const stats = getPoliticianStats(signal.politician_name);

    let score = c.default_score;
    if (stats && stats.total_trades >= c.min_trades_for_data) {
      score = Math.max(0.4, Math.min(0.7, stats.win_rate));
    }

    breakdown.politician_skill = score;
    weightedSum += score * c.weight;
    totalWeight += c.weight;
  }

  // Source quality
  if (config.components.source_quality) {
    const c = config.components.source_quality;
    let score = c.scores[signal.source] ?? c.scores['default'];

    // Add confirmation bonus if signal seen from multiple sources
    const confirmations = getConfirmationCount(signal);
    if (confirmations > 1) {
      score += Math.min((confirmations - 1) * c.confirmation_bonus, c.max_confirmation_bonus);
    }

    breakdown.source_quality = score;
    weightedSum += score * c.weight;
    totalWeight += c.weight;
  }

  const finalScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

  return {
    score: Math.max(0, Math.min(1, finalScore)),
    breakdown,
  };
}
```

### 3. Position Sizing

```typescript
function calculatePositionSize(
  agent: AgentConfig,
  score: number | null,
  budget: { remaining: number },
  acceptedSignals: number  // For equal_split mode
): number {
  const sizing = agent.sizing;
  let size: number;

  switch (sizing.mode) {
    case 'score_squared':
      // ChatGPT: score² × 20% of budget
      size = Math.pow(score!, 2) * sizing.base_multiplier! * agent.monthly_budget;
      break;

    case 'score_linear':
      // Claude: $200 × score
      size = sizing.base_amount! * score!;
      break;

    case 'equal_split':
      // Gemini: divide budget equally among accepted signals
      size = agent.monthly_budget / acceptedSignals;
      break;
  }

  // Apply constraints
  size = Math.min(size, sizing.max_position_amount);
  size = Math.min(size, agent.monthly_budget * sizing.max_position_pct);
  size = Math.min(size, budget.remaining);
  size = Math.max(size, sizing.min_position_amount);

  return Math.floor(size * 100) / 100;  // Round to cents
}
```

### 4. Position Monitoring

```typescript
async function monitorPositions(): Promise<void> {
  const positions = await getOpenPositions();

  for (const position of positions) {
    const agent = await getAgent(position.agent_id);
    const currentPrice = await getQuote(position.ticker);

    // Update highest price (for trailing stops)
    if (currentPrice > position.highest_price) {
      await updateHighestPrice(position.id, currentPrice);
      position.highest_price = currentPrice;
    }

    const returnPct = (currentPrice - position.entry_price) / position.entry_price * 100;
    const dropFromHigh = (position.highest_price - currentPrice) / position.highest_price * 100;
    const daysHeld = daysBetween(position.entry_date, today());

    // Check stop-loss
    if (agent.exit.stop_loss.mode === 'fixed') {
      if (returnPct <= -agent.exit.stop_loss.threshold_pct) {
        await closePosition(position, 'stop_loss', currentPrice);
        continue;
      }
    } else if (agent.exit.stop_loss.mode === 'trailing') {
      if (dropFromHigh >= agent.exit.stop_loss.threshold_pct) {
        await closePosition(position, 'stop_loss', currentPrice);
        continue;
      }
    }

    // Check take-profit (Claude only)
    if (agent.exit.take_profit) {
      const tp = agent.exit.take_profit;
      if (returnPct >= tp.second_threshold_pct) {
        await closePosition(position, 'take_profit', currentPrice);
        continue;
      } else if (returnPct >= tp.first_threshold_pct) {
        // Partial sell - 50%
        await partialClose(position, tp.first_sell_pct / 100, 'take_profit', currentPrice);
        continue;
      }
    }

    // Check time exit
    if (agent.exit.max_hold_days && daysHeld >= agent.exit.max_hold_days) {
      await closePosition(position, 'time_exit', currentPrice);
      continue;
    }

    // Check soft stop (ChatGPT only)
    if (agent.exit.soft_stop) {
      const noProgressDays = position.asset_type === 'option'
        ? agent.exit.soft_stop.no_progress_days_option
        : agent.exit.soft_stop.no_progress_days_stock;

      if (daysHeld >= noProgressDays && returnPct <= 0) {
        await closePosition(position, 'soft_stop', currentPrice);
        continue;
      }
    }
  }
}
```

---

## Scheduled Jobs

| Job | Frequency | Description |
|-----|-----------|-------------|
| `process_signals` | Every 6 hours | Fetch new signals, run through all agents |
| `monitor_positions` | Every 15 min (market hours) | Check stop-loss, take-profit, time exits |
| `update_quotes` | Every 5 min (market hours) | Refresh price data for held positions |
| `update_politician_stats` | Daily (after market) | Recalculate win rates |
| `snapshot_performance` | Daily (after market) | Record portfolio values |
| `reset_budgets` | Monthly (1st) | Reset agent budgets to $1,000 |

---

## API Endpoints

### Agents

```
GET    /api/agents                    # List all agents
GET    /api/agents/:id                # Get agent details + config
GET    /api/agents/:id/portfolio      # Current positions
GET    /api/agents/:id/trades         # Trade history
GET    /api/agents/:id/performance    # Performance metrics
PATCH  /api/agents/:id/config         # Update agent config
```

### Signals

```
GET    /api/signals                   # List recent signals
GET    /api/signals/:id               # Signal details + how each agent scored it
POST   /api/signals/process           # Manually trigger signal processing
```

### Positions

```
GET    /api/positions                 # All open positions
POST   /api/positions/:id/close       # Manually close a position
```

### Admin

```
POST   /api/admin/reset-budgets       # Reset monthly budgets
POST   /api/admin/update-titan        # Update Gemini's Titan whitelist
POST   /api/admin/update-basket       # Update Gemini's Consensus Core basket
```

---

## Gemini Manual Configuration

### Titan Whitelist Update

When a Titan leaves office:

```typescript
// API call
POST /api/admin/update-titan
{
  "remove": "Nancy Pelosi",
  "add": "Josh Gottheimer",
  "reason": "Pelosi retired January 2026"
}
```

### Consensus Core Update

Semi-annually (Jan 1, Jun 1):

```typescript
// API call
POST /api/admin/update-basket
{
  "tickers": [
    { "ticker": "NVDA", "allocation_pct": 25 },
    { "ticker": "MSFT", "allocation_pct": 25 },
    { "ticker": "AMZN", "allocation_pct": 25 },
    { "ticker": "AAPL", "allocation_pct": 25 }
  ],
  "reason": "Q1 2026 Titan overlap analysis"
}
```

---

## Win Rate Calculation

A trade is **winning** if:

| Action | Condition | Timeframe |
|--------|-----------|-----------|
| BUY | Price ≥ trade_price × 1.05 | Within 90 days of disclosure_date |
| SELL | Price ≤ trade_price × 0.95 | Within 90 days of disclosure_date |

```typescript
async function updatePoliticianStats(): Promise<void> {
  const politicians = await getUniquePoliticians();

  for (const name of politicians) {
    const trades = await getTradesForPolitician(name, { minAge: 90 });

    let wins = 0;
    let total = 0;

    for (const trade of trades) {
      const priceAt90Days = await getHistoricalPrice(trade.ticker,
        addDays(trade.disclosure_date, 90));

      const change = (priceAt90Days - trade.trade_price) / trade.trade_price;

      if (trade.action === 'buy' && change >= 0.05) wins++;
      if (trade.action === 'sell' && change <= -0.05) wins++;
      total++;
    }

    await upsertPoliticianStats(name, {
      total_trades: total,
      winning_trades: wins,
      win_rate: total > 0 ? wins / total : null,
    });
  }
}
```

---

## Summary: What Each Agent Gets

| Feature | ChatGPT | Claude | Gemini |
|---------|---------|--------|--------|
| **Politicians** | All | All | 5 Titans |
| **Asset types** | Stock, ETF, Option | Stock, ETF, Option | Stock only |
| **Scoring** | 5-component weighted | 6-component weighted | None (pass/fail) |
| **Execute threshold** | 0.70 (0.55 half) | 0.55 | Any passing |
| **Position sizing** | score² × 20% | $200 × score | Smart budget (bucket-based) |
| **Max position** | $200 (20%) | $250 (25%) | 30% |
| **Stop-loss** | 18% fixed | 15% fixed | 20% trailing |
| **Take-profit** | None | 25%→50%, 40%→100% | None |
| **Time exit** | 120 days | 120 days | None |
| **Soft stop** | 30d no-progress | None | None |
| **Dry spell** | Skip | Skip | Consensus Core basket |

---

## Implementation Phases

### Phase 1: Core Infrastructure (Week 1)
- [ ] Database schema
- [ ] Agent configuration loader
- [ ] Signal ingestion from existing scraper

### Phase 2: Scoring Engine (Week 2)
- [ ] Unified scoring function
- [ ] All component calculators
- [ ] Decision logic

### Phase 3: Execution (Week 3)
- [ ] Position sizing
- [ ] Fidelity API integration
- [ ] Trade logging

### Phase 4: Monitoring (Week 4)
- [ ] Position monitor job
- [ ] Stop-loss / take-profit logic
- [ ] Budget tracking

### Phase 5: Dashboard (Week 5)
- [ ] Agent comparison view
- [ ] Position details
- [ ] Trade history
- [ ] Performance charts
