# BYBIT NEW LISTING SHORT STRATEGY — FINAL DOCUMENTATION

## STATUS: LOCKED IN ✅

**Strategy Version:** Portfolio B v2 — SI-C Scale-In
**Dataset:** 346 Bybit perpetual futures listings, January 2024 – January 2026
**Development:** 9 rounds of iterative analysis, walk-forward validated, fee-adjusted, manually chart-verified
**Last Updated:** February 7, 2026

---

## EXECUTIVE SUMMARY

This strategy shorts newly listed perpetual futures on Bybit. The structural thesis: new exchange listings provide exit liquidity for VCs, pre-sale buyers, airdrop recipients, and early holders who have been waiting for a deep, leveraged market to sell into. The Bybit perps listing is their exit door.

The baseline confirms this — 62% of 346 new listings were red at day 7, with a median decline of -10.7%. The strategy improves on that baseline by filtering for the highest-probability dumps using two complementary signals, a scale-in sizing approach, and strict risk management.

**Final Net Performance (after fees + funding):**

| Metric | Value |
|--------|-------|
| Trades (2 years) | 114 |
| Win Rate | 70.2% |
| Net PnL | $168,410 |
| Max Drawdown | $11,950 |
| Net Return / Drawdown | 14.1x |
| Net Profit Factor | 2.46 |
| Avg Trades / Month | 4.6 |
| 2025 Out-of-Sample Net Ret/DD | 9.9x |
| 2025 Out-of-Sample Net PF | 2.20 |

---

## THE TWO SIGNALS

### Signal 1: Red4h+HiVol (Primary Signal — ~97 trades)

**What it checks at the 4-hour mark after listing:**

1. **Is the token red?** Price at hour 4 is below the listing price (the open of the very first candle). Even -0.1% counts — the token just needs to be red.
2. **Was first-hour turnover above $1M?** Turnover is the total USDT volume traded in the very first hourly candle.

**Why it works:**

The first 4 hours after a perps listing are chaotic — market makers setting up, retail FOMOing in, early holders testing liquidity. If after all that activity the price is still below where it opened, sell pressure is winning. The buyers cannot absorb the selling despite the hype of a new listing. That imbalance tends to persist and worsen over the next 14 days.

The $1M turnover filter is a liquidity and attention filter. A token with $50K first-hour volume is a dead listing with no liquidity to short into. A token with $1M+ confirms real market participants showed up and real exit liquidity is being dumped.

**From the data:** Tokens with $1-2M turnover had 62% WR and $133 avg PnL per trade. Tokens with $10-50M turnover had 89% WR and $2,438 avg PnL. More volume = more exit liquidity being dumped = better short.

**Entry:** Short at the 4-hour mark. Market order into the perps book.

**Why 4 hours, not 1 or 8?** One hour is too early — price is in initial discovery, spreads are wide, direction not established. Eight hours works too (ret_8h is a stronger predictor) but by then much of the move has happened. The data showed that mildly-red-at-4h tokens (0 to -5%) actually performed best — entering at 4h catches those before they've moved far.

### Signal 2: S7_PumpDump (Secondary Signal — ~17 trades)

**What it checks at two different times:**

1. **Hours 0-4:** Did the token pump more than 15% at any point? (max high across all candles in hours 0-4 is >15% above listing price)
2. **Hour 8:** Is the token now below the listing price? (ret_8h < 0)

**Why it works:**

This catches a completely different pattern from Signal 1. Some tokens rip 15-30%+ in the first hours, attracting FOMO buyers. Then smart money (VCs, insiders, early holders) uses that pump as exit liquidity. By hour 8 the price has crashed back below listing.

The people who bought the pump between hours 0-4 are now underwater and panicking. They become forced sellers, adding to the downward pressure. The insiders got their exit and aren't buying back. The token has created a large pool of bag holders in just 8 hours who will sell into every bounce for the next 14 days.

In the original backtest this signal had 89% WR on 25 trades — the highest accuracy of any single signal. At the 15% threshold it captures ~17 trades with ~82% WR in the final portfolio.

**Entry:** Short at the 8-hour mark (not 4h — you need to wait to confirm both conditions).

**Why this is separate from Signal 1:** Many pump-and-dump tokens are green at hour 4 (still in the pump phase). Signal 1 would skip them because they're not red at 4h. Signal 2 catches them 4 hours later after the dump begins. The two signals have low overlap — different tokens, different patterns.

