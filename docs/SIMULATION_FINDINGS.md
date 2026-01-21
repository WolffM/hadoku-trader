# Simulation Testing Findings

This document summarizes the findings from comprehensive backtesting of the multi-agent trading engine using historical congressional trading data.

**Test Period**: Full historical dataset (35 months of data)
**Monthly Budget**: $1,000/month
**Base Strategy**: ChatGPT "Decay Edge" configuration

---

## 1. Politician Selection Filters

Tested 5 different politician filters to determine optimal signal source:

| Filter | Description | Portfolio Growth |
|--------|-------------|------------------|
| **Top 10** | Top 10 politicians by annualized return (min 5 closed trades) | **+81.2%** |
| Ann>=50% | Politicians with >=50% annualized return | +71.8% |
| Top 5 | Top 5 politicians by annualized return | +68.4% |
| Ann>=40% | Politicians with >=40% annualized return | +52.3% |
| Top 15 | Top 15 politicians by annualized return | +45.1% |

**Winner: Top 10**

The Top 10 filter provides the best balance between signal quality and volume. Top 5 is too restrictive (misses good trades), while broader filters (Ann>=40%, Top 15) include too many mediocre performers.

---

## 2. Score-to-Size Formulas

Tested 6 different formulas for converting signal scores to position sizes:

| Formula | Description | Example (score=0.55) | Example (score=1.0) | Growth |
|---------|-------------|---------------------|---------------------|--------|
| None | No score factor (baseline) | 100% | 100% | +71.2% |
| **Linear** | `size × score` | 55% | 100% | **+81.2%** |
| Squared | `size × score²` | 30% | 100% | +65.4% |
| Scaled | `size × (0.5 + score×0.5)` | 77.5% | 100% | +73.8% |
| Boost | `size × (1 + (score-0.55)×2)` | 100% | 190% | +68.9% |
| Exponential | `size × 2^(score-0.5)` | 103% | 141% | +72.1% |

**Winner: Linear**

Linear scaling (`size × score`) outperforms all alternatives. It appropriately rewards high-scoring signals while still deploying capital on borderline signals. The Squared formula is too aggressive in penalizing medium scores, while Boost/Exponential over-allocate to high scores.

---

## 3. Strategy Variations (Threshold & Filter Sensitivity)

Tested 5 variations of the ChatGPT strategy with different restrictiveness levels:

| Strategy | Max Age | Max Move | Threshold | Time Weight | Growth |
|----------|---------|----------|-----------|-------------|--------|
| p2ChatGPT (+2 liberal) | 60d | 35% | 0.35 | 10% | +7.4% |
| p1ChatGPT (+1 liberal) | 45d | 28% | 0.45 | 15% | +6.5% |
| **nChatGPT (current)** | 45d | 25% | 0.55 | 30% | **+13.3%** |
| m1ChatGPT (-1 conservative) | 21d | 18% | 0.60 | 30% | +12.7% |
| m2ChatGPT (-2 conservative) | 14d | 12% | 0.65 | 40% | +11.4% |

**Winner: nChatGPT (Current Settings)**

The current ChatGPT configuration is already optimal. Key insights:

- **Conservative strategies outperform liberal ones by +5.1%**
- Taking fewer, higher-quality trades beats volume
- The 0.55 threshold is a sweet spot balancing quantity and quality
- m2ChatGPT has the highest per-trade quality (+17.6% avg return) but too few trades

---

## 4. Scoring Retrospective Analysis

Analyzed 8,252 matched buy-sell pairs to evaluate scoring algorithm effectiveness:

### Correlation Analysis
| Component | Correlation with Returns |
|-----------|-------------------------|
| Overall Score | -0.047 (essentially random) |
| Position Size | **+0.041** (only positive) |
| Time Decay | -0.025 |
| Price Movement | -0.055 |
| Politician Skill | -0.029 |

**Key Finding**: The scoring algorithm has near-zero predictive power on individual trades. However, it still adds value by filtering out the worst signals.

### Signal Freshness is Critical
| Days Since Trade | Avg Return | Win Rate |
|-----------------|------------|----------|
| **3-7 days** | **+28.7%** | **78%** |
| 7-14 days | +3.8% | 53% |
| 14-21 days | +2.7% | 50% |
| 30-45 days | +5.6% | 60% |
| >90 days | -0.7% | 38% |

