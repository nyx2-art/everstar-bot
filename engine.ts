import {
  DerivSocket,
  PUBLIC_WS,
  fetchAccounts,
  fetchOtp,
  type DerivMsg,
  type Poc,
  type RemoteAccount,
} from "./deriv";
import { formatSigned } from "./format";
import { driftSide, readTape, requiredScore, waitCopy, type Read, type Side } from "./strategy";
import { pipFor, symbolFor, type Pace, type Vol } from "./symbols";

const STORAGE_KEY = "everstar.desk.v1";
const TICKS = 5;

export type AutoPhase = "off" | "scanning" | "trading" | "cooldown" | "target" | "stopped";
export type Conn = "off" | "connecting" | "live" | "error";

export interface Trade {
  id: string;
  mode: "auto" | "instant";
  side: Side;
  symbol: string;
  stake: number;
  currency: string;
  payout: number | null;
  profit: number | null;
  status: "open" | "won" | "lost" | "error";
  entry: number | null;
  exit: number | null;
  confidence: number;
  reasons: string[];
  longcode: string;
  openedAt: number;
  closedAt: number | null;
  error?: string;
  ticksSeen: number;
  accountType: "demo" | "real";
  contractId?: number;
}

export interface Snapshot {
  conn: Conn;
  connError: string | null;
  marketError: string | null;
  appId: string;
  token: string;
  accounts: RemoteAccount[];
  activeId: string | null;
  liveArmed: boolean;
  gate: null | "auto" | "instant";
  vol: Vol;
  pace: Pace;
  stake: string;
  target: string;
  stop: string;
  formError: string | null;
  prices: number[];
  quote: number | null;
  pip: number;
  tapeStatus: string;
  autoPhase: AutoPhase;
  sessionPnl: number;
  lossStreak: number;
  threshold: number;
  lastRead: Read | null;
  cooldownLeft: number;
  trades: Trade[];
  instant: null | {
    progress: number;
    phase: string;
    trade: Trade | null;
    error: string | null;
    done: boolean;
  };
}

interface Run {
  pnl: number;
  streak: number;
  phase: AutoPhase;
  idleSince: number;
  cooldownUntil: number;
  stopRequested: boolean;
}

interface Saved {
  appId?: string;
  token?: string;
  activeId?: string;
  vol?: Vol;
  pace?: Pace;
  stake?: string;
  target?: string;
  stop?: string;
  trades?: Trade[];
}

function emptySnapshot(): Snapshot {
  return {
    conn: "off",
    connError: null,
    marketError: null,
    appId: "",
    token: "",
    accounts: [],
    activeId: null,
    liveArmed: false,
    gate: null,
    vol: 100,
    pace: "one",
    stake: "1",
    target: "10",
    stop: "10",
    formError: null,
    prices: [],
    quote: null,
    pip: 2,
    tapeStatus: "Connect a Deriv token to trade. The night tape above is live either way.",
    autoPhase: "off",
    sessionPnl: 0,
    lossStreak: 0,
    threshold: 68,
    lastRead: null,
    cooldownLeft: 0,
    trades: [],
    instant: null,
  };
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function parseAmount(raw: string): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100) / 100;
}

function asPip(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 8) return value;
  return fallback;
}

function isVol(value: unknown): value is Vol {
  return value === 10 || value === 25 || value === 50 || value === 75 || value === 100;
}

export class KeelEngine {
  private snapshot: Snapshot = emptySnapshot();
  private listeners = new Set<(snapshot: Snapshot) => void>();
  private prices: number[] = [];
  private quote: number | null = null;
  private pip = 2;
  private accounts: RemoteAccount[] = [];
  private trades: Trade[] = [];
  private run: Run = {
    pnl: 0,
    streak: 0,
    phase: "off",
    idleSince: 0,
    cooldownUntil: 0,
    stopRequested: false,
  };
  private publicSocket: DerivSocket | null = null;
  private tradeSocket: DerivSocket | null = null;
  private marketSub: string | null = null;
  private marketGen = 0;
  private tradeGen = 0;
  private marketAttempt = 0;
  private tradeAttempt = 0;
  private marketRetry: ReturnType<typeof setTimeout> | null = null;
  private tradeRetry: ReturnType<typeof setTimeout> | null = null;
  private uiTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private disposed = false;
  private busy = false;
  private open: Trade | null = null;
  private counting = false;
  private onPoc: ((poc: Poc) => void) | null = null;
  private progressCb: ((ticks: number) => void) | null = null;