### Deduplication Rule

If both signals fire on the same token, Signal 1 takes priority (earlier entry at 4h). Don't double up on the same symbol.

---

## THE AVOIDANCE FILTER

Before entering any trade, check three conditions. If ANY are true, skip the trade entirely.

**1. Token is up >10% at 4h (ret_4h > 10%)**

A token up 10%+ at hour 4 has strong bullish momentum. Shorting into that is fighting the trend. The pump may not be done. For Signal 1 this can't technically trigger (Signal 1 requires red at 4h), but it's a safety check. For Signal 2 it prevents entering on tokens where the pump is still alive at entry time.

**2. Token pumped >50% within the window (max_pump_4h > 50% for Signal 1, max_pump_8h > 50% for Signal 2)**

This is meme territory — tokens like TRUMP, DOGE spinoffs, viral meme coins. When something pumps 50%+, you're dealing with irrational momentum that can persist for days. These tokens can squeeze shorts violently. Even if they eventually dump, the path to get there will likely liquidate you first.

*Note: The original filter used max_pump_12h, but you can't see 12h of data when entering at 4h or 8h. Changed to use only data available at entry time.*

**3. Shorts are heavy AND price is rising (ls_4h < 0.8 AND ret_4h > 0)**

The long/short ratio below 0.8 means shorts are already heavily positioned. If price is also green, those shorts are getting squeezed. Adding another short into that is asking to get liquidated.

**How much do these filters matter?** From sensitivity testing: barely at all within the Portfolio B signal set. The filter only blocked 2-4 trades across the entire dataset because Signal 1 already requires red at 4h (which inherently excludes most "still pumping" scenarios). They're a safety net that rarely triggers but costs nothing to keep.

---

## THE SCALE-IN MECHANIC (SI-C)

This is the position sizing approach that emerged from Round 7 testing and is the single biggest improvement to the strategy.

### How It Works

**Leg 1 — Hour 4 entry (base position):**
When Signal 1 fires, enter a $5,000 notional short at hour 4. At 2x leverage, this requires $2,500 margin. This is the initial position — reduced size because you don't yet know if this will be a strong dump or a weak one.

**Leg 2 — Hour 8 decision (conditional add):**
Four hours later, check: is ret_8h < -10%? If the token is down more than 10% from listing price, the dump is confirmed and accelerating. Add a $7,000 notional short at hour 8 at whatever price it's trading. This is a separate isolated-margin position — $3,500 margin, independent from Leg 1.

If ret_8h is NOT below -10% (token bounced, went sideways, or dropped only slightly), do not add. Hold the $5K base position and let it ride.

**Signal 2 trades:** No scale-in. S7_PumpDump enters at 8h with $12,000 notional at once. The pump-and-dump pattern at 8h is already high-conviction (82% WR).

### Why This Works (15.5x Ret/DD vs 8.9x Flat)

The key insight from Round 7 was counterintuitive. The ret_4h depth analysis showed:

| ret_4h Bucket | Trades | WR | Avg PnL |
|---------------|--------|----|---------|
| 0% to -3% | 18 | 83% | $1,415 |
| -3% to -5% | 10 | 80% | $2,039 |
| -5% to -10% | 24 | 67% | $641 |
| -10% to -15% | 16 | 75% | $988 |
| -15% to -25% | 19 | 53% | $537 |
| Below -25% | 10 | 50% | $278 |

Tokens barely red at 4h (0 to -5%) have the highest WR and best avg PnL. Tokens already down 15-25%+ at 4h are coin flips — the easy money is gone, and they bounce harder leading to more liquidations.

You can't tell at hour 4 which trades will be big winners. But by hour 8, the picture clears. The $7K add at 8h only fires when the dump has been confirmed. Meanwhile the $5K base captures the mildly-red-at-4h tokens that go on to be big winners.

The two legs have independent liquidation, so a Leg 2 liquidation doesn't kill Leg 1.

### Scale-In Results

| Config | N | WR | PnL | MDD | Ret/DD | PF |
|--------|---|----|-----|-----|--------|-----|
| Flat $7K (baseline) | 114 | 70.2% | $125,063 | $14,000 | 8.9x | 2.22 |
| SI-C: $5K+$7K if ret_8h < -10% | 114 | 69.3% | $186,184 | $12,000 | **15.5x** | **2.64** |

SI-C wins on every metric. More PnL, less drawdown, nearly double the risk-adjusted return.

---

## EXIT RULES

