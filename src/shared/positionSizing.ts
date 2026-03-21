/**
 * positionSizing.ts
 * Canonical position-sizing engine for Clawdia trading subsystem.
 * All rules are documented in docs/POSITION-SIZING-RULES.md.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SizingInputs {
  accountEquity: number;       // current portfolio value (USD)
  peakEquity: number;          // all-time high equity for drawdown calc
  entryPrice: number;          // anticipated fill price
  stopPrice: number;           // hard stop-loss price
  atr14: number;               // 14-period ATR of the instrument
  strategyRiskPct?: number;    // per-trade max risk % of equity (default 0.01)
  maxPositionPct?: number;     // concentration cap % of equity (default 0.10)
  isFractional?: boolean;      // true for crypto / fractional assets
  override?: boolean;          // user-initiated override flag
  overrideReason?: string;     // required when override=true
}

export type RejectionCode =
  | 'MISSING_STOP'
  | 'STOP_TOO_TIGHT'
  | 'CONCENTRATION_EXCEEDED'
  | 'RISK_LIMIT_BREACH'
  | 'INSUFFICIENT_EQUITY';

export interface SizingResult {
  sharesFinal: number;          // final quantity to submit (shares or units)
  positionValue: number;        // sharesFinal × entryPrice
  riskPerTradeUsd: number;      // dollar risk for this trade
  stopDist: number;             // effective stop distance used
  scaleFactorDrawdown: number;  // drawdown scaling factor (0.25–1.0)
  drawdownPct: number;          // current drawdown from peak
  sharesRaw: number;
  sharesBase: number;
  sharesScaled: number;
  rejectionCode: RejectionCode | null;
  rejected: boolean;
  auditRecord: SizingAuditRecord;
}

export interface SizingAuditRecord {
  timestamp: string;
  symbol?: string;
  entryPrice: number;
  stopPrice: number;
  stopDist: number;
  atr14: number;
  accountEquity: number;
  peakEquity: number;
  drawdownPct: number;
  scaleFactor: number;
  riskPerTradeUsd: number;
  sharesRaw: number;
  sharesBase: number;
  sharesScaled: number;
  sharesFinal: number;
  positionValue: number;
  rejectionCode: RejectionCode | null;
  override: boolean;
  overrideReason?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_RISK_PCT = 0.01;         // 1%
const DEFAULT_MAX_POSITION_PCT = 0.10; // 10%
const HARD_MAX_RISK_PCT = 0.02;        // 2% hard ceiling
const ATR_FLOOR_MULTIPLIER = 0.5;      // min stop = 0.5 × ATR14
const MIN_STOP_DIST = 0.01;
const DRAWDOWN_SCALE_FLOOR = 0.25;
const DRAWDOWN_FULL_REDUCTION_PCT = 0.20; // 20% drawdown → floor scale
const MIN_EQUITY = 1000;
const FRACTIONAL_DECIMALS = 6;

// ─── Core Calculation ─────────────────────────────────────────────────────────

/**
 * Calculate position size according to the canonical sizing rules.
 * Returns a full SizingResult including audit record and rejection status.
 */
