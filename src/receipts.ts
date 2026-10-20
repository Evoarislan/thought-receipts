/**
 * Receipt chain: every paid reasoning step becomes one receipt.
 * The bill is the itemized sum of the chain.
 */
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
}

export interface BillLine {
  seq: number;
  title: string;
  agent: string;
  amountUSDC: string;
}

export interface Bill {
  totalUSDC: string;
  lines: BillLine[];
  mock: boolean;
}

export function buildBill(receipts: Receipt[]): Bill {
  const lines: BillLine[] = receipts.map((r) => ({
    seq: r.seq,
    title: r.title,
    agent: r.agent,
    amountUSDC: r.amountUSDC,
  }));
  const total = receipts.reduce((sum, r) => sum + Number(r.amountUSDC), 0);
  return {
    totalUSDC: total.toFixed(2),
    lines,
    mock: receipts.length > 0 && receipts.every((r) => r.mock),
  };
}

/** "This answer cost $0.07 across 7 reasoning steps." */
export function billWowLine(bill: Bill): string {
  const n = bill.lines.length;
  return `This answer cost $${bill.totalUSDC} across ${n} reasoning step${n === 1 ? "" : "s"}. Every step is receipted above.`;
}