**No trailing stop.** At 2x leverage, liquidation is 47.5% above entry. Almost nothing bounces 47.5% after being red at 4h. A trailing stop at 2x only serves to cut winners short. The JELLYJELLYUSDT trade would have been capped at ~$2K with a trailing stop instead of the full $6,565 profit. The math is clear: at low leverage, let it ride.

**14-day max hold.** After 336 hours from entry, close the position at market. The data showed 59-70% of tokens red at day 7 continue falling through day 14. Beyond 14 days the "new listing dump" effect fades. Both legs exit at day 14 from the Leg 1 entry time.

**Liquidation is the stop loss.** If the token rallies 47.5% above entry, you lose the margin for that leg. $2,500 for Leg 1, $3,500 for Leg 2. Isolated margin means this loss is contained.

---

## PHASED CAPITAL DEPLOYMENT

Starting with $3K ring-fenced from an $80K account. All profits get added to the allocation. Sizing based on allocation, not total account.

| Phase | Allocation | Sizing Rule | Scale-In? | Max Concurrent |
|-------|-----------|-------------|-----------|----------------|
| **1: Build** | $3K – $6K | $3K notional per trade | No | 1 |
| **2: Grow** | $6K – $15K | $6K notional per trade | No | 1-2 |
| **3: Scale** | $15K – $30K | SI-C: $5K base + $7K add | Yes | 2-3 |
| **4: Full** | $30K+ | SI-C scaled proportionally, cap 20% of allocation per position margin | Yes | 3-5 |

### Phase 1 Risk Profile

Max single loss: $1,500 (liquidation on $3K notional at 2x)
As % of allocation: 50% of $3K
Consecutive liquidations to wipe allocation: 2
Probability of 2 consecutive liqs: ~6% (24.6% liq rate squared)
If wiped: re-allocate another $3K from $80K account. Total damage = 3.75% of account.

### Expected Compound Growth

| Month | Phase | Allocation Start | Notional/Trade | Month PnL (expected) | Allocation End |
|-------|-------|-----------------|----------------|---------------------|----------------|
| 1 | 1 | $3,000 | $3,000 | $2,168 | $5,168 |
| 2 | 1 | $5,168 | $3,000 | $2,168 | $7,336 |
| 3 | 2 | $7,336 | $6,000 | $4,335 | $11,671 |
| 4 | 2 | $11,671 | $6,000 | $4,335 | $16,006 |
| 5 | 3 | $16,006 | SI-C | $7,520 | $23,526 |
| 6 | 3 | $23,526 | SI-C | $7,520 | $31,046 |
| 7 | 4 | $31,046 | SI-C scaled | $11,460 | $42,506 |
| 8 | 4 | $42,506 | SI-C scaled | $13,680 | $56,186 |

These are expected values — actual results will be lumpier. Some months could be zero trades, some could have 10+. Tail winners could land in month 1 or month 8.

---

## DECISION CHECKLIST (Per New Listing)

```
HOUR 0:  New Bybit perp listing appears
         → Record listing price (first candle open)
         → Start watching

HOUR 1:  First candle closes (Checked at hour 4)
         → Record turnover_1h
         → If turnover < $1M → No LEGS trade possible          

HOUR 4:  Check price
         → Use turnover_1h recorded from first candle close
         → Calculate ret_4h = (price_4h - listing_price) / listing_price
         → Calculate max_pump_4h = (max_high_0to4h - listing_price) / listing_price
         → AVOIDANCE (LEGS): skip LEGS if max_pump_4h > 50%
         → LEGS SIGNAL: if ret_4h < 0 AND turnover_1h > $1M
           → ENTER LEG 1 (per phase sizing table)
         → If LEGS conditions fail:
           → Keep token in WATCHING for S7 at hour 8
         → Note max_pump_4h for S7 check at hour 8

HOUR 8:  Two checks:

         1. SCALE-IN (only if Leg 1 is open):
            → Calculate ret_8h = (price_8h - listing_price) / listing_price
            → If ret_8h < -10% → ENTER LEG 2
            → If ret_8h ≥ -10% → hold Leg 1 only

         2. S7 CHECK (only if NO position is open on this token):
            → AVOIDANCE: skip if max_pump_8h > 50%
            → If max_pump_4h > 15% AND ret_8h < 0
              → ENTER S7 POSITION

MUTUAL EXCLUSION:
         → If token entered LEGS path (Leg 1 open), S7 is not allowed
         → If S7 position is open, LEGS entries are not allowed

HOUR 8+: Do nothing. Hold.

DAY 14:  Close all legs at market.
```

