/**
 * Agent configuration constants
 * These are the default configurations as specified in FINAL_ENGINE_SPEC.md
 * They can be overridden by database values
 */

import type { AgentConfig } from "./types";

/**
 * ChatGPT Agent: "Decay Edge"
 * - All politicians
 * - 5-component weighted scoring
 * - score^2 sizing
 */
export const CHATGPT_CONFIG: AgentConfig = {
  id: "chatgpt",
  name: "Decay Edge",
  monthly_budget: 1000,

  politician_whitelist: null, // All politicians
  allowed_asset_types: ["stock", "etf", "option"],

  max_signal_age_days: 45,
  max_price_move_pct: 25,

  scoring: {
    components: {
      time_decay: {
        weight: 0.3,
        half_life_days: 10,
      },
      price_movement: {
        weight: 0.25,
        thresholds: {
          pct_0: 1.0,
          pct_5: 0.8,
          pct_15: 0.4,
          pct_25: 0.0,
        },
      },
      position_size: {
        weight: 0.15,
        thresholds: [15000, 50000, 100000, 250000],
        scores: [0.2, 0.4, 0.6, 0.8, 1.0],
      },
      politician_skill: {
        weight: 0.2,
        min_trades_for_data: 20,
        default_score: 0.5,
      },
      source_quality: {
        weight: 0.1,
        scores: {
          quiver_quant: 1.0,
          capitol_trades: 0.9,
          unusual_whales: 0.85,
          house_stock_watcher: 0.8,
          senate_stock_watcher: 0.8,
          default: 0.8,
        },
        confirmation_bonus: 0.05,
        max_confirmation_bonus: 0.15,
      },
    },
  },

  execute_threshold: 0.7,
  half_size_threshold: 0.55,

  sizing: {
    mode: "score_squared",
    base_multiplier: 0.2,
    max_position_pct: 0.2,
    max_position_amount: 200,
    min_position_amount: 50,
    max_open_positions: 5,
    max_per_ticker: 2,
  },

  exit: {
    stop_loss: {
      mode: "fixed",
      threshold_pct: 18,
    },
    max_hold_days: 120,
    soft_stop: {
      no_progress_days_stock: 30,
      no_progress_days_option: 10,
    },
  },
};

/**
 * Claude Agent: "Decay Alpha"
 * - All politicians
 * - 6-component weighted scoring with filing speed and cross-confirmation
 * - Linear sizing ($200 x score)
 */
