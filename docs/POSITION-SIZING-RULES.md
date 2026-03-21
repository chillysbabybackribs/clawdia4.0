# Position-Sizing Rules

> **Purpose:** Define the exact rules governing how trade size is calculated for every order submitted through Clawdia's trading subsystem. These rules apply to all strategies, manual overrides, and autonomous agent-spawned orders.

---

## 1. Core Principles

| # | Principle | Description |
|---|-----------|-------------|
| 1 | **Capital Preservation First** | No single trade may risk more than the per-trade max-loss limit (see §3). |
| 2 | **Risk-Based Sizing** | Position size is derived from *risk amount*, not from a fixed dollar or share count. |
| 3 | **Volatility Normalization** | Raw risk is scaled by the instrument's current ATR to prevent oversizing during high-vol regimes. |
| 4 | **Concentration Cap** | No single position may exceed a hard dollar or percentage cap of total account equity. |
| 5 | **Drawdown Scaling** | Position sizes are linearly reduced as account drawdown from peak increases. |

---

## 2. Inputs Required Before Sizing

Every sizing calculation requires the following inputs to be resolved before an order is placed:

```
account_equity        — current total portfolio value (USD)
peak_equity           — all-time high equity used for drawdown calc
entry_price           — anticipated fill price
stop_price            — hard stop-loss price for the trade
atr_14               — 14-period Average True Range of the instrument
strategy_risk_pct     — per-trade max risk as % of equity (default: 1.0%)
max_position_pct      — concentration cap as % of equity (default: 10%)
```

---

## 3. Per-Trade Risk Limit

```
risk_per_trade_usd = account_equity × strategy_risk_pct
```

**Default:** `strategy_risk_pct = 0.01` (1% of equity per trade)

| Risk Level | `strategy_risk_pct` | Notes |
|------------|---------------------|-------|
| Conservative | 0.005 (0.5%) | New strategies / high-vol environments |
| Standard     | 0.010 (1.0%) | Default for all live strategies |
| Aggressive   | 0.020 (2.0%) | Only with explicit user override + confirmed edge |

> ⚠️ `strategy_risk_pct` **must never exceed 2%** for any single trade without a hard system override.

---

## 4. Stop-Distance and ATR Adjustment

```
raw_stop_dist  = |entry_price − stop_price|
atr_floor      = 0.5 × atr_14          # minimum stop distance
stop_dist      = max(raw_stop_dist, atr_floor)
```

If the user-supplied stop is tighter than 0.5 × ATR, it is **widened** to the ATR floor automatically to avoid being stopped out by routine noise.

---

## 5. Base Position Size Calculation

```
shares_raw = risk_per_trade_usd / stop_dist
```

Apply the **concentration cap**:

```
max_position_value = account_equity × max_position_pct
max_shares_cap     = floor(max_position_value / entry_price)
shares_base        = min(floor(shares_raw), max_shares_cap)
```

---

## 6. Drawdown Scaling Factor

```
drawdown_pct    = (peak_equity − account_equity) / peak_equity
scale_factor    = max(0.25, 1.0 − (drawdown_pct / 0.20))
```

Interpretation:

| Drawdown from Peak | Scale Factor Applied |
|--------------------|----------------------|
| 0%  | 1.00 (full size) |
| 5%  | 0.75 |
| 10% | 0.50 |
| 15% | 0.25 |
| ≥20% | 0.25 (floor — trading continues at ¼ size) |

```
shares_scaled = floor(shares_base × scale_factor)
```

> At ≥20% drawdown the system enters **reduced-size mode** and alerts the user. No automated strategies may increase `strategy_risk_pct` while in this state.

---

## 7. Final Size (shares_final)

```
shares_final = max(1, shares_scaled)   # never zero; min 1 share
```

Dollar value check (sanity guard):

```
position_value = shares_final × entry_price
assert position_value ≤ (account_equity × max_position_pct)
```

If assertion fails, the order is **rejected** and logged with reason `CONCENTRATION_EXCEEDED`.

---

## 8. Fractional / Crypto Assets

For assets that allow fractional quantities:

```
units_raw    = risk_per_trade_usd / stop_dist
units_scaled = units_raw × scale_factor
units_final  = round(units_scaled, 6)   # 6 decimal places
```

Concentration cap still applies:

```
assert units_final × entry_price ≤ account_equity × max_position_pct
```

---

## 9. Order Rejection Conditions

An order is **rejected before submission** if any of the following are true:

| Condition | Rejection Code |
|-----------|----------------|
| `stop_price` not set | `MISSING_STOP` |
| `stop_dist < 0.01` (stop too close) | `STOP_TOO_TIGHT` |
| `shares_final × entry_price > account_equity × max_position_pct` | `CONCENTRATION_EXCEEDED` |
| `risk_per_trade_usd > account_equity × 0.02` | `RISK_LIMIT_BREACH` |
| `account_equity < 1000` | `INSUFFICIENT_EQUITY` |

All rejections are written to the runs log with full sizing debug info.

---

## 10. Audit & Logging

Every sizing event writes the following record to the runs log:

```json
{
  "timestamp": "ISO-8601",
  "symbol": "TICKER",
  "entry_price": 0.00,
  "stop_price": 0.00,
  "stop_dist": 0.00,
  "atr_14": 0.00,
  "account_equity": 0.00,
  "peak_equity": 0.00,
  "drawdown_pct": 0.00,
  "scale_factor": 0.00,
  "risk_per_trade_usd": 0.00,
  "shares_raw": 0,
  "shares_base": 0,
  "shares_scaled": 0,
  "shares_final": 0,
  "position_value": 0.00,
  "rejection_code": null
}
```

---

## 11. Override Procedure

Manual overrides of any sizing parameter require:

1. User explicitly sets `override: true` in the order payload.
2. Override reason is logged (free-text string, required).
3. Hard limits in §9 still apply — overrides cannot bypass rejection codes.
4. Override events are flagged in the runs review UI with a ⚠️ badge.

---

## 12. Files and Artifacts

The following files implement or reference these rules:

| # | File / Artifact | Kind | Description |
|---|----------------|------|-------------|
| 1 | `docs/POSITION-SIZING-RULES.md` | Specification | **This document** — canonical sizing rules |
| 2 | `src/shared/positionSizing.ts` | TypeScript module | Core sizing calculation functions |
| 3 | `src/shared/positionSizing.test.ts` | Test suite | Unit tests covering all branches in §3–§9 |
| 4 | `src/main/tradeExecutor.ts` | Integration point | Calls `positionSizing.ts` before every order submission |
| 5 | `src/renderer/components/SizingDebugPanel.tsx` | UI component | Displays live sizing calculation breakdown in the trade panel |

---

*Last updated: 2026-03-21*