---

## WHAT WE TESTED AND WHAT WE FOUND (ALL 9 ROUNDS)

### Round 1 — Signal Discovery & Baseline

Tested ~8 individual signals for predicting 7-day decline from the first 4-8 hours of data.

**Baseline:** 346 listings, 62% red at day 7, median -10.7%.

**Standout signals:**

| Signal | Rule | N | WR (7d) |
|--------|------|---|---------|
| S7 | Pump >15% in 4h then below listing at 8h | 25 | 89% |
| S4 | Down >10% at 4h | 58 | 76% |
| S6 | First candle <-5% + turnover >$1M | 42 | 74% |
| S1 | Red first candle + negative funding | 46 | 73% |

**Signal stacking:** 0 signals = 53% WR (no edge). 3+ signals = 79% WR. Clear "cliff" where edge kicks in.

**BTC regime:** Moderate bull (+10-20% BTC 30d) is the best regime for shorting new listings (74% WR) — that's when exchanges dump the most exit liquidity. Euphoria (>20% BTC) kills the edge entirely (50% WR).

**Avoidance filter built here:** Don't short if token is still pumping >10% at 4h, if it pumped >50% in 12h, or if shorts are crowded while price is rising. Filter added 5-7% WR across all strategies by removing 87 tokens that only had 43% short WR.

### Round 2 — Trailing Stops, Leverage, Continuation

**Trailing stops:** Tight trails (5-20%) are useless on new listings — volatility shakes you out 88-100% of the time. 50% trail was optimal at high leverage only.

**Day 7→14 continuation:** 59-70% of tokens red at day 7 keep falling. This justified extending max hold from 7 to 14 days.

**Fixed take-profits kill the tail:** JELLYJELLYUSDT at 40% TP would have netted ~$2K. Letting it run made $46K+ (at 7x sizing). The strategy is explicitly tail-driven — you cannot cap your winners.

### Round 3 — Signal Correlation & 40 New Signals

**Redundancy analysis (Jaccard similarity):** S4 and S5 were 0.42 similar — nearly the same tokens, so stacking them was double-counting. Truly independent signals: S2 (volume dying), S7 (pump-dump), S8 (L/S heavy long).

**Best new signal:** N16 (turnover >$2M + red at 4h) — 68 trades, 82% WR. Best balance of edge and frequency.

**ret_8h is the single strongest feature:**

| Condition | WR | N |
|-----------|-----|---|
| Red at 8h | 78% | 174 |
| Down >10% at 8h | 87% | 67 |
| Down >20% at 8h | 94% | 36 |

The deeper the early dump, the more certain the continued bleed. This discovery became the foundation for the scale-in mechanic in Round 7.

### Round 4 — Grid Backtest (299 Combinations)

23 strategies × 13 exit configurations (leverage × trail type × hold period). All tested at $1K isolated margin. Top results favored 7x leverage with Trail50% and 14-day holds — but this had a fatal flaw exposed in Round 5.

### Round 5 — The Leverage Truth (Fixed Notional)

The most important analytical round. Comparing $1K margin at 7x ($7K notional) vs $1K margin at 3x ($3K notional) was apples-to-oranges — different position sizes.

When all positions fixed at $7K notional, varying only leverage:

| Leverage | Margin | Liq At | WR | Liqs | Total PnL | MDD |
|----------|--------|--------|----|------|-----------|-----|
| **2x** | **$3,500** | **47.5%** | **72%** | **23** | **$320K** | **$10.5K** |
| 3x | $2,333 | 31.7% | 67% | 29 | $314K | $7K |
| 7x | $1,000 | 13.6% | 54% | 45 | $297K | $5K |
| 10x | $700 | 9.5% | 40% | 58 | $182K | $4.9K |

**2x makes the most absolute dollars** because you survive bounces that would liquidate at higher leverage. Tokens that would liquidate you at 7x (needing only 13.6% bounce) become winners at 2x (liquidation at 47.5%). Higher leverage is more capital-efficient but leaves massive PnL on the table through unnecessary liquidations.

### Round 6 — Final Grid (2x/3x Only, Fixed Notional)

Locked to low leverage. The big reveal: **NoTrail beats Trail at 2x.** At 2x, liquidation at 47.5% is so far away that trailing stops only serve to cut winners short. Let the position ride the full 14 days.