export const CLAUDE_CONFIG: AgentConfig = {
  id: "claude",
  name: "Decay Alpha",
  monthly_budget: 1000,

  politician_whitelist: null,
  allowed_asset_types: ["stock", "etf", "option"],

  max_signal_age_days: 45,
  max_price_move_pct: 30,

  scoring: {
    components: {
      time_decay: {
        weight: 0.3,
        half_life_days: 14,
        use_filing_date: true,
        filing_half_life_days: 3,
      },
      price_movement: {
        weight: 0.35,
        thresholds: {
          pct_0: 1.2,
          pct_5: 0.8,
          pct_15: 0.4,
          pct_25: 0.2,
        },
      },
      position_size: {
        weight: 0.15,
        thresholds: [50000, 100000, 250000, 500000],
        scores: [0.55, 0.6, 0.65, 0.7, 0.75],
      },
      politician_skill: {
        weight: 0.1,
        min_trades_for_data: 20,
        default_score: 0.5,
      },
      filing_speed: {
        weight: 0.05,
        fast_bonus: 0.05,
        slow_penalty: -0.1,
      },
      cross_confirmation: {
        weight: 0.05,
        bonus_per_source: 0.05,
        max_bonus: 0.15,
      },
    },
  },

  execute_threshold: 0.55,
  half_size_threshold: null,

  sizing: {
    mode: "score_linear",
    base_amount: 200,
    max_position_pct: 0.25,
    max_position_amount: 250,
    min_position_amount: 50,
    max_open_positions: 10,
    max_per_ticker: 2,
  },

  exit: {
    stop_loss: {
      mode: "fixed",
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

/**
 * Naive Control Agent: "Monkey Trader"
 * - All politicians
 * - No scoring at all
 * - No timing filters (except very old signals)
 * - Buys everything it sees
 * - Control strategy to test if our algorithms add value
 */
export const NAIVE_CONFIG: AgentConfig = {
  id: "naive",
  name: "Monkey Trader",
  monthly_budget: 1000,

  politician_whitelist: null, // All politicians
  politician_scope_all: true,
  allowed_asset_types: ["stock", "etf", "option"],

  max_signal_age_days: 90, // Very permissive
  max_price_move_pct: 100, // No price filter

  scoring: null, // No scoring - just buy everything

  execute_threshold: 0, // Any signal = execute
  half_size_threshold: null,

  sizing: {
    mode: "equal_split",
    max_position_pct: 0.1,
    max_position_amount: 100,
    min_position_amount: 25,
    max_open_positions: 20,
    max_per_ticker: 1,
  },

  exit: {
    stop_loss: {
      mode: "fixed",
      threshold_pct: 20,
    },
    max_hold_days: null, // Hold forever (or until stop loss)
  },
};

/**
 * S&P 500 Benchmark Agent: "Index Investor"
 * - Only trades SPY (S&P 500 ETF)
 * - No scoring, just buys and holds
 * - Control strategy to compare against market return
 * NOTE: Requires SPY signals in data, or synthetic signal injection
 */
export const SPY_BENCHMARK_CONFIG: AgentConfig = {
  id: "spy_benchmark",
  name: "Index Investor",
  monthly_budget: 1000,

  politician_whitelist: null,
  politician_scope_all: true,
  allowed_asset_types: ["etf"],

  // Accept any ETF signal that's for SPY
  ticker_whitelist: ["SPY", "VOO", "IVV"], // S&P 500 ETFs

  max_signal_age_days: 365, // Very permissive
  max_price_move_pct: 100, // No price filter

  scoring: null, // No scoring

  execute_threshold: 0,
  half_size_threshold: null,

  sizing: {
    mode: "equal_split",
    max_position_pct: 1.0, // Put all money in
    max_position_amount: 1000,
    min_position_amount: 100,
    max_open_positions: 1,
    max_per_ticker: 1,
  },

  exit: {
    stop_loss: {
      mode: "fixed",
      threshold_pct: 50, // Very loose - basically never stop out
    },
    max_hold_days: null, // Hold forever
  },
};

/**
 * Gemini Agent: "Titan Conviction"
 * - 5 Titan politicians only
 * - No scoring (pass/fail filters only)
 * - Equal split sizing
 */
export const GEMINI_CONFIG: AgentConfig = {
  id: "gemini",
  name: "Titan Conviction",
  monthly_budget: 1000,

  politician_whitelist: [
    "Nancy Pelosi",
    "Mark Green",
    "Michael McCaul",
    "Ro Khanna",
    "Rick Larsen",
  ],
  allowed_asset_types: ["stock"],

  max_signal_age_days: 45,
  max_price_move_pct: 15,

  scoring: null, // No scoring - pass/fail only

  execute_threshold: 0, // Any signal that passes filters = execute
  half_size_threshold: null,

  sizing: {
    mode: "equal_split",
    max_position_pct: 0.3,
    max_position_amount: 1000,
    min_position_amount: 50,
    max_open_positions: 20,
    max_per_ticker: 3,
  },

  exit: {
    stop_loss: {
      mode: "trailing",
      threshold_pct: 20,
    },
    max_hold_days: null, // No time limit
  },
};

/**
 * All agent configs indexed by ID
 */
export const AGENT_CONFIGS: Record<string, AgentConfig> = {
  chatgpt: CHATGPT_CONFIG,
  claude: CLAUDE_CONFIG,
  gemini: GEMINI_CONFIG,
  naive: NAIVE_CONFIG,
  spy_benchmark: SPY_BENCHMARK_CONFIG,
};

/**
 * Primary trading agents (excludes benchmarks/controls)
 */
export const TRADING_AGENTS = [CHATGPT_CONFIG, CLAUDE_CONFIG, GEMINI_CONFIG];

/**
 * Control/benchmark agents for comparison
 */
export const CONTROL_AGENTS = [NAIVE_CONFIG, SPY_BENCHMARK_CONFIG];

/**
 * All agents for simulation
 */
export const ALL_AGENTS = [...TRADING_AGENTS, ...CONTROL_AGENTS];

/**
 * Gemini-specific: Consensus Core basket for dry spells
 */
export const GEMINI_CONSENSUS_CORE = {
  last_updated: "2026-01-01",
  tickers: [
    { ticker: "NVDA", allocation_pct: 25 },
    { ticker: "MSFT", allocation_pct: 25 },
    { ticker: "AMZN", allocation_pct: 25 },
    { ticker: "AAPL", allocation_pct: 25 },
  ],
};

/**
 * Gemini-specific: Reserve replacements for Titan succession
 */
export const GEMINI_RESERVES = {
  democrat_replacement: "Josh Gottheimer",
  republican_replacement: "Kevin Hern",
};
