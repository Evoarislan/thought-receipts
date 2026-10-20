/**
 * Thought Receipts pipeline: a coordinator agent breaks the user's task into
 * subtasks, then three specialist agents (research, compute, synthesize) each
 * execute behind a $0.01 x402 paywall. Every step pays first, reasons second,
 * and emits a receipt third. The receipt chain is the explanation of "why".
 *
 * Demo scenario: vendor selection for a cloud infrastructure contract. The
 * receipt chain explains a decision with real dollars behind it: quotes in,
 * 3-year total cost of ownership out, recommendation with the math attached.
 *
 * Reasoning is deterministic mock logic so the demo runs with zero API keys.
 * LLM adapter seam: replace any executor's body with a call to
 * reasonWithModel() later; the receipt shape stays identical.
 */
import { payForStep, AGENT_WALLETS, USER_WALLET, PRICE_PER_STEP_USDC } from "./x402.js";
import { chainReceipts, type Receipt, type ReceiptStatus } from "./receipts.js";

export const STEP_COUNT = 7;
export const PRICE_PER_STEP = PRICE_PER_STEP_USDC;

export type AgentName = "coordinator" | "research" | "compute" | "synthesize";

export interface Vendor {
  name: string;
  headlineAnnual: number;
  egressPerGB: number;
  /** TB/yr included at egressPerGB; null means no cap. */
  egressCapTB: number | null;
  egressOveragePerGB: number;
  supportAnnual: number;
  supportTier: string;
  sla: string;
  differentiator: string;
}

export interface TaskProfile {
  contractAnnual: number;
  termYears: number;
}

/**
 * LLM adapter seam. Wire a model call here to upgrade an executor from
 * deterministic mock logic to real reasoning. The receipt shape does not
 * change, so the UI, bill, and challenge flow keep working.
 */
export async function reasonWithModel(_prompt: string): Promise<string> {
  throw new Error(
    "reasonWithModel is not configured. This scaffold uses deterministic mock reasoning so it runs with zero API keys."
  );
}

export function parseTask(task: string): TaskProfile {
  const t = task.toLowerCase();
  const money = /\$\s*([\d,]+(?:\.\d+)?)\s*([km])?/.exec(t);
  let contractAnnual = 60000;
  if (money) {
    const n = parseFloat(money[1].replace(/,/g, ""));
    const mult = money[2] === "k" ? 1000 : money[2] === "m" ? 1000000 : 1;
    contractAnnual = Math.round(n * mult);
  }
  const term = /(\d+)\s*-?\s*year/.exec(t);
  return {
    contractAnnual,
    termYears: term ? Math.min(10, Math.max(1, parseInt(term[1], 10))) : 3,
  };
}

/**
 * Annual data transfer in TB, parsed from step input. The challenge flow
 * overrides a step's input, so "double the data transfer volume" typed into
 * the challenge panel lands here and re-prices everything downstream.
 */
export function parseVolumeTB(text: string): number {
  const t = text.toLowerCase();
  const explicit = /(\d+(?:\.\d+)?)\s*tb/.exec(t);
  if (explicit) return Math.min(10000, Math.max(1, parseFloat(explicit[1])));
  if (/triple|3x|three times/.test(t)) return 1200;
  if (/double|2x|twice/.test(t)) return 800;
  if (/half/.test(t)) return 200;
  return 400;
}