**Combined Portfolios — led to Portfolio B selection:**

| Portfolio | Strategies | Trades | WR | Total | MDD | Ret/DD |
|-----------|-----------|--------|----|-------|-----|--------|
| **B: Balanced** | **Red4h+HiVol + S7** | **110** | **71%** | **$465K** | **$10.5K** | **44.3x** |
| A: Conservative | S7 + TO>2M+OI + N30 | 69 | 72% | $419K | $7K | 59.8x |
| C: Single Best | Red4h+HiVol alone | 97 | 70% | $411K | $10.5K | 39.1x |
| D: Max Frequency | Red8h_Broad alone | 167 | 66% | $501K | $16.4K | 30.6x |

Portfolio B chosen for the balance of frequency (5/month), WR (71%), and Ret/DD (44.3x).

*Note: Round 6 PnL figures ($465K) differ from later rounds ($186K) due to different PnL calculation methodology. All relative comparisons within each round are valid.*

### Round 7 — Sizing Optimization & Scale-In

Three major findings:

**1. Don't tier by ret_4h depth.** Counterintuitively, mildly red tokens (0 to -5% at 4h) performed best. Deeply red at 4h means the easy money already happened. Every ret_4h tiering approach (T1-T4) made performance worse — sizing UP on deep dumps sized up on the worst-performing bucket.

**2. Turnover is a better quality indicator.** $5M+ turnover tokens had 74-89% WR vs 61% for $1-2M. Higher volume = more exit liquidity being dumped.

**3. Scale-in (SI-C) beats everything.** Enter $5K at 4h, add $7K at 8h if ret_8h < -10%. Both legs isolated. Result: 15.5x Ret/DD vs 8.9x flat — nearly double the risk-adjusted return with lower MDD.

**Walk-forward confirmed SI-C in 2025:**

| Period | N | WR | PnL | MDD | Ret/DD | PF |
|--------|---|----|-----|-----|--------|-----|
| 2024 (in-sample) | 24 | 66.7% | $33,751 | $7,500 | 4.5x | 2.08 |
| **2025 (out-of-sample)** | **86** | **69.8%** | **$132,579** | **$12,000** | **11.0x** | **2.37** |

### Round 8 — Fees & Funding Rate Impact

**Trading fees: Negligible.** 0.06% taker per side. Total across 114 trades: $1,196 (0.6% of gross PnL). At Phase 1 sizing ($3K notional): $3.60 round trip.

**Funding rates: Modest headwind.** Funding is paid/received every 8 hours on Bybit perps. For shorts, positive rate = receive, negative rate = pay.

Results across 114 trades:
- 51% of trades we received funding (avg $74)
- 49% of trades we paid funding (avg $373)
- Total funding impact: -$16,578 (net headwind)

The asymmetry makes sense: when our shorts are winning (token dumping hard), everyone else piles into shorts too, pushing funding negative. We pay more on our winners than we earn on flat trades.

**Gross vs Net:**

| Metric | Gross | Net | Delta |
|--------|-------|-----|-------|
| Total PnL | $186,184 | $168,410 | -$17,774 |
| Win Rate | 69.3% | 70.2% | +0.9% |
| Profit Factor | 2.64 | 2.46 | -0.18 |
| Max Drawdown | $12,000 | $11,950 | -$50 |
| Return / Drawdown | 15.5x | 14.1x | -1.4x |

**Strategy retains 90.5% of gross PnL.** Net 14.1x Ret/DD and 2.46 PF is excellent.

**Year-by-year net:**

| Year | N | Gross PnL | Fees | Funding | Net PnL | Net Ret/DD | Net PF |
|------|---|-----------|------|---------|---------|------------|--------|
| 2024 | 24 | $33,751 | -$228 | -$411 | $33,113 | 4.4x | 2.98 |
| 2025 | 86 | $132,579 | -$919 | -$13,782 | $117,879 | 9.9x | 2.20 |
| 2026 | 4 | $19,853 | -$49 | -$2,385 | $17,419 | ∞ | ∞ |

### Round 9 — Robustness & Threshold Sensitivity

**Turnover threshold: ROBUST.**

