**4\. Evaluation of Replication Strategies**

Given the constraints ($1,000/month) and the data, we evaluate three potential strategic architectures.

### **4.1 Strategy A: The "ETF Proxy" (NANC/KRUZ)**

The simplest approach is to buy the NANC (Democrat) and KRUZ (Republican) ETFs.

* **Pros:** Zero effort; automatic rebalancing; professional management.  
* **Cons:** 0.75% Fee.7 Dilution (holding 50+ stocks includes the losers). Lag (ETFs rebalance periodically, adding another layer of delay).  
* **Verdict:** **Rejected.** For a dedicated agent, we can beat the fee and the dilution by picking the top holdings directly.

### **4.2 Strategy B: The "Committee Arbitrage"**

A complex algorithmic approach that only buys stocks when a committee member of jurisdiction trades them.

* **Pros:** Highest theoretical "Insider" signal.16  
* **Cons:** Extremely low frequency (might go months without a signal). High technical debt (requires maintaining committee-to-ticker mapping).  
* **Verdict:** **Rejected.** Too brittle for a robust $1,000/month deployment.

### **4.3 Strategy C: The "Titan Conviction" (Selected)**

A concentrated portfolio tracking only the top 3-5 consistent outperformers (The "Whales").

* **Pros:** High signal-to-noise ratio. Manageable number of holdings (10-15 stocks). Lower transaction costs. Captures the "Celebrity Effect" (market follows Pelosi).  
* **Cons:** Concentration risk.  
* **Verdict:** **Selected.** This strategy aligns best with the goal of "Growth" and the constraint of limited capital. By using fractional shares, we can mimic a $10M portfolio with $1,000.

## ---

**5\. The $1,000/Month Implementation Challenge**

### **5.1 The Necessity of Fractional Shares**

The "Titan Conviction" portfolio will inevitably include high-priced assets. As of early 2026, stocks like Microsoft or specialized semiconductor firms may trade in the hundreds or thousands of dollars per share. A $1,000 deposit cannot buy a "round lot" (100 shares) or even 1 share of each target if the prices are high.

* **Solution:** The Implementation Agent must utilize a brokerage API supporting **Fractional Shares** (e.g., Interactive Brokers, Alpaca, Robinhood).19 This allows the agent to allocate *dollars* rather than *shares*.  
* **Allocation Math:** Instead of "Buy 1 share of NVDA," the instruction is "Allocate 20% of deposit ($200) to NVDA." This ensures precise portfolio weighting regardless of share price.

### **5.2 Latency Filters and "Chasing"**

To solve the 45-day lag problem identified in Section 2.1, the agent must implement a "Price Check" logic.

* **Logic:** If Current\_Price \> (Trade\_Price \* 1.15), the trade is "over-heated." The immediate alpha has been consumed by the market.  
* **Action:** Skip the trade, or place a "Limit Order" at the original entry price \+ 5%.  
* **Exception:** If the asset is a long-term "Core Holding" (e.g., Pelosi increasing her MSFT stake), the short-term price action is less relevant than the long-term thesis.

### **5.3 Risk Management: The "Copy Stop"**

Unlike Congress members, who may have net worths in the tens of millions and can afford to hold a position down 40% (e.g., Pelosi holding deep underwater positions in 2022 before the 2023 rally), a retail account needs protection.

* **The "Copy Stop Loss" (CSL):** Research on copy trading platforms (like eToro) suggests a CSL is vital. A **20% trailing stop** is recommended. It is wide enough to survive normal volatility (beta) but tight enough to prevent catastrophic loss if the legislative thesis fails or if a "Ban" bill suddenly forces a liquidation.21

## ---

**6\. Regulatory Horizon: The "Kill Switch"**

A significant external risk to this strategy is the potential for legislative reform. Bipartisan support for banning Congressional stock trading is at an all-time high (86% public support).11 Various bills (The PELOSI Act, The ETHICS Act) have been introduced to force members into blind trusts.11

* **Impact:** If passed, the data feed of disclosures will cease. The "Copy Congress" strategy will effectively go dark.  
* **Contingency:** The agent must monitor for the passage of such legislation. If the data feed dries up (e.g., zero trades for 60 days), the agent must have a protocol to transition the portfolio into a passive index strategy (e.g., 50% QQQ / 50% SPY) to preserve capital growth without the active signal.

## ---

**7\. Strategic Synthesis: The "Titan Conviction" Algorithm**

Based on the exhaustive research above, the optimal path forward is the **Titan Conviction** strategy. It blends the aggressive growth of the Democratic tech leadership with the industrial resilience of Republican energy traders, filtered through strict volume and latency checks.  
**The "Magic Numbers" applied:**

