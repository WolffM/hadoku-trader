Below is a **final, opinionated instruction document**.
I am deliberately collapsing this into **one unified strategy**, not six. Multiple strategies add surface area, capital fragmentation, and overfitting risk — especially with **$1,000/month**, which is *small enough that precision matters more than diversification theater*.

What follows is the **single strategy Hadoku should run**, with concrete numbers, clear logic, and no ambiguity.

---

# HADOKU FINAL TRADING STRATEGY

**“Decay-Adjusted Congressional Edge Extraction”**

## Capital Context

* Monthly capital: **$1,000**
* Goal: outperform passive market exposure without overtrading
* Constraint: delayed, noisy information with uneven quality

**Conclusion:**
Run **one strategy**, executed **selectively**, sized dynamically.
Do *not* split into multiple sub-strategies.

---

## Core Thesis (One Sentence)

> Trade congressional disclosures **only when the remaining informational edge is statistically plausible after adjusting for time decay, price movement, and signal quality**.

Everything below serves this sentence.

---

## Strategy Inputs (Required Data Only)

Each signal is evaluated using **exactly five inputs**:

1. **Signal Freshness**
2. **Price Movement vs Volatility**
3. **Trade Conviction (Size & Asset Type)**
4. **Politician Skill**
5. **Source Quality**

No macro, no sector logic, no party weighting.

---

## Step 1: Signal Freshness (Primary Gate)

### Magic Numbers

* Max allowable staleness: **45 days**
* Half-life:

  * **14 days** (low volatility)
  * **7 days** (high volatility ≥ 2.5% daily STD)

### Rule

* If trade is **>45 days old → SKIP**
* Otherwise compute freshness score:

> Fresh signals decay exponentially; volatile tickers decay twice as fast.

**Why this dominates:**
If the signal is stale, nothing else matters.

---

## Step 2: Price Movement vs Remaining Edge

### Magic Numbers

* Hard skip if:

  * **Buy** and price is **+25%** since politician entry
  * **Sell** and price is **–25%** since entry
* Volatility-normalized movement thresholds:

  * ≤ **0.5σ** → full credit
  * **0.5–1.0σ** → moderate credit
  * **1.0–1.5σ** → weak credit
  * > **1.5σ** → near zero

### Rule

> If the market has already realized most of the move, the edge is gone.

**Interpretation:**
We are not momentum traders. We are late information traders who must avoid chasing.

---

## Step 3: Trade Conviction (Capital at Risk)

### Magic Numbers (Minimum Disclosed Size)

| Size       | Score |
| ---------- | ----- |
| < $15k     | 0.2   |
| $15k–50k   | 0.4   |
| $50k–100k  | 0.6   |
| $100k–250k | 0.8   |
| > $250k    | 1.0   |

### Asset Modifier

* Stock: ×1.0
* ETF: ×0.8
* Option: ×1.2 (but faster decay)

**Why:**
Size is the cleanest proxy for true belief.

---

## Step 4: Politician Skill (Long-Run Edge)

### Magic Numbers

* Market baseline win rate: **52%**
* Minimum trustable history: **20 trades**
* Skill weighting favors:

  * Higher win rate
  * Longer track record
  * Recent performance

### Rule

> Skill compounds. Incompetence persists.

No politician gets zero weight. No politician gets blind trust.

---

## Step 5: Source Quality & Confirmation

### Baseline Scores

| Source         | Score |
| -------------- | ----- |
| Quiver Quant   | 1.0   |
| Capitol Trades | 0.9   |
| Unusual Whales | 0.85  |
| Watcher Sites  | 0.8   |

### Confirmation Bonus

* **+0.05 per extra independent source**
* Max bonus: **+0.15**

**Note:**
Confirmation reduces noise — it does *not* create alpha.

---

## Final Scoring (Single Composite)

### Weighting (Locked for v1)

* Freshness: **30%**
* Price movement: **25%**
* Position size: **15%**
* Politician skill: **20%**
* Source quality: **10%**

### Final Score Range

* 0.0 → no edge
* 1.0 → very strong remaining edge

---

## Action Rules (Non-Negotiable)

| Final Score   | Action                     |
| ------------- | -------------------------- |
| **≥ 0.70**    | EXECUTE                    |
| **0.55–0.69** | REBALANCE (small position) |
| **< 0.55**    | SKIP                       |

**Expected behavior:**
Only **10–30%** of signals execute.

---

## Capital Allocation (With $1,000)

### Position Size Formula

> Allocation % = (Final Score)² × 20%

Examples:

* Score 0.75 → ~11% ($110)
* Score 0.85 → ~14% ($140)
* Score 0.95 → ~18% ($180)

### Constraints

* Max single trade: **20%**
* Max concurrent positions: **5**
* If >5 qualify → take top 5 scores only

---

## Why One Strategy Wins Here

* $1,000/month cannot support:

  * Frequent trading
  * Strategy fragmentation
  * Correlated bets
* Congressional signals are **already niche** — splitting them further reduces power.
* One high-discipline strategy:

  * Learns faster
  * Fails cleaner
  * Is easier to tune

---

## Final Instruction to the Agent (Plain English)

> “Trade only when a congressional disclosure is fresh, not already priced in, backed by meaningful capital, produced by a historically competent politician, and confirmed by reliable sources. Size positions by confidence, not excitement. Skip everything else.”

That’s the system.