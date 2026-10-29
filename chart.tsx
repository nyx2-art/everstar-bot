import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import { formatPrice } from "./symbols";

export function TapeChart({ prices, pip }: { prices: number[]; pip: number }) {
  if (prices.length < 2) {
    return (
      <div className="flex h-52 items-center justify-center text-sm text-muted">
        Waiting for the first ticks of the night…
      </div>
    );
  }

  const data = prices.map((price, index) => ({ index, price }));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const pad = (max - min) * 0.2 || Math.abs(min) * 0.0008 || 0.01;

  return (
    <div className="h-52 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 12, right: 4, left: 4, bottom: 0 }}>
          <YAxis hide domain={[min - pad, max + pad]} />
          <Tooltip
            cursor={{ stroke: "var(--color-line)" }}
            contentStyle={{
              background: "var(--color-raised)",
              border: "1px solid var(--color-line)",
              borderRadius: "0.75rem",
              color: "var(--color-paper)",
              fontSize: "0.875rem",
            }}
            formatter={(value) => [formatPrice(Number(value ?? 0), pip), "Spot"]}
            labelFormatter={() => "Spot"}
          />
          <Area
            type="monotone"
            dataKey="price"
            stroke="var(--color-star)"
            fill="var(--color-star)"
            fillOpacity={0.14}
            strokeWidth={1.75}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
