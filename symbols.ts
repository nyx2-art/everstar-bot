export const VOLS = [10, 25, 50, 75, 100] as const;
export type Vol = (typeof VOLS)[number];
export type Pace = "standard" | "one";

const PIPS: Record<string, number> = {
  R_10: 3,
  R_25: 3,
  R_50: 4,
  R_75: 4,
  R_100: 2,
  "1HZ10V": 2,
  "1HZ25V": 2,
  "1HZ50V": 2,
  "1HZ75V": 2,
  "1HZ100V": 2,
};

export function symbolFor(vol: Vol, pace: Pace): string {
  return pace === "one" ? `1HZ${vol}V` : `R_${vol}`;
}

export function symbolLabel(vol: Vol, pace: Pace): string {
  return pace === "one" ? `Volatility ${vol} (1s)` : `Volatility ${vol}`;
}

export function pipFor(symbol: string): number {
  return PIPS[symbol] ?? 2;
}

export function formatPrice(value: number, pip: number): string {
  const digits = Number.isInteger(pip) && pip >= 0 && pip <= 8 ? pip : 2;
  return value.toFixed(digits);
}
