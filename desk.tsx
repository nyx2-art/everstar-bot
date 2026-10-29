import { lazy, Suspense, useEffect, useState } from "react";
import { Star } from "lucide-react";
import type { Trade } from "@/lib/keel/engine";
import { formatClock, formatMoney, formatSigned } from "@/lib/keel/format";
import { formatPrice, symbolLabel, VOLS } from "@/lib/keel/symbols";
import type { Side } from "@/lib/keel/strategy";
import { useKeel } from "./use-keel";

const TapeChart = lazy(() => import("./chart").then((mod) => ({ default: mod.TapeChart })));

const fieldClass =
  "h-12 w-full rounded-md border border-line bg-raised px-3 text-base text-paper outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-star";

function sideName(side: Side): string {
  return side === "CALL" ? "Rise" : "Fall";
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

export function Desk() {
  const { snap, api } = useKeel();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const account = snap.accounts.find((item) => item.accountId === snap.activeId) ?? null;
  const currency = account?.currency ?? "USD";
  const running = snap.autoPhase === "scanning" || snap.autoPhase === "trading" || snap.autoPhase === "cooldown";
  const quote = snap.quote;
  const previous = snap.prices.length > 1 ? snap.prices[snap.prices.length - 2] : quote;
  const rising = quote != null && previous != null && quote >= previous;
  const target = Number(snap.target);
  const stop = Number(snap.stop);
  const openTrade = snap.trades.find((trade) => trade.status === "open") ?? null;

  return (
    <div className="night min-h-screen bg-ink text-paper">
      <header className="sticky top-0 z-20 border-b border-line bg-ink/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3 lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-star text-star-ink">
              <Star className="size-5 fill-current" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="font-display text-3xl leading-none font-medium tracking-tight text-paper">
                Everstar
              </p>
              <p className="text-xs tracking-[0.22em] text-muted uppercase">Bot · night desk</p>
            </div>
          </div>

          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {snap.conn === "live" &&
              snap.accounts.map((item) => {
                const selected = item.accountId === snap.activeId;
                return (
                  <button
                    key={item.accountId}
                    type="button"
                    onClick={() => void api.selectAccount(item.accountId)}
                    className={
                      "h-11 rounded-md border px-3 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-star " +
                      (selected
                        ? "border-star bg-raised text-paper"
                        : "border-line bg-ink text-muted")
                    }
                  >
                    <span className="block text-xs tracking-widest uppercase">
                      {item.accountType === "real" ? "Real" : "Demo"}
                    </span>
                    <span className="tabular-nums">{shortId(item.accountId)}</span>
                  </button>
                );
              })}
            <div className="min-w-28 text-right">
              <p className="text-xs tracking-widest text-muted uppercase">Balance</p>
              <p className="font-display text-2xl leading-none tabular-nums text-paper">
                {account ? formatMoney(account.balance, account.currency) : "—"}
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-4 lg:grid-cols-3 lg:gap-6 lg:px-6 lg:py-6">
        <section className="order-2 flex min-w-0 flex-col gap-4 lg:order-1">
          {snap.conn !== "live" ? (
            <ConnectCard
              appId={snap.appId}
              token={snap.token}
              busy={snap.conn === "connecting"}
              error={snap.connError}
              onAppId={(appId) => api.setForm({ appId })}
              onToken={(token) => api.setForm({ token })}
              onConnect={() => void api.connect()}
            />
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3">
              <div>
                <p className="text-xs tracking-widest text-muted uppercase">
                  {account?.accountType === "real" ? "Live account" : "Demo account"}
                </p>
                <p className="text-sm text-paper">
                  {account?.accountType === "real"
                    ? "Real money. Each trade can lose the stake."
                    : "Practice sky. Losses stay on the demo balance."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => api.disconnect()}
                className="h-11 shrink-0 rounded-md border border-line px-3 text-sm text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-star"
              >
                Sign out
              </button>
            </div>
          )}

          <div className="rounded-lg border border-line bg-surface p-4">
            <div className="grid gap-3">
              <label className="block">
                <span className="mb-1.5 block text-xs tracking-widest text-muted uppercase">Stake</span>
                <input
                  className={fieldClass + " tabular-nums"}
                  inputMode="decimal"
                  value={snap.stake}
                  onChange={(event) => api.setForm({ stake: event.target.value })}
                  aria-label="Stake"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1.5 block text-xs tracking-widest text-muted uppercase">
                    Target profit
                  </span>
                  <input
                    className={fieldClass + " tabular-nums"}
                    inputMode="decimal"
                    value={snap.target}
                    onChange={(event) => api.setForm({ target: event.target.value })}
                    aria-label="Target profit"
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs tracking-widest text-muted uppercase">Loss stop</span>
                  <input
                    className={fieldClass + " tabular-nums"}
                    inputMode="decimal"
                    value={snap.stop}
                    onChange={(event) => api.setForm({ stop: event.target.value })}
                    aria-label="Loss stop"
                  />
                </label>
              </div>
            </div>
            <p className="mt-3 text-sm text-muted">
              Autopilot stops itself when session profit hits the target, or when losses hit the stop.
            </p>

            <p className="mt-5 mb-2 text-xs tracking-widest text-muted uppercase">Volatility</p>
            <div className="grid grid-cols-5 gap-1.5">
              {VOLS.map((vol) => {
                const selected = snap.vol === vol;
                return (
                  <button
                    key={vol}
                    type="button"
                    onClick={() => api.setMarket(vol, snap.pace)}
                    className={
                      "h-11 rounded-md border text-sm tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-star " +
                      (selected
                        ? "border-star bg-star text-star-ink"
                        : "border-line bg-raised text-paper")
                    }
                    aria-pressed={selected}
                  >
                    {vol}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1.5" role="group" aria-label="Tick pace">
              {(
                [
                  ["one", "1-second"],
                  ["standard", "Standard"],
                ] as const
              ).map(([pace, label]) => {
                const selected = snap.pace === pace;
                return (
                  <button
                    key={pace}
                    type="button"
                    onClick={() => api.setMarket(snap.vol, pace)}
                    className={
                      "h-11 rounded-md border text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-star " +
                      (selected
                        ? "border-star bg-raised text-paper"
                        : "border-line bg-ink text-muted")
                    }
                    aria-pressed={selected}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-sm text-muted">
              1-second indexes print every second. Standard prints about every two. Trades last five ticks.
            </p>
          </div>

          <div className="rounded-lg border border-line bg-surface p-4">
            <div className="mb-3 flex items-center gap-2">
              <span
                className={
                  "size-2 rounded-full " +
                  (running ? "bg-star everstar-pulse" : "bg-line")
                }
                aria-hidden="true"
              />
              <p className="text-xs tracking-widest text-muted uppercase">
                {running ? "Autopilot" : snap.autoPhase === "target" ? "Target hit" : snap.autoPhase === "stopped" ? "Stopped" : "Manual"}
              </p>
            </div>
            <p className="min-h-12 text-sm text-paper" aria-live="polite">
              {snap.tapeStatus}
            </p>
            <div className="mt-4 grid gap-3">
              <Meter
                label="Session profit"
                value={Math.max(0, snap.sessionPnl)}
                max={Number.isFinite(target) ? target : 0}
                tone="rise"
                caption={formatSigned(Math.max(0, snap.sessionPnl), currency)}
              />
              <Meter
                label="Session loss"
                value={Math.max(0, -snap.sessionPnl)}
                max={Number.isFinite(stop) ? stop : 0}
                tone="fall"
                caption={formatSigned(Math.min(0, snap.sessionPnl), currency)}
              />
            </div>
            {snap.formError && (
              <p className="mt-3 text-sm text-fall" role="alert">
                {snap.formError}
              </p>
            )}
            <div className="mt-4 grid gap-2">
              <button
                type="button"
                onClick={() => void api.instant()}
                disabled={Boolean(snap.instant && !snap.instant.done)}
                className="h-12 rounded-md bg-star text-base font-semibold text-star-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-star disabled:opacity-40"
              >
                Instant trade
              </button>
            </div>
            <p className="mt-3 text-sm text-muted">
              Instant Trade reads the live tape and only sends when the setup is clear enough (higher quality filter).
              Autopilot is temporarily disabled so we can focus on consistency.
            </p>
          </div>
        </section>

        <section className="order-1 flex min-w-0 flex-col gap-4 lg:order-2 lg:col-span-2">
          <div className="rounded-lg border border-line bg-surface p-4">
            <div className="mb-2 flex items-end justify-between gap-3">
              <div>
                <p className="text-xs tracking-widest text-muted uppercase">
                  {symbolLabel(snap.vol, snap.pace)}
                </p>
                <p
                  className={
                    "font-display text-4xl leading-none tabular-nums " + (rising ? "text-rise" : "text-fall")
                  }
                >
                  {quote == null ? "—" : formatPrice(quote, snap.pip)}
                </p>
              </div>
              <p className="text-right text-sm text-muted">
                {snap.marketError ?? (snap.pace === "one" ? "Tick every second" : "Tick about every 2s")}
                <span className="mt-1 block">Rise / Fall · 5 ticks</span>
              </p>
            </div>
            {mounted ? (
              <Suspense
                fallback={<div className="flex h-52 items-center justify-center text-sm text-muted">Chart loading</div>}
              >
                <TapeChart prices={snap.prices} pip={snap.pip} />
              </Suspense>
            ) : (
              <div className="h-52" />
            )}
          </div>

          {openTrade && <OpenCard trade={openTrade} pip={snap.pip} />}

          <div className="rounded-lg border border-line bg-surface p-4">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="font-display text-2xl leading-none text-paper">Night log</h2>
              <p className="text-sm text-muted tabular-nums">
                {snap.trades.length === 0 ? "No trades yet" : `${snap.trades.length} kept`}
              </p>
            </div>
            {snap.trades.length === 0 ? (
              <p className="text-sm text-muted">
                Entries land here after autopilot or an instant trade. Nothing is invented — only contracts Deriv
                actually accepts.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {snap.trades.map((trade) => (
                  <li key={trade.id} className="flex items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-paper">
                        <span className={trade.side === "CALL" ? "text-rise" : "text-fall"}>
                          {sideName(trade.side)}
                        </span>
                        <span className="text-muted"> · {trade.symbol}</span>
                        <span className="text-muted"> · {trade.mode === "auto" ? "Auto" : "Instant"}</span>
                      </p>
                      <p className="text-xs text-muted tabular-nums">{formatClock(trade.openedAt)}</p>
                    </div>
                    <p
                      className={
                        "text-right text-sm tabular-nums " +
                        (trade.status === "won"
                          ? "text-rise"
                          : trade.status === "lost" || trade.status === "error"
                            ? "text-fall"
                            : "text-star")
                      }
                    >
                      {trade.status === "open"
                        ? "Open"
                        : trade.status === "error"
                          ? "Failed"
                          : formatSigned(trade.profit ?? 0, trade.currency)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="px-1 pb-6 text-xs text-muted">
            Rise/Fall can lose the whole stake. Everstar is not a promise of profit. Use a demo token until the
            rhythm feels right. Your token stays in this browser and is sent only to Deriv.
          </p>
        </section>
      </main>

      {snap.gate && account?.accountType === "real" && (
        <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink/80 p-4 sm:items-center" role="presentation">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="live-title"
            className="w-full max-w-md rounded-lg border border-line bg-surface p-5"
          >
            <p className="text-xs tracking-widest text-star uppercase">Real account</p>
            <h2 id="live-title" className="mt-2 font-display text-3xl leading-tight text-paper">
              This spends real money.
            </h2>
            <p className="mt-3 text-sm text-muted">
              Account {account.accountId}. The next trades use a stake of {snap.stake} {account.currency}. A losing
              Rise/Fall contract can take that stake.
            </p>
            <div className="mt-5 grid gap-2">
              <button
                type="button"
                onClick={() => api.confirmLive()}
                className="h-12 rounded-md bg-star font-semibold text-star-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-star"
              >
                Trade live
              </button>
              <button
                type="button"
                onClick={() => api.cancelGate()}
                className="h-12 rounded-md border border-line text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-star"
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      )}

      {snap.instant && (
        <InstantSheet
          progress={snap.instant.progress}
          phase={snap.instant.phase}
          trade={snap.instant.trade}
          error={snap.instant.error}
          done={snap.instant.done}
          pip={snap.pip}
          onClose={() => api.dismissInstant()}
        />
      )}
    </div>
  );
}

function Meter({
  label,
  value,
  max,
  tone,
  caption,
}: {
  label: string;
  value: number;
  max: number;
  tone: "rise" | "fall";
  caption: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3 text-xs tracking-widest text-muted uppercase">
        <span>{label}</span>
        <span className="tabular-nums tracking-normal text-paper">{caption}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-raised">
        <div
          className={"h-full rounded-full motion-safe:transition-[width] " + (tone === "rise" ? "bg-rise" : "bg-fall")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function OpenCard({ trade, pip }: { trade: Trade; pip: number }) {
  return (
    <div className="rounded-lg border border-star bg-surface p-4">
      <p className="text-xs tracking-widest text-star uppercase">Open contract</p>
      <p className="mt-1 font-display text-2xl text-paper">
        {sideName(trade.side)} · {trade.symbol}
      </p>
      <p className="mt-1 text-sm text-muted tabular-nums">
        Stake {formatMoney(trade.stake, trade.currency)}
        {trade.entry != null ? ` · entry ${formatPrice(trade.entry, pip)}` : ""}
        {` · tick ${Math.min(5, trade.ticksSeen)} of 5`}
      </p>
    </div>
  );
}

function InstantSheet({
  progress,
  phase,
  trade,
  error,
  done,
  pip,
  onClose,
}: {
  progress: number;
  phase: string;
  trade: Trade | null;
  error: string | null;
  done: boolean;
  pip: number;
  onClose: () => void;
}) {
  const won = trade?.status === "won";
  const lost = trade?.status === "lost";
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink/80 p-4 sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="instant-title"
        className="w-full max-w-md rounded-lg border border-line bg-surface p-5"
      >
        <p className="text-xs tracking-widest text-star uppercase">Instant trade</p>
        <h2 id="instant-title" className="mt-1 font-display text-3xl text-paper">
          {done && won ? "Won" : done && lost ? "Lost" : done && error ? "No fill" : "Reading the sky"}
        </h2>
        <div
          className="mt-4 h-2 overflow-hidden rounded-full bg-raised"
          role="progressbar"
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={phase}
        >
          <div
            className={"h-full rounded-full motion-safe:transition-[width] motion-safe:duration-300 " + (error && done ? "bg-fall" : won ? "bg-rise" : "bg-star")}
            style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
          />
        </div>
        <p className="mt-3 text-sm text-muted" aria-live="polite">
          {done && error ? error : phase}
        </p>

        {done && trade && !error && (
          <div className="mt-4 border-t border-line pt-4">
            <p className={"font-display text-4xl tabular-nums " + (won ? "text-rise" : lost ? "text-fall" : "text-paper")}>
              {trade.profit == null ? "Open" : formatSigned(trade.profit, trade.currency)}
            </p>
            <p className="mt-2 text-sm text-paper">
              {sideName(trade.side)} on {trade.symbol}
              <span className="text-muted"> · score {trade.confidence}</span>
            </p>
            <p className="mt-1 text-sm text-muted tabular-nums">
              {trade.entry != null ? `Entry ${formatPrice(trade.entry, pip)}` : "Entry pending"}
              {trade.exit != null ? ` → exit ${formatPrice(trade.exit, pip)}` : ""}
            </p>
            <p className="mt-1 text-sm text-muted tabular-nums">
              Stake {formatMoney(trade.stake, trade.currency)}
              {trade.payout != null ? ` · payout ${formatMoney(trade.payout, trade.currency)}` : ""}
            </p>
            {trade.reasons.length > 0 && (
              <ul className="mt-3 grid gap-1 text-sm text-paper">
                {trade.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
            {trade.longcode && <p className="mt-3 text-xs text-muted">{trade.longcode}</p>}
          </div>
        )}

        {done && (
          <button
            type="button"
            onClick={onClose}
            className="mt-5 h-12 w-full rounded-md bg-star font-semibold text-star-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-star"
          >
            Done
          </button>
        )}
      </div>
    </div>
  );
}

function ConnectCard({
  appId,
  token,
  busy,
  error,
  onAppId,
  onToken,
  onConnect,
}: {
  appId: string;
  token: string;
  busy: boolean;
  error: string | null;
  onAppId: (value: string) => void;
  onToken: (value: string) => void;
  onConnect: () => void;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="text-xs tracking-widest text-star uppercase">Connect Deriv</p>
      <h2 className="mt-1 font-display text-3xl leading-tight text-paper">Demo or real, your token.</h2>
      <ol className="mt-3 grid gap-2 text-sm text-muted">
        <li>1. Open the Deriv developer dashboard and register an application. Choose the PAT type.</li>
        <li>2. Copy the new App ID. Old API app IDs will not connect.</li>
        <li>3. Create a personal access token with the Trade scope. Deriv shows it once.</li>
        <li>4. Paste both here. Everstar lists the demo and real accounts on that token.</li>
      </ol>
      <p className="mt-3 text-sm">
        <a
          className="text-star underline decoration-line underline-offset-4"
          href="https://developers.deriv.com/dashboard/"
          target="_blank"
          rel="noreferrer"
        >
          Developer dashboard
        </a>
        <span className="text-muted"> · </span>
        <a
          className="text-star underline decoration-line underline-offset-4"
          href="https://developers.deriv.com/docs/workflows/"
          target="_blank"
          rel="noreferrer"
        >
          How tokens work
        </a>
      </p>
      <label className="mt-4 block">
        <span className="mb-1.5 block text-xs tracking-widest text-muted uppercase">App ID</span>
        <input
          className={fieldClass}
          value={appId}
          autoComplete="off"
          inputMode="text"
          onChange={(event) => onAppId(event.target.value)}
          aria-label="Deriv app ID"
        />
      </label>
      <label className="mt-3 block">
        <span className="mb-1.5 block text-xs tracking-widest text-muted uppercase">Access token</span>
        <input
          className={fieldClass}
          value={token}
          type="password"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onToken(event.target.value)}
          aria-label="Deriv access token"
        />
      </label>
      {error && (
        <p className="mt-3 text-sm text-fall" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={onConnect}
        disabled={busy}
        className="mt-4 h-12 w-full rounded-md bg-star font-semibold text-star-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-star disabled:opacity-40"
      >
        {busy ? "Connecting…" : "Connect"}
      </button>
      <p className="mt-3 text-xs text-muted">
        The token stays in this browser. Everstar does not keep it on a server.
      </p>
    </div>
  );
}
