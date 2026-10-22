/**
 * Receipt chain: every paid reasoning step becomes one receipt.
 * The bill is the itemized sum of the chain.
 *
 * Tamper-evidence: each receipt carries prevHash and hash. hash is the
 * sha256 hex of (prevHash + canonical JSON of the receipt, minus the hash
 * field itself). The first receipt uses prevHash "GENESIS". Anyone can
 * recompute the chain with /api/verify; a single altered character breaks
 * every hash downstream of the edit.
 */
import { createHash } from "node:crypto";

export type ReceiptStatus = "ok" | "failed" | "recovered";

export interface Receipt {
  seq: number;
  agent: string;
  step: string;
  title: string;
  inputSummary: string;
  inputFull: string;
  outputSummary: string;
  detail: string;
  amountUSDC: string;
  payer: string;
  payee: string;
  txRef: string;
  timestamp: string;
  mock: boolean;
  /** True when this receipt was re-executed via a challenge. */
  rechained: boolean;
  /** ok = paid step, failed = first attempt that errored, recovered = retry. */
  status: ReceiptStatus;
  /** Optional note, e.g. failure or recovery details. */
  note?: string;
  /** Model that produced this step's output, or "deterministic" for template logic. */
  model: string;
  /** Agent that receives the handoff after this step, or null at the end of the chain. */
  targetAgent: string | null;
  /** Retry count for this step: 0 for a first attempt, incremented on retries. */
  retryCount: number;
  /** Hash of the previous receipt in the chain, or "GENESIS" for the first. */
  prevHash: string;
  /** sha256 hex of (prevHash + canonical JSON of this receipt minus hash). */
  hash: string;
}

export interface BillLine {
  seq: number;
  title: string;
  agent: string;
  amountUSDC: string;
  status: ReceiptStatus;
  note?: string;
}

export interface Bill {
  totalUSDC: string;
  lines: BillLine[];
  mock: boolean;
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(rec[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashForReceipt(
  prevHash: string,
  body: Record<string, unknown>
): string {
  return createHash("sha256")
    .update(prevHash + canonicalize(body))
    .digest("hex");
}

/** Body of a receipt for hashing: everything except the hash itself. */
export function receiptHashBody(r: Receipt): Record<string, unknown> {
  const body = { ...(r as unknown as Record<string, unknown>) };
  delete body.hash;
  return body;
}

/**
 * Seal a list of receipts into a hash chain, in order. Mutates and returns
 * the same array.
 */
export function chainReceipts(receipts: Receipt[]): Receipt[] {
  let prev = "GENESIS";
  for (const r of receipts) {
    r.prevHash = prev;
    r.hash = hashForReceipt(prev, receiptHashBody(r));
    prev = r.hash;
  }
  return receipts;
}

/** Recompute the chain. Returns the first broken sequence number, if any. */
export function verifyChain(receipts: Receipt[]): {
  valid: boolean;
  brokenAt?: number;
} {
  let prev = "GENESIS";
  for (const r of receipts) {
    if (r.prevHash !== prev) return { valid: false, brokenAt: r.seq };
    if (hashForReceipt(prev, receiptHashBody(r)) !== r.hash) {
      return { valid: false, brokenAt: r.seq };
    }
    prev = r.hash;
  }
  return { valid: true };
}

export function buildBill(receipts: Receipt[]): Bill {
  const lines: BillLine[] = receipts.map((r) => ({
    seq: r.seq,
    title: r.title,
    agent: r.agent,
    amountUSDC: r.amountUSDC,
    status: r.status,
    note: r.note,
  }));
  // Failed attempts are listed at $0; only successful payments add up.
  const total = receipts
    .filter((r) => r.status !== "failed")
    .reduce((sum, r) => sum + Number(r.amountUSDC), 0);
  return {
    totalUSDC: total.toFixed(2),
    lines,
    mock: receipts.length > 0 && receipts.every((r) => r.mock),
  };
}

/** "This answer cost $0.07 across 7 reasoning steps." */
export function billWowLine(bill: Bill): string {
  // The evaluator is a free system verification step, not a paid reasoning
  // step, so it never counts toward the step total.
  const n = bill.lines.filter((l) => l.status !== "failed" && l.agent !== "evaluator").length;
  return `This answer cost $${bill.totalUSDC} across ${n} reasoning step${n === 1 ? "" : "s"}. Every step is receipted above.`;
}