  getSnapshot(): Snapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: Snapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.disposed = false;
    this.restore();
    this.connectPublic();
    this.uiTimer = setInterval(() => this.refreshClock(), 500);
    if (this.snapshot.token.trim()) void this.connect();
  }

  dispose() {
    this.started = false;
    this.disposed = true;
    this.busy = false;
    this.counting = false;
    this.onPoc = null;
    this.progressCb = null;
    if (this.uiTimer) clearInterval(this.uiTimer);
    if (this.marketRetry) clearTimeout(this.marketRetry);
    if (this.tradeRetry) clearTimeout(this.tradeRetry);
    this.uiTimer = null;
    this.marketRetry = null;
    this.tradeRetry = null;
    this.publicSocket?.close();
    this.tradeSocket?.close();
    this.publicSocket = null;
    this.tradeSocket = null;
  }

  setForm(patch: Partial<Pick<Snapshot, "stake" | "target" | "stop" | "appId" | "token">>) {
    this.snapshot = { ...this.snapshot, ...patch, formError: null };
    this.persist();
    this.emit();
  }

  setMarket(vol: Vol, pace: Pace) {
    if (this.snapshot.vol === vol && this.snapshot.pace === pace) return;
    this.snapshot = { ...this.snapshot, vol, pace, formError: null };
    this.prices = [];
    this.quote = null;
    this.pip = pipFor(symbolFor(vol, pace));
    this.persist();
    this.emit();
    void this.subscribeMarket();
  }

  async connect() {
    const token = this.snapshot.token.trim();
    const appId = this.snapshot.appId.trim();
    if (!token) {
      this.failForm("Paste a Deriv personal access token with the Trade scope.");
      return;
    }
    this.snapshot = { ...this.snapshot, conn: "connecting", connError: null, formError: null };
    this.emit();
    try {
      const accounts = await fetchAccounts(token, appId);
      if (this.disposed) return;
      if (accounts.length === 0) {
        throw new Error(
          "No options accounts came back. The token needs the Trade scope, and the account needs an options wallet.",
        );
      }
      this.accounts = accounts;
      const saved = this.snapshot.activeId;
      const next =
        accounts.find((account) => account.accountId === saved) ??
        accounts.find((account) => account.accountType === "demo" && account.status === "active") ??
        accounts.find((account) => account.status === "active") ??
        accounts[0];
      this.snapshot = {
        ...this.snapshot,
        accounts,
        activeId: next.accountId,
        liveArmed: false,
      };
      await this.openTradeSocket(next);
      if (this.disposed) return;
      this.persist();
    } catch (error) {
      if (this.disposed) return;
      const message = error instanceof Error ? error.message : "Could not connect";
      const hint = /deriv-app-id/i.test(message)
        ? " This looks like a personal access token. Add the App ID from your PAT application."
        : "";
      this.snapshot = {
        ...this.snapshot,
        conn: "error",
        connError: `${message}${hint}`,
      };
      this.emit();
    }
  }

  disconnect() {
    this.run.stopRequested = true;
    this.run.phase = "off";
    this.tradeGen += 1;
    this.tradeSocket?.close();
    this.tradeSocket = null;
    this.accounts = [];
    this.snapshot = {
      ...this.snapshot,
      conn: "off",
      connError: null,
      token: "",
      accounts: [],
      activeId: null,
      liveArmed: false,
      gate: null,
      autoPhase: "off",
      tapeStatus: "Disconnected. The market tape is still live.",
    };
    this.persist();
    this.emit();
  }

  async selectAccount(accountId: string) {
    if (this.snapshot.activeId === accountId) return;
    if (this.isAutoLive() || this.busy || this.snapshot.instant) {
      this.failForm("Let the current trade finish before switching accounts.");
      return;
    }
    const account = this.accounts.find((item) => item.accountId === accountId);
    if (!account) return;
    this.snapshot = {
      ...this.snapshot,
      activeId: accountId,
      liveArmed: false,
      conn: "connecting",
      connError: null,
      formError: null,
    };
    this.emit();
    try {
      await this.openTradeSocket(account);
      this.persist();
    } catch (error) {
      if (this.disposed) return;
      this.snapshot = {
        ...this.snapshot,
        conn: "error",
        connError: error instanceof Error ? error.message : "Could not switch accounts",
      };
      this.emit();
    }
  }

  startAuto() {
    if (this.isAutoLive()) return;
    if (!this.ensureReady()) return;
    if (this.needsGate()) {
      this.snapshot = { ...this.snapshot, gate: "auto" };
      this.emit();
      return;
    }
    const stake = parseAmount(this.snapshot.stake);
    const target = parseAmount(this.snapshot.target);
    const stop = parseAmount(this.snapshot.stop);
    if (stake == null || target == null || stop == null) {
      this.failForm("Enter a stake, a target profit, and a loss stop — all greater than zero.");
      return;
    }
    const account = this.active();
    if (account && account.balance < stake) {
      this.failForm("Stake is higher than the balance on this account.");
      return;
    }
    this.run = {
      pnl: 0,
      streak: 0,
      phase: "scanning",
      idleSince: Date.now(),
      cooldownUntil: 0,
      stopRequested: false,
    };
    this.snapshot = {
      ...this.snapshot,
      formError: null,
      sessionPnl: 0,
      lossStreak: 0,
      autoPhase: "scanning",
      tapeStatus: "Autopilot is on. It will skip weak tape, then ease if the market stays quiet.",
    };
    this.emit();
    void this.maybeAuto();
  }

  stopAuto() {
    if (!this.isAutoLive() && this.run.phase !== "trading") {
      this.finishAuto("off", "Autopilot is off.");
      return;
    }
    this.run.stopRequested = true;
    if (this.busy || this.run.phase === "trading") {
      this.snapshot = {
        ...this.snapshot,
        tapeStatus: "Finishing the open trade, then stopping.",
      };
      this.emit();
      return;
    }
    this.finishAuto("off", "Autopilot stopped. No new trades.");
  }

  confirmLive() {
    const gate = this.snapshot.gate;
    this.snapshot = { ...this.snapshot, liveArmed: true, gate: null };
    this.emit();
    if (gate === "auto") this.startAuto();
    if (gate === "instant") void this.instant();
  }

  cancelGate() {
    this.snapshot = { ...this.snapshot, gate: null };
    this.emit();
  }

  dismissInstant() {
    if (this.snapshot.instant && !this.snapshot.instant.done) return;
    this.snapshot = { ...this.snapshot, instant: null };
    this.emit();
  }

  async instant() {
    if (this.isAutoLive()) {
      this.failForm("Stop autopilot before placing an instant trade.");
      return;
    }
    if (this.busy || (this.snapshot.instant && !this.snapshot.instant.done)) return;
    if (!this.ensureReady()) return;
    if (this.needsGate()) {
      this.snapshot = { ...this.snapshot, gate: "instant" };
      this.emit();
      return;
    }
    const stake = parseAmount(this.snapshot.stake);
    if (stake == null) {
      this.failForm("Enter a stake greater than zero.");
      return;
    }
    const account = this.active();
    if (account && account.balance < stake) {
      this.failForm("Stake is higher than the balance on this account.");
      return;
    }
    this.busy = true;
    this.snapshot = {
      ...this.snapshot,
      formError: null,
      instant: {
        progress: 8,
        phase: "Checking the live tape",
        trade: null,
        error: null,
        done: false,
      },
    };
    this.emit();
    try {
      if (this.prices.length < 40) {
        this.setInstant(14, "Waiting for a full read of this index");
        await this.waitForSamples(40, 25_000);
      }
      this.setInstant(28, "Scoring rise against fall");
      const read = readTape(this.prices);
      // Tightened Instant Trade: only take higher-quality setups (closer to the early winning streak)
      const MIN_INSTANT_SCORE = 64;
      if (!read || read.score < MIN_INSTANT_SCORE) {
        const score = read?.score ?? 0;
        this.snapshot = {
          ...this.snapshot,
          lastRead: read,
          instant: {
            progress: 100,
            phase: "Result",
            trade: null,
            error: `No clear edge right now (score ${score}/${MIN_INSTANT_SCORE}). Wait for a cleaner tape and try again.`,
            done: true,
          },
        };
        this.emit();
        return;
      }
      this.snapshot = { ...this.snapshot, lastRead: read };
      this.setInstant(42, "Asking Deriv to price the entry");
      const trade = await this.executeTrade({
        mode: "instant",
        side: read.side,
        stake,
        read,
        onProgress: (progress, phase) => this.setInstant(progress, phase),
      });
      const error = trade.status === "error" ? (trade.error ?? "The order failed") : null;
      this.snapshot = {
        ...this.snapshot,
        instant: { progress: 100, phase: "Result", trade, error, done: true },
      };
      this.persist(); // force-save history immediately
      this.emit();
    } catch (error) {
      if (this.disposed) return;
      this.snapshot = {
        ...this.snapshot,
        instant: {
          progress: 100,
          phase: "Result",
          trade: this.open,
          error: error instanceof Error ? error.message : "The order failed",
          done: true,
        },
      };
      this.open = null;
      this.emit();
    } finally {
      this.busy = false;
      this.counting = false;
      this.progressCb = null;
    }
  }

  private async maybeAuto() {
    if (this.busy || this.run.phase !== "scanning" || this.run.stopRequested || this.open) return;
    if (Date.now() < this.run.cooldownUntil) return;
    const idleMs = Date.now() - this.run.idleSince;
    const need = requiredScore(idleMs, this.run.streak);
    const read = readTape(this.prices);
    this.snapshot = {
      ...this.snapshot,
      threshold: need,
      lastRead: read,
      lossStreak: this.run.streak,
      tapeStatus: waitCopy(read, need, this.prices.length, idleMs),
    };
    if (!read || read.score < need) {
      this.emit();
      return;
    }
    const stake = parseAmount(this.snapshot.stake);
    const target = parseAmount(this.snapshot.target);
    const stop = parseAmount(this.snapshot.stop);
    if (stake == null || target == null || stop == null) {
      this.snapshot = {
        ...this.snapshot,
        tapeStatus: "Autopilot paused — stake, target, and loss stop all need a number above zero.",
      };
      this.emit();
      return;
    }
    const account = this.active();
    if (!account) return;
    if (account.balance < stake) {
      this.finishAuto("stopped", "Balance is below the stake. Autopilot stopped.");
      return;
    }
    this.busy = true;
    this.run.phase = "trading";
    this.snapshot = { ...this.snapshot, autoPhase: "trading", tapeStatus: "Sending a selective entry." };
    this.emit();
    try {
      const trade = await this.executeTrade({
        mode: "auto",
        side: read.side,
        stake,
        read,
        onProgress: () => {},
      });
      this.settleAuto(trade, target, stop);
    } catch (error) {
      if (this.run.stopRequested) {
        this.finishAuto("off", "Autopilot stopped.");
      } else if (!this.disposed) {
        const message = error instanceof Error ? error.message : "Order rejected";
        this.run.phase = "cooldown";
        this.run.cooldownUntil = Date.now() + 20_000;
        this.snapshot = {
          ...this.snapshot,
          autoPhase: "cooldown",
          tapeStatus: `${message} Cooling down 20s, then looking again.`,
        };
        this.emit();
      }
    } finally {
      this.busy = false;
      this.counting = false;
      this.progressCb = null;
    }
  }

  private settleAuto(trade: Trade, target: number, stop: number) {
    if (trade.status === "open") {
      this.run.phase = "cooldown";
      this.run.cooldownUntil = Date.now() + 20_000;
      this.snapshot = {
        ...this.snapshot,
        autoPhase: "cooldown",
        sessionPnl: this.run.pnl,
        lossStreak: this.run.streak,
        tapeStatus: "That contract is still open on Deriv. Holding before another look.",
      };
      this.emit();
      return;
    }
    if (trade.status === "won" || trade.status === "lost") {
      const profit = trade.profit ?? (trade.status === "lost" ? -trade.stake : 0);
      this.run.pnl += profit;
      this.run.streak = trade.status === "lost" ? this.run.streak + 1 : 0;
    }
    this.snapshot = {
      ...this.snapshot,
      sessionPnl: this.run.pnl,
      lossStreak: this.run.streak,
    };
    if (this.run.stopRequested) {
      this.finishAuto("off", "Autopilot stopped.");
      return;
    }
    if (this.run.pnl >= target) {
      this.finishAuto(
        "target",
        `Target reached · session ${formatSigned(this.run.pnl, trade.currency)}. Autopilot is off.`,
      );
      return;
    }
    if (this.run.pnl <= -stop) {
      this.finishAuto(
        "stopped",
        `Loss stop hit · session ${formatSigned(this.run.pnl, trade.currency)}. Autopilot is off.`,
      );
      return;
    }
    const wait = trade.status === "lost" ? Math.min(50_000, 28_000 + this.run.streak * 6_000) : 18_000;
    this.run.phase = "cooldown";
    this.run.cooldownUntil = Date.now() + wait;
    this.snapshot = {
      ...this.snapshot,
      autoPhase: "cooldown",
      cooldownLeft: Math.ceil(wait / 1000),
      tapeStatus: `Trade settled. Next look in ${Math.ceil(wait / 1000)}s — not every tick.`,
    };
    this.emit();
  }

  private async executeTrade(opts: {
    mode: "auto" | "instant";
    side: Side;
    stake: number;
    read: Read;
    onProgress: (progress: number, phase: string) => void;
  }): Promise<Trade> {
    const account = this.active();
    const socket = this.tradeSocket;
    if (!account || !socket?.isOpen) throw new Error("The trading connection dropped. Reconnect and try again.");
    const symbol = symbolFor(this.snapshot.vol, this.snapshot.pace);
    const trade: Trade = {
      id: crypto.randomUUID(),
      mode: opts.mode,
      side: opts.side,
      symbol,
      stake: opts.stake,
      currency: account.currency,
      payout: null,
      profit: null,
      status: "open",
      entry: this.quote,
      exit: null,
      confidence: opts.read.score,
      reasons: opts.read.reasons,
      longcode: "",
      openedAt: Date.now(),
      closedAt: null,
      ticksSeen: 0,
      accountType: account.accountType,
    };
    this.open = trade;
    this.counting = false;
    this.upsert(trade);
    this.progressCb = (ticks) => {
      trade.ticksSeen = ticks;
      this.upsert(trade);
      opts.onProgress(66 + Math.round((Math.min(TICKS, ticks) / TICKS) * 30), `Trade is live · tick ${Math.min(TICKS, ticks)} of ${TICKS}`);
    };

    try {
      const proposal = await socket.request({
        proposal: 1,
        amount: opts.stake,
        basis: "stake",
        contract_type: opts.side,
        currency: account.currency,
        underlying_symbol: symbol,
        duration: TICKS,
        duration_unit: "t",
      });
      const proposed = proposal.proposal;
      if (!proposed?.id || proposed.ask_price == null) throw new Error("Deriv did not price that contract");
      trade.payout = num(proposed.payout);
      trade.longcode = proposed.longcode ?? "";
      trade.entry = num(proposed.spot) ?? trade.entry;
      this.upsert(trade);
      opts.onProgress(58, "Placing the trade");

      const bought = await socket.request({ buy: proposed.id, price: Number(proposed.ask_price) });
      const contractId = bought.buy?.contract_id;
      if (!contractId) throw new Error("Deriv did not confirm the purchase");
      trade.contractId = contractId;
      if (bought.buy?.payout != null) trade.payout = num(bought.buy.payout);
      if (bought.buy?.longcode) trade.longcode = bought.buy.longcode;
      const balanceAfter = num(bought.buy?.balance_after);
      if (balanceAfter != null) this.patchBalance(account.accountId, balanceAfter);
      this.counting = true;
      this.upsert(trade);
      opts.onProgress(66, `Trade is live · tick 0 of ${TICKS}`);

      const poc = await this.waitSettlement(contractId);
      this.applySettlement(trade, poc);
      this.open = trade.status === "open" ? trade : null;
      this.counting = false;
      this.upsert(trade);
      this.emit();
      return trade;
    } catch (error) {
      if (trade.status === "open" && !trade.contractId) {
        trade.status = "error";
        trade.error = error instanceof Error ? error.message : "The order failed";
        trade.closedAt = Date.now();
        this.open = null;
        this.upsert(trade);
      }
      throw error;
    }
  }

  private waitSettlement(contractId: number): Promise<Poc | null> {
    const socket = this.tradeSocket;
    if (!socket) return Promise.resolve(null);
    return new Promise((resolve) => {
      let last: Poc | null = null;
      const finish = (poc: Poc | null) => {
        if (this.onPoc === handle) this.onPoc = null;
        clearTimeout(timer);
        resolve(poc);
      };
      const handle = (poc: Poc) => {
        if (poc.contract_id !== contractId) return;
        last = poc;
        const trade = this.open;
        if (trade && trade.contractId === contractId) {
          trade.profit = num(poc.profit);
          trade.entry = num(poc.entry_spot) ?? trade.entry;
          trade.exit = num(poc.exit_spot);
          this.upsert(trade);
          this.emit();
        }
        const status = poc.status;
        if (status === "won" || status === "lost" || status === "sold" || status === "cancelled" || poc.is_sold === 1) {
          finish(poc);
        }
      };
      const timer = setTimeout(() => finish(last), 45_000);
      this.onPoc = handle;
      void socket
        .request({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 })
        .then((msg) => {
          if (msg.proposal_open_contract) handle(msg.proposal_open_contract);
        })
        .catch(() => {
          /* stream errors surface on the trade; the timeout still ends the wait */
        });
    });
  }

  private applySettlement(trade: Trade, poc: Poc | null) {
    if (!poc) {
      trade.error = "Still open on Deriv. It did not settle in time — check the contract there.";
      return;
    }
    trade.profit = num(poc.profit);
    trade.entry = num(poc.entry_spot) ?? trade.entry;
    trade.exit = num(poc.exit_spot);
    trade.closedAt = Date.now();
    const status = poc.status;
    const profit = trade.profit ?? 0;
    if (status === "won" || (status === "sold" && profit > 0)) trade.status = "won";
    else if (status === "lost" || status === "sold") trade.status = "lost";
    else if (status === "cancelled") {
      trade.status = "error";
      trade.error = "Deriv cancelled the contract";
    }
  }

  private refreshClock() {
    if (this.disposed) return;
    if (this.run.phase === "cooldown") {
      const left = Math.max(0, this.run.cooldownUntil - Date.now());
      if (left <= 0) {
        this.run.phase = "scanning";
        this.run.idleSince = Date.now();
        this.snapshot = {
          ...this.snapshot,
          autoPhase: "scanning",
          cooldownLeft: 0,
          tapeStatus: "Looking again.",
        };
        this.emit();
        void this.maybeAuto();
        return;
      }
      const seconds = Math.ceil(left / 1000);
      if (seconds !== this.snapshot.cooldownLeft) {
        this.snapshot = {
          ...this.snapshot,
          cooldownLeft: seconds,
          autoPhase: "cooldown",
          tapeStatus: `Cooling down · next look in ${seconds}s`,
        };
        this.emit();
      }
      return;
    }
    if (this.run.phase === "scanning" && !this.busy) {
      const idleMs = Date.now() - this.run.idleSince;
      const need = requiredScore(idleMs, this.run.streak);
      const status = waitCopy(this.snapshot.lastRead, need, this.prices.length, idleMs);
      if (need !== this.snapshot.threshold || status !== this.snapshot.tapeStatus) {
        this.snapshot = { ...this.snapshot, threshold: need, tapeStatus: status, autoPhase: "scanning" };
        this.emit();
      }
    }
  }

  private connectPublic() {
    if (this.disposed) return;
    this.publicSocket?.close();
    const socket = new DerivSocket(PUBLIC_WS, () => {
      if (this.disposed || this.publicSocket !== socket) return;
      this.schedulePublic();
    });
    this.publicSocket = socket;
    const off = socket.on((msg) => this.onPublic(msg));
    socket
      .connect()
      .then(() => {
        if (this.disposed || this.publicSocket !== socket) {
          off();
          socket.close();
          return;
        }
        this.marketAttempt = 0;
        this.snapshot = { ...this.snapshot, marketError: null };
        this.emit();
        void this.subscribeMarket();
      })
      .catch(() => {
        if (this.disposed || this.publicSocket !== socket) return;
        this.schedulePublic();
      });
  }

  private schedulePublic() {
    if (this.disposed) return;
    this.marketAttempt += 1;
    this.snapshot = { ...this.snapshot, marketError: "Market feed dropped. Reconnecting…" };
    this.emit();
    if (this.marketRetry) clearTimeout(this.marketRetry);
    const wait = Math.min(15_000, 800 * 2 ** Math.min(this.marketAttempt, 4));
    this.marketRetry = setTimeout(() => this.connectPublic(), wait);
  }

  private async subscribeMarket() {
    const socket = this.publicSocket;
    if (!socket?.isOpen || this.disposed) return;
    const gen = ++this.marketGen;
    const symbol = symbolFor(this.snapshot.vol, this.snapshot.pace);
    if (this.marketSub) {
      socket.send({ forget: this.marketSub });
      this.marketSub = null;
    }
    try {
      const msg = await socket.request({
        ticks_history: symbol,
        end: "latest",
        count: 180,
        start: 1,
        style: "ticks",
        subscribe: 1,
      });
      if (this.disposed || gen !== this.marketGen) {
        if (msg.subscription?.id) socket.send({ forget: msg.subscription.id });
        return;
      }
      const prices = (msg.history?.prices ?? []).map(Number).filter((value) => Number.isFinite(value));
      this.prices = prices.slice(-180);
      this.quote = this.prices[this.prices.length - 1] ?? null;
      this.pip = asPip(msg.pip_size, pipFor(symbol));
      this.marketSub = msg.subscription?.id ?? null;
      this.snapshot = { ...this.snapshot, marketError: null };
      this.emit();
      if (this.run.phase === "scanning") void this.maybeAuto();
    } catch (error) {
      if (this.disposed || gen !== this.marketGen) return;
      this.snapshot = {
        ...this.snapshot,
        marketError: error instanceof Error ? error.message : "Could not load this index",
      };
      this.emit();
    }
  }

  private onPublic(msg: DerivMsg) {
    if (msg.msg_type !== "tick" || !msg.tick) return;
    const symbol = symbolFor(this.snapshot.vol, this.snapshot.pace);
    if (msg.tick.symbol && msg.tick.symbol !== symbol) return;
    const quote = num(msg.tick.quote);
    if (quote == null) return;
    this.prices.push(quote);
    if (this.prices.length > 180) this.prices.shift();
    this.quote = quote;
    this.pip = asPip(msg.tick.pip_size, this.pip);
    if (this.counting && this.open) {
      this.open.ticksSeen = Math.min(TICKS, this.open.ticksSeen + 1);
      this.upsert(this.open);
      this.progressCb?.(this.open.ticksSeen);
    }
    if (this.run.phase === "scanning") void this.maybeAuto();
    this.emit();
  }

  private async openTradeSocket(account: RemoteAccount) {
    const gen = ++this.tradeGen;
    this.tradeSocket?.close();
    this.tradeSocket = null;
    if (this.tradeRetry) clearTimeout(this.tradeRetry);
    const url = await fetchOtp(this.snapshot.token, this.snapshot.appId, account.accountId);
    if (this.disposed || gen !== this.tradeGen) return;
    const socket = new DerivSocket(url, () => {
      if (this.disposed || this.tradeSocket !== socket) return;
      this.scheduleTradeReconnect();
    });
    this.tradeSocket = socket;
    socket.on((msg) => this.onTrade(msg));
    await socket.connect();
    if (this.disposed || gen !== this.tradeGen) {
      socket.close();
      return;
    }
    this.tradeAttempt = 0;
    try {
      await socket.request({ balance: 1, subscribe: 1 });
    } catch {
      /* balance on the account list is enough to start */
    }
    if (this.open?.contractId) {
      socket.send({
        proposal_open_contract: 1,
        contract_id: this.open.contractId,
        subscribe: 1,
      });
    }
    this.snapshot = { ...this.snapshot, conn: "live", connError: null };
    this.emit();
  }

  private scheduleTradeReconnect() {
    if (this.disposed || this.snapshot.conn === "off") return;
    const account = this.active();
    if (!account || !this.snapshot.token.trim()) return;
    this.tradeAttempt += 1;
    this.snapshot = {
      ...this.snapshot,
      conn: "connecting",
      connError: "Trading connection dropped. Signing back in…",
    };
    this.emit();
    if (this.tradeRetry) clearTimeout(this.tradeRetry);
    const wait = Math.min(12_000, 700 * 2 ** Math.min(this.tradeAttempt, 4));
    this.tradeRetry = setTimeout(() => {
      void this.openTradeSocket(account).catch((error) => {
        if (this.disposed) return;
        this.snapshot = {
          ...this.snapshot,
          conn: "error",
          connError: error instanceof Error ? error.message : "Could not reconnect",
        };
        this.emit();
        if (this.tradeAttempt < 4) this.scheduleTradeReconnect();
      });
    }, wait);
  }

  private onTrade(msg: DerivMsg) {
    if (msg.msg_type === "balance" && msg.balance) {
      const balance = num(msg.balance.balance);
      const account = this.active();
      if (balance != null && account) this.patchBalance(account.accountId, balance);
      if (typeof msg.balance.currency === "string" && account) {
        this.accounts = this.accounts.map((item) =>
          item.accountId === account.accountId ? { ...item, currency: msg.balance?.currency || item.currency } : item,
        );
        this.snapshot = { ...this.snapshot, accounts: this.accounts.slice() };
        this.emit();
      }
    }
    if (msg.msg_type === "proposal_open_contract" && msg.proposal_open_contract) {
      this.onPoc?.(msg.proposal_open_contract);
    }
  }

  private patchBalance(accountId: string, balance: number) {
    this.accounts = this.accounts.map((account) =>
      account.accountId === accountId ? { ...account, balance } : account,
    );
    this.snapshot = { ...this.snapshot, accounts: this.accounts.slice() };
    this.emit();
  }

  private async waitForSamples(count: number, timeoutMs: number) {
    const started = Date.now();
    while (this.prices.length < count) {
      if (Date.now() - started > timeoutMs) {
        throw new Error("This index is not printing ticks yet. Try another volatility.");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (this.disposed) throw new Error("Closed");
    }
  }

  private setInstant(progress: number, phase: string) {
    if (!this.snapshot.instant || this.snapshot.instant.done) return;
    this.snapshot = {
      ...this.snapshot,
      instant: { ...this.snapshot.instant, progress: Math.max(this.snapshot.instant.progress, progress), phase },
    };
    this.emit();
  }

  private upsert(trade: Trade) {
    const index = this.trades.findIndex((item) => item.id === trade.id);
    if (index === -1) this.trades = [trade, ...this.trades].slice(0, 100);
    else {
      const next = this.trades.slice();
      next[index] = { ...trade };
      this.trades = next;
    }
    this.persist();
  }

  private finishAuto(phase: "off" | "target" | "stopped", message: string) {
    this.run.phase = phase;
    this.run.stopRequested = true;
    this.snapshot = {
      ...this.snapshot,
      autoPhase: phase,
      cooldownLeft: 0,
      tapeStatus: message,
      sessionPnl: this.run.pnl,
      lossStreak: this.run.streak,
    };
    this.emit();
  }

  private ensureReady(): boolean {
    if (this.snapshot.conn !== "live" || !this.tradeSocket?.isOpen) {
      this.failForm("Connect your Deriv token first. Demo and real both work once the token is in.");
      return false;
    }
    return true;
  }

  private needsGate(): boolean {
    return this.active()?.accountType === "real" && !this.snapshot.liveArmed;
  }

  private isAutoLive(): boolean {
    return this.run.phase === "scanning" || this.run.phase === "trading" || this.run.phase === "cooldown";
  }

  private active(): RemoteAccount | null {
    return this.accounts.find((account) => account.accountId === this.snapshot.activeId) ?? null;
  }

  private failForm(message: string) {
    this.snapshot = { ...this.snapshot, formError: message };
    this.emit();
  }

  private emit() {
    if (this.disposed) return;
    this.snapshot = {
      ...this.snapshot,
      prices: this.prices.slice(),
      quote: this.quote,
      pip: this.pip,
      trades: this.trades.slice(),
      accounts: this.accounts.slice(),
      sessionPnl: this.run.pnl,
      lossStreak: this.run.streak,
      autoPhase: this.run.phase,
    };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private persist() {
    if (typeof localStorage === "undefined") return;
    const saved: Saved = {
      appId: this.snapshot.appId,
      token: this.snapshot.token,
      activeId: this.snapshot.activeId ?? undefined,
      vol: this.snapshot.vol,
      pace: this.snapshot.pace,
      stake: this.snapshot.stake,
      target: this.snapshot.target,
      stop: this.snapshot.stop,
      trades: this.trades.slice(0, 100), // keep more history
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
      /* private mode can refuse storage; the session still runs */
    }
  }

  private restore() {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Saved;
      this.trades = Array.isArray(saved.trades) ? saved.trades.slice(0, 100) : [];
      this.snapshot = {
        ...this.snapshot,
        appId: typeof saved.appId === "string" ? saved.appId : "",
        token: typeof saved.token === "string" ? saved.token : "",
        activeId: typeof saved.activeId === "string" ? saved.activeId : null,
        vol: isVol(saved.vol) ? saved.vol : 100,
        pace: saved.pace === "standard" || saved.pace === "one" ? saved.pace : "one",
        stake: typeof saved.stake === "string" ? saved.stake : "1",
        target: typeof saved.target === "string" ? saved.target : "10",
        stop: typeof saved.stop === "string" ? saved.stop : "10",
        trades: this.trades.slice(),
        pip: pipFor(
          symbolFor(
            isVol(saved.vol) ? saved.vol : 100,
            saved.pace === "standard" ? "standard" : "one",
          ),
        ),
      };
    } catch {
      /* ignore a corrupt local draft */
    }
  }
}
