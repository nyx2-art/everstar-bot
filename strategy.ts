export type Side = "CALL" | "PUT";
export type Regime = "trend" | "pullback" | "chop";

export interface Read {
  side: Side;
  score: number;
  reasons: string[];
  regime: Regime;
}

const MIN_SAMPLES = 40;

function ema(values: number[], period: number): number {
  const k = 2 / (period + 1);
  let next = values[0] ?? 0;
  for (let i = 1; i < values.length; i++) next = values[i] * k + next * (1 - k);
  return next;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function judge(
  side: Side,
  fast: number,
  slow: number,
  recent: number[],
  prior: number[],
  typical: number,
  lastMove: number,
  alternation: number,
): { score: number; reasons: string[]; regime: Regime } {
  const up = side === "CALL";
  const dir = up ? 1 : -1;
  let score = 40;
  const reasons: string[] = [];
  let regime: Regime = "chop";
  const net = recent.reduce((sum, value) => sum + value, 0);
  const priorNet = prior.reduce((sum, value) => sum + value, 0);
  const aligned = recent.filter((value) => Math.sign(value) === dir).length;
  const trend = up ? fast > slow : fast < slow;

  if (trend) {
    score += 12;
    regime = "trend";
    reasons.push(up ? "Short average is leading higher" : "Short average is leading lower");
  }
  if (net * dir > 0) {
    score += 14;
    reasons.push(up ? "The last five ticks lean up" : "The last five ticks lean down");
  }
  if (aligned >= 3 && aligned <= 4) {
    score += 10;
    reasons.push("Momentum is there without a straight spike");
  }
  if (alternation <= 0.75 && priorNet * dir < 0 && net * dir > 0) {
    score += 16;
    regime = "pullback";
    reasons.push(up ? "A dip just turned back up" : "A bounce just turned back down");
  }
  if (lastMove > typical * 2.8) {
    score -= 12;
    reasons.push("The latest tick is a spike");
  }
  if (alternation > 0.75) {
    score -= 24;
    regime = "chop";
    reasons.push("The tape is flipping too fast");
  } else if (alternation < 0.4 && trend) {
    score += 4;
  }

  return {
    score: Math.max(0, Math.min(98, Math.round(score))),
    reasons: reasons.slice(0, 3),
    regime,
  };
}

export function readTape(prices: number[]): Read | null {
  if (prices.length < MIN_SAMPLES) return null;
  const px = prices.slice(-60);
  const fast = ema(px, 8);
  const slow = ema(px, 21);
  const rets: number[] = [];
  for (let i = 1; i < px.length; i++) rets.push(px[i] - px[i - 1]);
  const recent = rets.slice(-5);
  const prior = rets.slice(-10, -5);
  const abs = rets.slice(-20).map((value) => Math.abs(value));
  const typical = median(abs) || 1e-9;
  const lastMove = Math.abs(rets[rets.length - 1] ?? 0);
  const signs = rets
    .slice(-10)
    .map((value) => Math.sign(value))
    .filter((value) => value !== 0);
  let flips = 0;
  for (let i = 1; i < signs.length; i++) if (signs[i] !== signs[i - 1]) flips += 1;
  const alternation = signs.length > 1 ? flips / (signs.length - 1) : 1;

  const call = judge("CALL", fast, slow, recent, prior, typical, lastMove, alternation);
  const put = judge("PUT", fast, slow, recent, prior, typical, lastMove, alternation);
  const best = call.score >= put.score ? { side: "CALL" as const, ...call } : { side: "PUT" as const, ...put };
  if (alternation > 0.75) best.regime = "chop";
  return best;
}

export function driftSide(prices: number[]): Side {
  if (prices.length < 2) return "CALL";
  const span = Math.min(8, Math.floor(prices.length / 2) || 1);
  const recent = prices.slice(-span);
  const prior = prices.slice(-span * 2, -span);
  const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  if (prior.length === 0) return recent[recent.length - 1] >= recent[0] ? "CALL" : "PUT";
  return avg(recent) >= avg(prior) ? "CALL" : "PUT";
}

/** Score required before autopilot may send. Eases after a quiet stretch so it does not sit for hours. */
export function requiredScore(idleMs: number, lossStreak: number): number {
  const base = 68;
  const overdue = Math.max(0, idleMs - 70_000);
  const decay = Math.min(26, Math.floor(overdue / 20_000) * 3);
  const penalty = Math.min(12, Math.max(0, lossStreak) * 4);
  let need = base - decay + penalty;
  if (idleMs > 5 * 60_000) need = Math.min(need, 50);
  if (idleMs > 7 * 60_000) need = Math.min(need, 44);
  return need;
}

export function waitCopy(read: Read | null, need: number, samples: number, idleMs: number): string {
  if (samples < MIN_SAMPLES) {
    const left = MIN_SAMPLES - samples;
    return `Learning this index · ${left} tick${left === 1 ? "" : "s"} to go`;
  }
  if (!read) return "Reading the tape";
  const name = read.side === "CALL" ? "Rise" : "Fall";
  if (read.score >= need) return `${name} is clear enough to send · score ${read.score}`;
  const hold = Math.max(0, 70_000 - idleMs);
  const ease =
    idleMs < 70_000
      ? `The bar holds for ${Math.ceil(hold / 1000)}s, then eases.`
      : "The bar is easing so a quiet market still gets a trade.";
  const why = read.reasons[0] ? `${read.reasons[0]}. ` : "";
  return `Holding · ${name} scores ${read.score}, need ${need}. ${why}${ease}`;
}

export const SAMPLE_FLOOR = MIN_SAMPLES;