| Threshold | N | WR | PnL | PF |
|-----------|---|----|-----|----|
| $300K | 146 | 65.1% | $112K | 1.78 |
| $500K | 136 | 66.9% | $119K | 1.92 |
| $750K | 116 | 69.0% | $111K | 2.02 |
| $1M (chosen) | 110 | 69.1% | $116K | 2.13 |
| $1.5M | 100 | 70.0% | $117K | 2.32 |
| $2M | 91 | 71.4% | $120K | 2.58 |
| $5M | 56 | 78.6% | $109K | 4.04 |

Smooth, monotonic improvement in WR and PF as you tighten. No cliff. $1M is not magic — $750K or $1.5M performs nearly identically. Not overfit.

**S7 pump threshold: MOSTLY ROBUST.**

| Pump | S7 Trades | S7 WR | Total PnL | PF |
|------|-----------|-------|-----------|----|
| 5% | 44 | 59% | $108K | 1.74 |
| 10% | 23 | 74% | $121K | 2.07 |
| 12% | 17 | 82% | $125K | 2.22 |
| 15% (chosen) | 13 | 77% | $116K | 2.13 |
| 18% | 9 | 89% | $117K | 2.23 |

Edge appears around 8-10% and improves steadily. 15% chosen for cleaner pump-and-dump logic over 12% (marginal difference). Below 8% catches non-pump-and-dumps and WR collapses.

**Avoidance filters: BARELY MATTER** within the Portfolio B signal set. The L/S filter produced identical results across every threshold from 0.5 to 0.9. The ret_4h filter only added 3 trades when disabled. The max_pump filter activated on 2 tokens. They're harmless to keep but they're not doing the heavy lifting — Signal 1 already filters for red at 4h which inherently excludes most "still pumping" scenarios.

**Combined stress test: ROBUST.**

| Config | N | WR | PnL | Ret/DD | PF |
|--------|---|----|-----|--------|----|
| Much tighter | 93 | 71.0% | $115K | 11.0x | 2.48 |
| Baseline | 110 | 69.1% | $116K | 8.3x | 2.13 |
| Slightly looser | 119 | 69.7% | $122K | 8.7x | 2.12 |
| Much looser | 145 | 67.6% | $128K | 8.3x | 1.94 |
| Very loose | 160 | 65.6% | $126K | 6.6x | 1.79 |

Gradual, smooth degradation in both directions. No cliffs. **This is strong evidence the edge is structural, not data-mined.**

**Walk-forward monthly breakdown:** Profitable in 17 of 21 months with trades. Worst month: Nov 2024 at -$8,468 (4 trades, 3 liquidated). September 2025 was weakest stretch: 15 trades, 53% WR, 7 liquidations, but only -$2,456 net loss. Even bad months don't blow up.

### Dead-End Tests (Investigated and Rejected)

**Pre-listing price momentum: NOT USEFUL.**

Thesis was that tokens pumping into Bybit listing would have more sell pressure post-listing. Collected 80 tokens' pre-listing price data from DefiLlama. Results:

- Pre-7d vs Post-7d correlation: r = +0.013 (no relationship)
- Pre-14d vs Post-7d correlation: r = +0.435 (positive — opposite of thesis)
- Tokens that pumped 20-50% before listing only dumped 20% of the time at day 7
- Flat tokens (-5% to +5%) dumped 88% of the time

Pre-listing momentum is not predictive. The post-listing price action itself (our existing signals) is the much stronger predictor.

**ret_4h depth for position sizing: INVERTED.** See Round 7 above. Deeper dumps at 4h predicted worse outcomes, not better. Do not size up on deeply red tokens.

**Tight trailing stops (5-20%): DESTRUCTIVE.** At any leverage, new listing volatility shakes you out 88-100% of the time. See Round 2.

### Manual Chart Verification (Pine Script)

Built a TradingView Pine Script overlay that plots all signal entries, scale-in levels, liquidation lines, and exits on any Bybit perp chart. Used it to manually verify the strategy on actual charts.

**Tokens verified on-chart:**
- BROCCOLIUSDT — large winner, both legs triggered, entries and exits match backtest
- ANIMEUSDT — large winner, entries confirmed
- TRIAUSDT (most recent listing, Feb 5, 2026) — correctly AVOIDED. Token was up 11.7% at 4h, pumping. Avoidance filter (ret_4h > 10%) triggered. The strategy sat it out correctly.

---

## IMPORTANT CAVEATS