function fmt(n: number): string {
  return n % 1 === 0 ? `$${n.toLocaleString("en-US")}` : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function fmtK(n: number): string {
  return `$${Math.round(n / 1000)}K`;
}

// --- Vendor catalog ----------------------------------------------------------
// Fictional vendors and illustrative quotes. Not real prices from real
// companies; the point is the shape of the decision, not the numbers.

const VENDORS: Vendor[] = [
  {
    name: "Nimbus Cloud",
    headlineAnnual: 48000,
    egressPerGB: 0.12,
    egressCapTB: null,
    egressOveragePerGB: 0.12,
    supportAnnual: 6000,
    supportTier: "business-hours ticket queue",
    sla: "99.9%",
    differentiator: "cheapest headline compute price",
  },
  {
    name: "Stratus Systems",
    headlineAnnual: 54000,
    egressPerGB: 0.04,
    egressCapTB: 500,
    egressOveragePerGB: 0.2,
    supportAnnual: 9000,
    supportTier: "24/7 engineer hotline",
    sla: "99.99%",
    differentiator: "flat low egress rate inside a 500TB/yr cap, premium support",
  },
  {
    name: "Cirrus Compute",
    headlineAnnual: 60000,
    egressPerGB: 0.09,
    egressCapTB: null,
    egressOveragePerGB: 0.09,
    supportAnnual: 4000,
    supportTier: "community forum plus tickets",
    sla: "99.95%",
    differentiator: "no egress cap, predictable cost at any scale",
  },
];

export interface TcoRow {
  vendor: Vendor;
  egressAnnual: number;
  annual: number;
  tco: number;
}

export function computeTCO(v: Vendor, volumeTB: number, termYears: number): TcoRow {
  const gb = volumeTB * 1000;
  let egressAnnual: number;
  if (v.egressCapTB !== null && volumeTB > v.egressCapTB) {
    const cappedGB = v.egressCapTB * 1000;
    egressAnnual = cappedGB * v.egressPerGB + (gb - cappedGB) * v.egressOveragePerGB;
  } else {
    egressAnnual = gb * v.egressPerGB;
  }
  const annual = v.headlineAnnual + egressAnnual + v.supportAnnual;
  return { vendor: v, egressAnnual: Math.round(egressAnnual), annual: Math.round(annual), tco: Math.round(annual * termYears) };
}

// --- Pipeline context -------------------------------------------------------

interface Ctx {
  profile: TaskProfile;
  volumeTB: number;
  tcoRows: TcoRow[];
  winner?: TcoRow;
  termsNote: string;
  recommendation: string;
  finalAnswer: string;
}

interface StepOutput {
  outputSummary: string;
  detail: string;
}

interface StepDef {
  seq: number;
  agent: AgentName;
  step: string;
  title: string;
  buildInput: (ctx: Ctx, task: string) => string;
  execute: (ctx: Ctx, input: string) => StepOutput;
}

function summarize(s: string, max = 140): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

function quoteCard(v: Vendor): string {
  const cap = v.egressCapTB === null ? "no cap" : `first ${v.egressCapTB}TB/yr at this rate, then ${fmt(v.egressOveragePerGB)}/GB overage`;
  return (
    `- ${v.name}: compute ${fmt(v.headlineAnnual)}/yr, egress ${fmt(v.egressPerGB)}/GB (${cap}), ` +
    `support ${fmt(v.supportAnnual)}/yr (${v.supportTier}), SLA ${v.sla}. Edge: ${v.differentiator}.`
  );
}

function tcoTable(rows: TcoRow[], volumeTB: number, termYears: number): string {
  const lines = rows.map(
    (r) =>
      `- ${r.vendor.name}: compute ${fmt(r.vendor.headlineAnnual)} + egress ${fmt(r.egressAnnual)} + support ${fmt(r.vendor.supportAnnual)} = ${fmt(r.annual)}/yr x ${termYears} yrs = ${fmtK(r.tco)} TCO`
  );
  return `3-year TCO at ${volumeTB}TB/yr egress:\n${lines.join("\n")}`;
}

const STEP_DEFS: StepDef[] = [
  {
    seq: 1,
    agent: "coordinator",
    step: "decompose",
    title: "Break the task into subtasks",
    buildInput: (_ctx, task) => task,
    execute: (_ctx, input) => {
      const plan = [
        "1) research vendor quotes",
        "2) profile the workload (transfer volume, term)",
        "3) check contract terms, SLAs, and support",
        "4) compute 3-year total cost of ownership per vendor",
        "5) write the recommendation with rationale",
        "6) assemble the final answer",
      ].join("\n");
      return {
        outputSummary: "Planned 6 subtasks: vendor quotes, workload profile, terms check, TCO math, recommendation, final assembly.",
        detail: `Task: "${summarize(input, 200)}"\n\nExecution plan:\n${plan}\n\nEach reasoning step below is a paid x402 call at $${PRICE_PER_STEP.toFixed(2)}.`,
      };
    },
  },
  {
    seq: 2,
    agent: "research",
    step: "gather-quotes",
    title: "Research vendor quotes",
    buildInput: (ctx, task) => `${task} :: quotes for ${fmt(ctx.profile.contractAnnual)}/yr cloud infrastructure`,
    execute: (_ctx, _input) => {
      return {
        outputSummary: `Gathered quotes from ${VENDORS.map((v) => v.name).join(", ")}. Cheapest headline: Nimbus Cloud at ${fmt(48000)}/yr.`,
        detail:
          `Vendor quotes (fictional vendors, illustrative pricing):\n` +
          VENDORS.map(quoteCard).join("\n") +
          `\n\nAll three headlines fit inside the ${fmt(60000)}/yr compute budget, so headline price alone cannot decide this.`,
      };
    },
  },
  {
    seq: 3,
    agent: "research",
    step: "profile-workload",
    title: "Profile the workload",
    buildInput: (_ctx, task) => `${task} :: workload profile: annual data transfer volume in TB, contract term, primary region`,
    execute: (ctx, input) => {
      ctx.volumeTB = parseVolumeTB(input);
      return {
        outputSummary: `Workload: ${ctx.volumeTB}TB/yr data transfer, ${ctx.profile.termYears}-year term, primary region us-east.`,
        detail:
          `Workload profile:\n` +
          `- Annual data transfer (egress): ${ctx.volumeTB}TB/yr\n` +
          `- Contract term: ${ctx.profile.termYears} years\n` +
          `- Primary region: us-east\n` +
          `- Compute budget: ${fmt(ctx.profile.contractAnnual)}/yr\n\n` +
          `Egress volume is the swing factor: it decides whether metered or capped pricing wins.`,
      };
    },
  },
  {
    seq: 4,
    agent: "research",
    step: "check-terms",
    title: "Check contract terms and support",
    buildInput: (ctx) => `contract terms for ${VENDORS.map((v) => v.name).join(", ")} at ${ctx.volumeTB}TB/yr`,
    execute: (ctx, _input) => {
      ctx.termsNote =
        `Nimbus Cloud: SLA ${VENDORS[0].sla}, ${VENDORS[0].supportTier}. Egress is uncapped and metered at the highest rate (${fmt(0.12)}/GB): ` +
        `at ${ctx.volumeTB}TB/yr egress alone costs ${fmt(Math.round(ctx.volumeTB * 1000 * 0.12))}/yr, more than the compute. Annual commit with auto-renew.\n` +
        `Stratus Systems: SLA ${VENDORS[1].sla}, ${VENDORS[1].supportTier}. Egress ${fmt(0.04)}/GB is included up to 500TB/yr, ` +
        `then ${fmt(0.2)}/GB overage. ${ctx.volumeTB <= 500 ? `At ${ctx.volumeTB}TB/yr the workload sits inside the cap with room to grow.` : `At ${ctx.volumeTB}TB/yr the workload EXCEEDS the 500TB cap; overage fees apply and erase the rate advantage.`}\n` +
        `Cirrus Compute: SLA ${VENDORS[2].sla}, ${VENDORS[2].supportTier}. Egress ${fmt(0.09)}/GB with no cap: predictable at any scale, weakest support tier. Fine for a team with in-house ops.`;
      return {
        outputSummary: "Terms checked. Flag: Nimbus egress is uncapped at the highest metered rate; Stratus pricing hinges on the 500TB cap.",
        detail: `Contract terms and risk flags:\n${ctx.termsNote}`,
      };
    },
  },
  {
    seq: 5,
    agent: "compute",
    step: "compute-tco",
    title: "Compute 3-year TCO per vendor",
    buildInput: (ctx) =>
      `3-year TCO for ${VENDORS.map((v) => v.name).join(", ")} at ${ctx.volumeTB}TB/yr egress, ` +
      `compute plus egress plus support`,
    execute: (ctx, _input) => {
      const rows = VENDORS.map((v) => computeTCO(v, ctx.volumeTB, ctx.profile.termYears));
      rows.sort((a, b) => a.tco - b.tco);
      ctx.tcoRows = rows;
      ctx.winner = rows[0];
      const order = rows.map((r) => `${r.vendor.name} ${fmtK(r.tco)}`).join(", ");
      return {
        outputSummary: `${ctx.profile.termYears}-year TCO at ${ctx.volumeTB}TB/yr: ${order}. Winner: ${ctx.winner.vendor.name}.`,
        detail:
          tcoTable(rows, ctx.volumeTB, ctx.profile.termYears) +
          `\n\nWinner on total cost: ${ctx.winner.vendor.name} at ${fmtK(ctx.winner.tco)}. ` +
          `Headline price misleads: the cheapest headline (Nimbus Cloud, ${fmt(48000)}/yr) finishes ` +
          `${rows.findIndex((r) => r.vendor.name === "Nimbus Cloud") + 1} of 3 because egress dominates the total.`,
      };
    },
  },
  {
    seq: 6,
    agent: "synthesize",
    step: "write-recommendation",
    title: "Write the recommendation",
    buildInput: (ctx) => `recommendation from TCO: winner ${ctx.winner?.vendor.name ?? "undecided"}`,
    execute: (ctx, _input) => {
      const w = ctx.winner;
      const rows = ctx.tcoRows;
      const runnerUp = rows[1];
      const nimbus = rows.find((r) => r.vendor.name === "Nimbus Cloud");
      if (!w || !runnerUp || !nimbus) {
        ctx.recommendation = "TCO not computed; cannot recommend.";
      } else {
        const savingVsRunnerUp = w.tco === runnerUp.tco ? 0 : runnerUp.tco - w.tco;
        ctx.recommendation =
          `Recommend ${w.vendor.name} for the ${ctx.profile.termYears}-year contract.\n` +
          `Rationale: ${ctx.profile.termYears}-year TCO of ${fmtK(w.tco)} at ${ctx.volumeTB}TB/yr egress, ` +
          `${fmtK(savingVsRunnerUp)} below ${runnerUp.vendor.name} (${fmtK(runnerUp.tco)}). ` +
          `Nimbus Cloud has the cheapest headline (${fmt(48000)}/yr) but finishes at ${fmtK(nimbus.tco)} because its uncapped ` +
          `${fmt(0.12)}/GB egress costs ${fmt(nimbus.egressAnnual)}/yr at this volume. All three headlines fit the ${fmt(ctx.profile.contractAnnual)}/yr ` +
          `compute budget, so the decision comes down to total cost, where ${w.vendor.name}'s ${w.vendor.differentiator} wins. ` +
          `${w.vendor.name} also carries the strongest support tier (${w.vendor.supportTier}) and SLA (${w.vendor.sla}).`;
      }
      return {
        outputSummary: `Recommends ${w?.vendor.name ?? "nobody"}: ${w ? `${fmtK(w.tco)} TCO, ${fmtK(runnerUp!.tco - w.tco)} under the runner-up` : "no winner"}.`,
        detail: ctx.recommendation,
      };
    },
  },
  {
    seq: 7,
    agent: "coordinator",
    step: "finalize",
    title: "Assemble the final answer",
    buildInput: (ctx) => `final answer: recommend ${ctx.winner?.vendor.name ?? "undecided"} at ${ctx.winner ? fmtK(ctx.winner.tco) : "?"}`,
    execute: (ctx, _input) => {
      const { profile } = ctx;
      ctx.finalAnswer =
        `Vendor recommendation for the ${fmt(profile.contractAnnual)}/yr cloud infrastructure contract (${profile.termYears}-year term, ${ctx.volumeTB}TB/yr egress).\n\n` +
        `${ctx.recommendation}\n\n` +
        `${tcoTable(ctx.tcoRows, ctx.volumeTB, profile.termYears)}\n\n` +
        `Paid for with ${STEP_COUNT} receipted reasoning steps. The receipt chain above is the full explanation of how this answer was built.`;
      return {
        outputSummary: "Final answer assembled with TCO table and recommendation.",
        detail: ctx.finalAnswer,
      };
    },
  },
];

export interface PipelineRun {
  answer: string;
  receipts: Receipt[];
}

/**
 * Run the full pipeline. `overrides` maps a step seq to replacement input
 * text: that step (and everything downstream) re-executes with the new input.
 * Used by the challenge flow.
 *
 * `chaos` simulates a step failure: the named step's first attempt fails
 * (a $0 failed receipt is recorded), the coordinator retries it (a recovered
 * receipt is recorded), and the pipeline completes. Used by the demo.
 */
export async function runPipeline(
  task: string,
  overrides: Map<number, string> = new Map(),
  chaos?: { failStep: number }
): Promise<PipelineRun> {
  const clean = task.trim().slice(0, 500);
  if (!clean) throw new Error("task is required");

  const ctx: Ctx = {
    profile: parseTask(clean),
    volumeTB: 400,
    tcoRows: [],
    termsNote: "",
    recommendation: "",
    finalAnswer: "",
  };

  const firstChanged = overrides.size > 0 ? Math.min(...overrides.keys()) : Number.POSITIVE_INFINITY;
  const receipts: Receipt[] = [];

  function pushReceipt(args: {
    def: StepDef;
    input: string;
    outputSummary: string;
    detail: string;
    payment: { from: string; to: string; amountUSDC: string; txRef: string; mock: boolean };
    status: ReceiptStatus;
    note?: string;
  }): void {
    receipts.push({
      seq: args.def.seq,
      agent: args.def.agent,
      step: args.def.step,
      title: args.def.title,
      inputSummary: summarize(args.input),
      inputFull: args.input,
      outputSummary: args.outputSummary,
      detail: args.detail,
      amountUSDC: args.payment.amountUSDC,
      payer: args.payment.from,
      payee: args.payment.to,
      txRef: args.payment.txRef,
      timestamp: new Date().toISOString(),
      mock: args.payment.mock,
      rechained: args.def.seq >= firstChanged,
      status: args.status,
      ...(args.note ? { note: args.note } : {}),
      prevHash: "",
      hash: "",
    });
  }

  for (const def of STEP_DEFS) {
    const input = overrides.get(def.seq) ?? def.buildInput(ctx, clean);
    const payee = AGENT_WALLETS[def.agent] ?? USER_WALLET;

    // Chaos: this step's first attempt fails before it runs.
    if (chaos && chaos.failStep === def.seq) {
      pushReceipt({
        def,
        input,
        outputSummary: `Attempt failed: ${def.agent} specialist timed out before producing output.`,
        detail: `Attempt 1 of step ${def.seq} ("${def.title}") failed: specialist timeout. No payment was taken. The coordinator retried the step automatically.`,
        payment: {
          from: USER_WALLET,
          to: payee,
          amountUSDC: "0",
          txRef: "no-tx",
          mock: true,
        },
        status: "failed",
        note: "specialist timeout",
      });
      // Retry: pay normally and run the step.
      const payment = await payForStep({
        from: USER_WALLET,
        to: payee,
        amountUSDC: PRICE_PER_STEP,
        memo: `thought-receipts/${def.step}`,
      });
      const out = def.execute(ctx, input);
      pushReceipt({
        def,
        input,
        outputSummary: out.outputSummary,
        detail: out.detail,
        payment: {
          from: payment.from,
          to: payment.to,
          amountUSDC: payment.amountUSDC,
          txRef: payment.txRef,
          mock: payment.mock,
        },
        status: "recovered",
        note: "retry succeeded",
      });
      continue;
    }

    // Every reasoning step is paid before it runs.
    const payment = await payForStep({
      from: USER_WALLET,
      to: payee,
      amountUSDC: PRICE_PER_STEP,
      memo: `thought-receipts/${def.step}`,
    });
    const out = def.execute(ctx, input);
    pushReceipt({
      def,
      input,
      outputSummary: out.outputSummary,
      detail: out.detail,
      payment: {
        from: payment.from,
        to: payment.to,
        amountUSDC: payment.amountUSDC,
        txRef: payment.txRef,
        mock: payment.mock,
      },
      status: "ok",
    });
  }

  // Seal the chain: every receipt gets prevHash/hash in order.
  chainReceipts(receipts);
  return { answer: ctx.finalAnswer, receipts };
}