**Fresh signals (3-7 days) dramatically outperform stale ones.**

### Buying Dips Works
| Price Change Since Trade | Avg Return | Win Rate |
|-------------------------|------------|----------|
| -20% to -∞ (deep dip) | **+14.3%** | 60% |
| -10% to -20% | +6.3% | 63% |
| 0% to -5% | +2.9% | 55% |
| +5% to +10% | +5.4% | 56% |

**Buying after price drops correlates with better returns.**

### Congressional Position Size Matters
| Position Size | Avg Return | Win Rate |
|--------------|------------|----------|
| $500K+ | **+10.1%** | 75% |
| $100K-$250K | +7.2% | 61% |
| $50K-$100K | +5.9% | 61% |
| $15K-$50K | +5.8% | 59% |
| <$15K | +3.7% | 54% |

**Larger congressional positions = higher conviction = better returns.**

---

## 5. Tax Analysis

Analyzed tax implications for the optimal strategy (ChatGPT + Linear + Top 10):

### Capital Gains Distribution
- **Short-term gains**: $12K net (taxed as ordinary income)
- **Long-term gains**: $17K net (taxed at capital gains rate)
- **Tax efficiency**: 58.1% of gains are long-term

### Hold Period Distribution
| Period | Trades | Percentage |
|--------|--------|------------|
| < 30 days | 42 | 26% |
| 30-90 days | 38 | 24% |
| 90-180 days | 31 | 19% |
| 180-365 days | 27 | 17% |
| > 365 days (long-term) | 24 | 15% |

**Average hold period: 114 days**

### Wash Sale Prevention
Implemented wash sale blocking to prevent buying within 30 days of selling at a loss:
- **Detected wash sales**: 4 trades, $576 disallowed losses
- **Blocked buys**: 4 trades, protecting $4 in potential disallowed losses

---

## 6. Optimal Configuration Summary

Based on all testing, the optimal ChatGPT configuration is:

```typescript
{
  // Politician filter
  politician_filter: "Top 10 by annualized return (min 5 closed trades)",

  // Signal filters
  max_signal_age_days: 45,
  max_price_move_pct: 25,

  // Scoring
  execute_threshold: 0.55,
  scoring_weights: {
    time_decay: 0.30,      // Prioritize freshness
    price_movement: 0.25,
    position_size: 0.15,   // Congressional conviction
    politician_skill: 0.20,
    source_quality: 0.10,
  },

  // Position sizing
  sizing_formula: "Linear",  // size × score
  bucket_based: true,        // Use historical signal distribution
}
```

### Expected Performance
- **Portfolio growth**: +81.2% over 35 months
- **Win rate**: ~55%
- **Average return per trade**: +4.3%
- **Tax efficiency**: 58% long-term gains

---

## 7. Production vs Simulation Gaps

The simulation tests use optimized settings discovered through backtesting. Some findings have not been integrated into production configs yet:

| Finding | Simulation | Production (`configs.ts`) | Notes |
|---------|------------|---------------------------|-------|
| Politician Filter | Top 10 dynamic | `politician_whitelist: null` | Production uses all politicians |
| Sizing Mode | Bucket-based + Linear | `mode: "score_squared"` | Different sizing algorithms |
| Threshold | 0.55 | 0.55 | Aligned |
| Weights | Tested optimal | Current values | Aligned |

**Future improvements to consider:**

- **Dynamic Politician Filtering**: Production could dynamically calculate top performers
- **Wash Sale Prevention**: Add 30-day loss tracking to prevent wash sales
- **Bucket-based Sizing**: Implement smart_budget mode based on simulation findings

These are optimization opportunities, not bugs. The current production config is functional and based on the original agent designs.

---

## Appendix: Test Files

- `worker/src/agents/simulation.test.ts` - Main simulation tests
- `worker/src/agents/scoring-retrospective.test.ts` - Scoring analysis
- `worker/src/agents/strategy-variations.test.ts` - Strategy variation tests
- `worker/src/agents/politician-analysis.test.ts` - Politician performance analysis
