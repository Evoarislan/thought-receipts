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
  /**
   * Data provenance, present only on receipts whose step fetched or
   * checked data: the SQL the step ran against the data layer. The same
   * SQL text is recorded when the bundled CSV fallback served the fetch,
   * because it is the query the fetch stands for in both modes. Null on
   * the integrity receipt, whose rows are a working copy that no query
   * returned. Absent on non-data receipts.
   */
  query?: string | null;
  /**
   * Data provenance: the rows the step's fetch actually used, one record
   * per vendor, keyed by source column name. Recorded so a later replay
   * can re-derive the rows from the sources and diff them against what
   * the step saw.
   */
  rows?: Array<Record<string, string | number | null>>;
  /** Data provenance: which path served the rows, live Zetaris SQL, the bundled CSV fallback, or the run's working catalog. */
  dataSource?: "zetaris" | "csv-fallback" | "working-catalog";
  /**
   * Dual-language receipts: a plain-English rendering of the step's query
   * and the rows it returned, generated from the query intent and the
   * actual rows (never hand-written per run).
   */
  plainEnglish?: string;
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
  /** True only when every receipt is a mock payment (kept for compatibility). */
  mock: boolean;
  /**
   * How the receipts' payment modes break down: "all" mock, "none" mock
   * (every step live-signed), or "partial" (a mix of the two).
   */
  mockSummary: "all" | "partial" | "none";
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
  const mockCount = receipts.filter((r) => r.mock).length;
  return {
    totalUSDC: total.toFixed(2),
    lines,
    mock: receipts.length > 0 && receipts.every((r) => r.mock),
    mockSummary:
      mockCount === 0 ? "none" : mockCount === receipts.length ? "all" : "partial",
  };
}

/** "This answer cost $0.07 across 7 reasoning steps." */
export function billWowLine(bill: Bill): string {
  // The evaluator is a free system verification step, not a paid reasoning
  // step, so it never counts toward the step total.
  const n = bill.lines.filter((l) => l.status !== "failed" && l.agent !== "evaluator").length;
  return `This answer cost $${bill.totalUSDC} across ${n} reasoning step${n === 1 ? "" : "s"}. Every step is receipted above.`;
}