1. **Selection Threshold:** Only members with \>$5M annual volume and \>15% annual alpha over SPY. (Result: Pelosi, Green, McCaul, Khanna).  
2. **Allocation Split:** 70% to "New Signals" (last 30 days), 30% to "Core Titans" (accumulating the winners).  
3. **Risk Controls:** 15% Latency Filter (don't chase), 20% Trailing Stop (don't bag hold).

This approach turns the "bug" of the system (opaque, high-volume insider trading) into a "feature" (a high-conviction alternative data signal).  
---

**(The following section constitutes the "Final Instruction Document" as requested, stripped of the academic prose and formatted for direct implementation by the agent.)**

# **FINAL INSTRUCTION DOCUMENT: THE "TITAN CONVICTION" PROTOCOL**

To: Implementation Agent  
Subject: Operational Instructions for $1,000/Month Congressional Copy-Trading Strategy  
Strategy Codename: TITAN\_ALPHA\_V1

## **1\. Objective**

Execute a systematic, long-only equity accumulation strategy that replicates the high-conviction trades of specific U.S. Congress members ("Titans"). The goal is to maximize capital growth by leveraging the information asymmetry and legislative foresight of these individuals.

## **2\. Configuration Parameters**

### **2.1 The Watchlist (The "Titans")**

You are restricted to tracking **only** the following 5 entities. Ignore all other disclosures.

1. **Nancy Pelosi (D-CA):** \- *Primary Growth Signal*  
2. **Mark Green (R-TN):** \- *Primary Value Hedge*  
3. **Michael McCaul (R-TX):** \- *Secondary Growth*  
4. **Ro Khanna (D-CA):** \- *Volume Confirmation*  
5. **Rick Larsen (D-WA):** \- *Strategic Diversifier* (Note: Replaces Brian Higgins/retirees).

### **2.2 Financial Constraints**

* **Monthly Inflow:** $1,000.00 (USD).  
* **Execution Type:** **Fractional Shares ONLY**. Do not attempt to buy whole lots.  
* **Cash Drag:** Target 0% cash (Fully invested), unless no signals pass filters.

## **3\. Operational Logic (The Algorithm)**

Run this logic cycle **Monthly** upon receipt of funds (e.g., 1st of the month).

### **Phase 1: Signal Acquisition & Filtration**

Query the disclosure database (source: Quiver Quant/Capitol Trades API) for the "Titans" over the last 45 days.  
For each disclosed transaction:

1. **Asset Class Check:** IF Type\!= "Stock" (e.g., Option, Bond, PDF-unreadable), **DISCARD**.  
2. **Direction Check:**  
   * IF Transaction \== "Sale": **SELL** position immediately if held in portfolio.  
   * IF Transaction \== "Purchase": Proceed to Phase 2\.

### **Phase 2: The "Alpha Gate" (Latency Check)**

For each potential "Purchase" signal:

1. Identify Trade\_Date and Disclosure\_Date.  
2. Fetch Entry\_Price (Price on Trade\_Date) and Current\_Market\_Price.  
3. Calculate Delta \= (Current\_Market\_Price \- Entry\_Price) / Entry\_Price.  
4. **Rule:**  
   * IF Delta \> \+0.15 (Price is up \>15% since they bought): **REJECT** (Signal is overheated).  
   * IF Delta \<= \+0.15: **ACCEPT** (Add to Buy List).

### **Phase 3: Capital Allocation**

1. **Distribute Funds:** Divide the $1,000 inflow equally among the **ACCEPTED** Buy Signals.  
   * *Example:* 4 valid signals found \-\> $250 allocated to each.  
2. **The "Dry Spell" Exception:** IF no new signals pass the filter:  
   * Allocate 100% of funds to the **"Core Titan Basket"**:  
     * 30% **NVDA** (NVIDIA)  
     * 30% **MSFT** (Microsoft)  
     * 20% **ET** (Energy Transfer)  
     * 20% **AAPL** (Apple)

### **Phase 4: Risk Management (The "Safety Net")**

1. **Trailing Stop Loss:** Set a **20% Trailing Stop** on ALL positions.  
   * *Trigger:* If asset price drops 20% from its highest point since purchase \-\> **SELL MARKET**.  
2. **Max Concentration:** Soft cap of 30% of Total Portfolio Value in any single ticker. If a holding exceeds 30%, do not allocate new funds to it; redirect to under-weight positions.

## **4\. Maintenance Protocols**

* **Quarterly Review:** Verify the "Titans" are still in office. If a Titan retires or resigns, halt buying their signals and await manual update of the Watchlist.  
* **Regulatory Kill Switch:** If the U.S. Congress passes a ban on individual stock trading (e.g., "PELOSI Act"), immediately cease all copying. Liquidate portfolio and convert 100% of capital to **QQQ (Invesco QQQ Trust)**.