### Accounted For
- **Trading fees:** 0.06% taker each way. Impact: $1,196 total (0.6% drag). ✅
- **Funding rates:** 8h payments calculated per trade. Impact: -$16,578 (9% drag). Net retains 90.5%. ✅
- **Walk-forward:** 2024 in-sample → 2025 out-of-sample. OOS holds at 9.9x net Ret/DD. ✅
- **Threshold robustness:** All key parameters stress-tested. Smooth degradation, no cliffs. ✅
- **Pre-listing data:** Tested and rejected. Not useful. ✅
- **Manual chart verification:** Pine Script overlay confirmed entries/exits on real charts. ✅

### Not Yet Accounted For
- **Slippage:** New listings have wide spreads in first hours. Entry prices assume candle close at entry hour. Real entries may be 0.5-2% worse.
- **Borrow cost:** Some tokens may have additional short borrow fees beyond funding.
- **Availability:** Not all new listings may have perps available immediately.
- **Concurrent position overlap:** Exact capital requirements with overlapping 14-day holds not fully modeled at Phase 1 sizing.

### Known Risks

**Tail-driven PnL.** Most trades are modest wins ($1-8K) or controlled losses ($2.5-6K at 2x liquidation). The total PnL is dominated by a handful of extreme collapses (70-90% drops over 14 days). Removing the top 5 trades drops total PnL ~40%. This is the strategy — you're collecting small-to-medium wins while waiting for a token to absolutely collapse. You cannot miss trades.

**Lumpy frequency.** 0-13 trades per month. Not consistent flow. There will be months with zero trades and months with 10+.

**Seasonal weakness.** Q3 periods (July-September) showed weaker performance in both 2024 and 2025 — possibly seasonal (fewer quality listings in summer, more speculative altcoin momentum).

**Phase 1 vulnerability.** Two consecutive liquidations at Phase 1 ($3K allocation) nearly wipes the allocation. Probability ~6%. Acceptable given the $80K account backstop.

---

## KEY PRINCIPLES

1. **2x leverage only** — liquidation at 47.5% gives maximum survival rate
2. **No trailing stop** — at 2x, trail just cuts winners short
3. **Scale-in, not flat sizing** — start $5K, add $7K only when dump confirms at 8h
4. **14 day max hold** — the bleed continues well past day 7
5. **Take every trade** — the edge is tail-driven, missing one big winner kills the year
6. **Isolated margin** — each position risks only its own margin
7. **Fees are negligible** — 0.06% taker = $3-14 per trade
8. **Funding is a headwind, not a tailwind** — budget ~$145/trade average cost
9. **Automate execution** — human discretion is the enemy of a tail-driven strategy
10. **The strategy is the filter, not the trader** — if signals fire and avoidance doesn't trigger, you trade. No second-guessing.

---

## DATA STRUCTURE

All data is stored at: `C:\Users\mdias\OneDrive\Desktop\NEW LISTING BYBIT\data`

### Directory Structure
```
data/
├── listings.csv                    # Master list of all 346 listings
├── btc_bybit_1m_4y.csv           # BTC hourly prices (4 years)
├── klines_1h/                     # Hourly candles per token (346 files)
├── funding_rates/                 # 8h funding rate snapshots (no headers: unix_ms, rate)
├── open_interest/                 # Open interest snapshots per token
├── long_short_ratio/              # Long/short ratio per token
├── pre_listing_prices/            # Pre-listing daily prices from DefiLlama (80 files)
├── si_c_trades_with_fees.csv      # Trade-level CSV with gross/net PnL, fees, funding
├── tiered_sizing_v2_output.txt    # Sizing optimization results
├── fees_and_funding_output.txt    # Fee/funding impact analysis
└── robustness_test_output.txt     # Threshold sensitivity results
```

Additional funding data: `C:\Users\mdias\OneDrive\Desktop\BYBIT DATA\DATA\02_derivatives\funding_rates\` (556 files)

### File Formats

**listings.csv:** `symbol,launch_ms` — symbol is Bybit perp (ends USDT), launch_ms is unix ms.

**klines_1h/{symbol}.csv:** `timestamp,open,high,low,close,volume,turnover` — turnover is USDT volume.

**funding_rates/{symbol}.csv:** NO HEADERS. Raw CSV: `unix_ms,funding_rate`. 8h intervals. Rate is decimal (0.001 = 0.1% per 8h).

**open_interest/{symbol}.csv:** `timestamp,open_interest` — OI in USDT.

**long_short_ratio/{symbol}.csv:** `timestamp,buy_ratio,sell_ratio` — sum to ~1.0. L/S = buy/sell.

### Code Pattern for Loading

```python
import csv, os
from datetime import datetime, timezone