export function calculatePositionSize(
  inputs: SizingInputs,
  symbol?: string
): SizingResult {
  const {
    accountEquity,
    peakEquity,
    entryPrice,
    stopPrice,
    atr14,
    strategyRiskPct = DEFAULT_RISK_PCT,
    maxPositionPct = DEFAULT_MAX_POSITION_PCT,
    isFractional = false,
    override = false,
    overrideReason,
  } = inputs;

  const timestamp = new Date().toISOString();

  // ── §9 Rejection checks ────────────────────────────────────────────────────

  if (!stopPrice || stopPrice === 0) {
    return buildRejection('MISSING_STOP', inputs, timestamp, symbol);
  }

  if (accountEquity < MIN_EQUITY) {
    return buildRejection('INSUFFICIENT_EQUITY', inputs, timestamp, symbol);
  }

  const riskPerTradeUsd = accountEquity * strategyRiskPct;

  if (!override && riskPerTradeUsd > accountEquity * HARD_MAX_RISK_PCT) {
    return buildRejection('RISK_LIMIT_BREACH', inputs, timestamp, symbol);
  }

  // ── §4 Stop distance with ATR floor ───────────────────────────────────────

  const rawStopDist = Math.abs(entryPrice - stopPrice);
  const atrFloor = ATR_FLOOR_MULTIPLIER * atr14;
  const stopDist = Math.max(rawStopDist, atrFloor, MIN_STOP_DIST);

  if (stopDist < MIN_STOP_DIST) {
    return buildRejection('STOP_TOO_TIGHT', inputs, timestamp, symbol);
  }

  // ── §5 Base position size ──────────────────────────────────────────────────

  const sharesRaw = riskPerTradeUsd / stopDist;
  const maxPositionValue = accountEquity * maxPositionPct;
  const maxSharesCap = Math.floor(maxPositionValue / entryPrice);
  const sharesBase = Math.min(Math.floor(sharesRaw), maxSharesCap);

  // ── §6 Drawdown scaling ───────────────────────────────────────────────────

  const drawdownPct = Math.max(0, (peakEquity - accountEquity) / peakEquity);
  const scaleFactor = Math.max(
    DRAWDOWN_SCALE_FLOOR,
    1.0 - drawdownPct / DRAWDOWN_FULL_REDUCTION_PCT
  );

  const sharesScaled = Math.floor(sharesBase * scaleFactor);

  // ── §7 / §8 Final size ────────────────────────────────────────────────────

  let sharesFinal: number;
  if (isFractional) {
    const unitsScaled = (riskPerTradeUsd / stopDist) * scaleFactor;
    sharesFinal = parseFloat(
      Math.min(unitsScaled, maxPositionValue / entryPrice).toFixed(FRACTIONAL_DECIMALS)
    );
    sharesFinal = Math.max(0.000001, sharesFinal);
  } else {
    sharesFinal = Math.max(1, sharesScaled);
  }

  const positionValue = sharesFinal * entryPrice;

  // ── Concentration check (post-scale) ──────────────────────────────────────

  if (!override && positionValue > maxPositionValue) {
    return buildRejection('CONCENTRATION_EXCEEDED', inputs, timestamp, symbol);
  }

  // ── Build result ──────────────────────────────────────────────────────────

  const auditRecord: SizingAuditRecord = {
    timestamp,
    symbol,
    entryPrice,
    stopPrice,
    stopDist,
    atr14,
    accountEquity,
    peakEquity,
    drawdownPct,
    scaleFactor,
    riskPerTradeUsd,
    sharesRaw,
    sharesBase,
    sharesScaled,
    sharesFinal,
    positionValue,
    rejectionCode: null,
    override,
    overrideReason,
  };

  return {
    sharesFinal,
    positionValue,
    riskPerTradeUsd,
    stopDist,
    scaleFactorDrawdown: scaleFactor,
    drawdownPct,
    sharesRaw,
    sharesBase,
    sharesScaled,
    rejectionCode: null,
    rejected: false,
    auditRecord,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildRejection(
  code: RejectionCode,
  inputs: SizingInputs,
  timestamp: string,
  symbol?: string
): SizingResult {
  const auditRecord: SizingAuditRecord = {
    timestamp,
    symbol,
    entryPrice: inputs.entryPrice,
    stopPrice: inputs.stopPrice,
    stopDist: Math.abs(inputs.entryPrice - inputs.stopPrice),
    atr14: inputs.atr14,
    accountEquity: inputs.accountEquity,
    peakEquity: inputs.peakEquity,
    drawdownPct: Math.max(0, (inputs.peakEquity - inputs.accountEquity) / inputs.peakEquity),
    scaleFactor: 0,
    riskPerTradeUsd: inputs.accountEquity * (inputs.strategyRiskPct ?? DEFAULT_RISK_PCT),
    sharesRaw: 0,
    sharesBase: 0,
    sharesScaled: 0,
    sharesFinal: 0,
    positionValue: 0,
    rejectionCode: code,
    override: inputs.override ?? false,
    overrideReason: inputs.overrideReason,
  };

  return {
    sharesFinal: 0,
    positionValue: 0,
    riskPerTradeUsd: 0,
    stopDist: 0,
    scaleFactorDrawdown: 0,
    drawdownPct: auditRecord.drawdownPct,
    sharesRaw: 0,
    sharesBase: 0,
    sharesScaled: 0,
    rejectionCode: code,
    rejected: true,
    auditRecord,
  };
}

/**
 * Human-readable summary of a sizing result for UI display.
 */
export function formatSizingDebug(result: SizingResult): string {
  if (result.rejected) {
    return `❌ Order rejected: ${result.rejectionCode}`;
  }
  const { sharesFinal, positionValue, riskPerTradeUsd, scaleFactorDrawdown, drawdownPct } =
    result;
  return [
    `✅ Shares: ${sharesFinal}`,
    `   Position Value: $${positionValue.toFixed(2)}`,
    `   Risk: $${riskPerTradeUsd.toFixed(2)}`,
    `   Drawdown: ${(drawdownPct * 100).toFixed(1)}% → Scale: ${scaleFactorDrawdown.toFixed(2)}`,
  ].join('\n');
}
