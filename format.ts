export function formatMoney(value: number, currency: string): string {
  const amount = Number.isFinite(value) ? value : 0;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatSigned(value: number, currency: string): string {
  const abs = formatMoney(Math.abs(value), currency);
  if (value > 0) return `+${abs}`;
  if (value < 0) return `−${abs}`;
  return formatMoney(0, currency);
}

export function formatClock(epochMs: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(epochMs);
}