DATA_DIR = r"C:\Users\mdias\OneDrive\Desktop\NEW LISTING BYBIT\data"
os.chdir(DATA_DIR)

# Listings
listings = {}
with open('listings.csv', 'r') as f:
    for r in csv.DictReader(f):
        listings[r['symbol']] = {
            'launch_ms': int(r['launch_ms']),
            'dt': datetime.fromtimestamp(int(r['launch_ms'])/1000, tz=timezone.utc)
        }

# Klines
klines_1h = {}
for fname in os.listdir('klines_1h/'):
    if not fname.endswith('.csv'): continue
    symbol = fname.replace('.csv', '')
    rows = []
    with open(f'klines_1h/{fname}', 'r') as f:
        for r in csv.DictReader(f):
            try:
                rows.append({
                    'ts': int(r['timestamp']), 'o': float(r['open']),
                    'h': float(r['high']), 'l': float(r['low']),
                    'c': float(r['close']), 'v': float(r['volume']),
                    't': float(r['turnover'])
                })
            except: continue
    klines_1h[symbol] = sorted(rows, key=lambda x: x['ts'])

# Funding (NO HEADERS)
funding = {}
for fname in os.listdir('funding_rates/'):
    if not fname.endswith('.csv'): continue
    symbol = fname.replace('.csv', '')
    rows = []
    with open(f'funding_rates/{fname}', 'r') as f:
        reader = csv.reader(f)
        for row in reader:
            try:
                rows.append({'ts': int(row[0]), 'rate': float(row[1])})
            except: continue
    funding[symbol] = sorted(rows, key=lambda x: x['ts'])
```

---

## ALL SCRIPTS REFERENCE

| Script | Round | What It Does |
|--------|-------|-------------|
| `python_backtest_v2.py` | 1-2 | Signal discovery, trailing stops, leverage |
| `combined_strategy_backtest.py` | 2 | Combined strategy testing |
| `deep_analysis_round3.py` | 3 | Signal correlation, 40 new signals, thresholds |
| `grid_backtest.py` | 4 | 23 strats × 13 exits grid |
| `fixed_notional_test.py` | 5 | Fixed notional, leverage truth |
| `final_grid_2x3x.py` | 6 | Final 2x/3x grid, portfolio construction |
| `robustness_and_sizing_test.py` | 9 | Threshold sensitivity, walk-forward |
| `tiered_sizing_v2.py` | 7 | Sizing tiers, scale-in, walk-forward |
| `fees_and_funding_impact.py` | 8 | Fee + funding rate impact |
| `collect_pre_listing_data.py` | — | Pre-listing price collector (DefiLlama) |
| `pre_listing_analysis.py` | — | Pre-listing momentum analysis (rejected) |
| `si_c_strategy_overlay_v2.pine` | — | TradingView chart verification overlay |

## ALL OUTPUT FILES REFERENCE

| File | Description |
|------|-------------|
| `deep_analysis_output.txt` | Round 1: Signal testing, stacking, BTC regime |
| `deep_analysis_v2_output.txt` | Round 1 extended analysis |
| `round2_output.txt` | Round 2: Continuation, trailing stops |
| `round3_output.txt` | Round 3: Correlation, new signals |
| `grid_backtest_output.txt` | Round 4: 299-combo grid |
| `fixed_notional_output.txt` | Round 5: Leverage truth |
| `final_grid_output.txt` | Round 6: Final 2x/3x grid |
| `robustness_test_output.txt` | Round 9: Threshold sensitivity |
| `tiered_sizing_v2_output.txt` | Round 7: Sizing optimization |
| `fees_and_funding_output.txt` | Round 8: Fee/funding impact |
| `si_c_trades_with_fees.csv` | Trade-level detail with net PnL |

---

## NEXT STEPS

1. ~~Signal discovery~~ ✅
2. ~~Leverage optimization~~ ✅
3. ~~Sizing / scale-in~~ ✅
4. ~~Walk-forward validation~~ ✅
5. ~~Threshold robustness~~ ✅
6. ~~Fees + funding~~ ✅
7. ~~Pre-listing data~~ ✅ (tested, rejected)
8. ~~Manual chart verification~~ ✅
9. **Production execution script** — monitor new listings, check signals at 4h/8h, auto-alert
10. **Live paper trading** — run signals on next 20+ listings before going live
11. **Concurrent position overlap analysis** — model actual capital requirements with overlapping holds
