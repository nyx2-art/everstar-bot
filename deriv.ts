export const PUBLIC_WS = "wss://api.derivws.com/trading/v1/options/ws/public";
export const API_ROOT = "https://api.derivws.com";

export interface Poc {
  contract_id?: number;
  status?: string | null;
  profit?: string | number | null;
  entry_spot?: string | number | null;
  exit_spot?: string | number | null;
  is_sold?: number;
  buy_price?: string | number | null;
}

export interface DerivMsg {
  msg_type?: string;
  req_id?: number;
  error?: { code?: string; message?: string; details?: unknown };
  subscription?: { id?: string };
  history?: { prices?: number[]; times?: number[] };
  pip_size?: number;
  tick?: { quote?: number; symbol?: string; epoch?: number; pip_size?: number };
  proposal?: {
    id?: string;
    ask_price?: number;
    payout?: number;
    spot?: number;
    longcode?: string;
  };
  buy?: {
    contract_id?: number;
    buy_price?: number;
    payout?: number;
    balance_after?: number;
    longcode?: string;
  };
  proposal_open_contract?: Poc;
  balance?: { balance?: number; currency?: string; loginid?: string };
  ping?: string;
}

type Pending = {
  resolve: (msg: DerivMsg) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class DerivSocket {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(msg: DerivMsg) => void>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUser = false;
  private opened = false;

  constructor(
    private readonly url: string,
    private readonly onDown?: () => void,
  ) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    this.closedByUser = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ok = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Could not open Deriv"));
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        this.opened = true;
        this.pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 }));
        }, 25_000);
        ok();
      };
      ws.onerror = () => {
        if (!this.opened) fail(new Error("Could not reach Deriv"));
      };
      ws.onclose = () => {
        this.clearPing();
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Deriv connection closed"));
          this.pending.delete(id);
        }
        if (!settled) fail(new Error("Deriv connection closed"));
        if (!this.closedByUser) this.onDown?.();
      };
      ws.onmessage = (event) => {
        let msg: DerivMsg;
        try {
          msg = JSON.parse(String(event.data)) as DerivMsg;
        } catch {
          return;
        }
        const reqId = msg.req_id;
        if (reqId && this.pending.has(reqId)) {
          const pending = this.pending.get(reqId)!;
          clearTimeout(pending.timer);
          this.pending.delete(reqId);
          if (msg.error?.message) pending.reject(new Error(msg.error.message));
          else pending.resolve(msg);
        }
        for (const listener of this.listeners) listener(msg);
      };
    });
  }

  on(listener: (msg: DerivMsg) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(payload: Record<string, unknown>, timeoutMs = 20_000): Promise<DerivMsg> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Not connected to Deriv"));
    }
    const req_id = this.reqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error("Deriv took too long to answer"));
      }, timeoutMs);
      this.pending.set(req_id, { resolve, reject, timer });
      this.ws?.send(JSON.stringify({ ...payload, req_id }));
    });
  }

  send(payload: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  close() {
    this.closedByUser = true;
    this.clearPing();
    this.ws?.close();
    this.ws = null;
  }

  private clearPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}

function authHeaders(token: string, appId: string): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token.trim()}`);
  headers.set("Content-Type", "application/json");
  if (appId.trim()) headers.set("Deriv-App-ID", appId.trim());
  return headers;
}

function parseBody(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function errorText(body: Record<string, unknown> | null, raw: string): string {
  if (body) {
    if (typeof body.message === "string" && body.message.trim()) return body.message;
    const errors = body.errors;
    if (Array.isArray(errors)) {
      const messages = errors
        .map((item) =>
          item && typeof item === "object" && "message" in item ? String(item.message) : "",
        )
        .filter(Boolean);
      if (messages.length) return messages.join(" ");
    }
    const error = body.error;
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
      return error.message;
    }
  }
  const trimmed = raw.trim();
  if (trimmed && !trimmed.startsWith("{") && !trimmed.startsWith("<")) return trimmed.slice(0, 280);
  return "Deriv rejected the request";
}

export interface RemoteAccount {
  accountId: string;
  balance: number;
  currency: string;
  accountType: "demo" | "real";
  status: "active" | "inactive";
}

export async function fetchAccounts(token: string, appId: string): Promise<RemoteAccount[]> {
  const response = await fetch(`${API_ROOT}/trading/v1/options/accounts`, {
    headers: authHeaders(token, appId),
  });
  const raw = await response.text();
  const body = parseBody(raw);
  if (!response.ok) throw new Error(errorText(body, raw));
  const data = body?.data;
  const rows = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { accounts?: unknown }).accounts)
      ? (data as { accounts: unknown[] }).accounts
      : [];
  const accounts: RemoteAccount[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const accountId = String(record.account_id ?? record.accountId ?? "").trim();
    const kind = record.account_type;
    if (!accountId || (kind !== "demo" && kind !== "real")) continue;
    const balance = typeof record.balance === "number" ? record.balance : Number(record.balance);
    accounts.push({
      accountId,
      balance: Number.isFinite(balance) ? balance : 0,
      currency: typeof record.currency === "string" && record.currency ? record.currency : "USD",
      accountType: kind,
      status: record.status === "inactive" ? "inactive" : "active",
    });
  }
  return accounts;
}

export async function fetchOtp(token: string, appId: string, accountId: string): Promise<string> {
  const response = await fetch(
    `${API_ROOT}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
    { method: "POST", headers: authHeaders(token, appId) },
  );
  const raw = await response.text();
  const body = parseBody(raw);
  if (!response.ok) throw new Error(errorText(body, raw));
  const data = body?.data;
  const url =
    data && typeof data === "object" && "url" in data
      ? (data as { url?: unknown }).url
      : body?.url;
  if (typeof url !== "string" || !url.startsWith("wss://")) {
    throw new Error("Deriv did not return a trading connection");
  }
  return url;
}
