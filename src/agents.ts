/**
 * Thought Receipts pipeline: a coordinator agent breaks the user's task into
 * subtasks, then three specialist agents (research, compute, synthesize) each
 * execute behind a $0.01 x402 paywall. Every step pays first, reasons second,
 * and emits a receipt third. The receipt chain is the explanation of "why".
 * After the coordinator assembles the answer, a free evaluator step verifies
 * the recommendation against the receipts themselves before the run returns.
 *
 * Demo scenario: vendor selection for a cloud infrastructure contract. The
 * receipt chain explains a decision with real dollars behind it: quotes in,
 * 3-year total cost of ownership out, recommendation with the math attached.
 *
 * Reasoning is deterministic logic so the demo runs with zero API keys. Two
 * model seams exist on top of it: the why box drafts answers through
 * reasonWithModel() (see why.ts), and the evaluator adds a model critique of
 * the synthesis when a model is configured.
 *
 * SAMPLE_MODE=true (see below) disables every model call, so a run makes no
 * external network requests at all. That is the documented mode for judges
 * who have no API keys.
 */
import { payForStep, AGENT_WALLETS, USER_WALLET, PRICE_PER_STEP_USDC, MOCK_MODE } from "./x402.js";
import { chainReceipts, type Receipt, type ReceiptStatus } from "./receipts.js";

export const STEP_COUNT = 7;
export const PRICE_PER_STEP = PRICE_PER_STEP_USDC;

/**
 * SAMPLE_MODE=true: fully offline sample run. No external network calls are
 * made at all (reasonWithModel refuses to run), reasoning stays on the
 * deterministic path, the why box uses its template answers, and the
 * evaluator runs its deterministic checks only. Disclosed in /api/health,
 * in the run payloads, and in a UI banner. Default: false.
 */
export const SAMPLE_MODE =
  (process.env.SAMPLE_MODE ?? "").trim().toLowerCase() === "true";

export type AgentName = "coordinator" | "research" | "compute" | "synthesize" | "evaluator";

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
 *
 * OpenRouter fallback (verified Oct 20, 2026): set OPENROUTER_API_KEY and the
 * why-box drafts from real Nemotron reasoning over the OpenAI-compatible
 * endpoint. No key set -> identical behavior to the unconfigured stub, so the
 * demo still runs with zero API keys.
 */
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
];
const NOT_CONFIGURED =
  "reasonWithModel is not configured. This scaffold uses deterministic mock reasoning so it runs with zero API keys.";

async function callOpenRouter(prompt: string, apiKey: string, model: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/Evoarislan/thought-receipts",
        "X-Title": "Thought Receipts (Open Agent Hackathon)",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 600,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenRouter ${res.status} for ${model}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error(`OpenRouter returned no content for ${model}.`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export interface ModelResult {
  text: string;
  /** The exact model id that produced the text. */
  model: string;
}

/**
 * Like reasonWithModel, but also reports which model answered, so callers
 * (the evaluator) can record the truth in their receipt. In SAMPLE_MODE this
 * throws before any network call is attempted, even if a key is set.
 */
export async function reasonWithModelDetailed(prompt: string): Promise<ModelResult> {
  if (SAMPLE_MODE) {
    throw new Error(
      "SAMPLE_MODE is on: model calls are disabled, so a run makes no external network requests."
    );
  }
  const apiKey = (process.env.OPENROUTER_API_KEY ?? "").trim();
  if (!apiKey) throw new Error(NOT_CONFIGURED);
  let lastErr: unknown = null;
  for (const model of OPENROUTER_MODELS) {
    try {
      return { text: await callOpenRouter(prompt, apiKey, model), model };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function reasonWithModel(prompt: string): Promise<string> {
  return (await reasonWithModelDetailed(prompt)).text;
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

// --- Scope gate ---------------------------------------------------------------
// This network answers one kind of question: vendor, supplier, and cloud
// provider selection for an infrastructure contract. Anything else is
// declined honestly at the gate instead of being forced through the vendor
// pipeline. Strong terms pass on their own; a generic term like "cloud" or
// "contract" also needs a selection signal so unrelated tasks stay out.

const STRONG_SCOPE_TERMS: RegExp[] = [
  /\bvendors?\b/,
  /\bsuppliers?\b/,
  /\bprocurement\b/,
  /\bcloud providers?\b/,
  /\bcloud infrastructure\b/,
  /\binfrastructure contracts?\b/,
  /\brfp\b/,
  /\btotal cost of ownership\b/,
  /\btco\b/,
  /\begress\b/,
];

const WEAK_SCOPE_TERMS: RegExp[] = [
  /\bcloud\b/,
  /\bproviders?\b/,
  /\bcontracts?\b/,
  /\bhosting\b/,
  /\binfrastructure\b/,
  /\bsaas\b/,
];

const SELECTION_TERMS: RegExp[] = [
  /\bselect/,
  /\bchoose\b/,
  /\bchoice\b/,
  /\bpick\b/,
  /\bevaluat/,
  /\bcompar/,
  /\bdecid/,
  /\brecommend/,
  /\bswitch/,
  /\bmigrat/,
];

export function isInScope(task: string): boolean {
  const t = task.toLowerCase();
  if (STRONG_SCOPE_TERMS.some((re) => re.test(t))) return true;
  const weakHits = WEAK_SCOPE_TERMS.filter((re) => re.test(t)).length;
  if (weakHits >= 2) return true;
  return weakHits >= 1 && SELECTION_TERMS.some((re) => re.test(t));
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
  /** Optional dynamic title, e.g. when the label depends on the task's term. */
  buildTitle?: (ctx: Ctx) => string;
  buildInput: (ctx: Ctx, task: string) => string;
  execute: (ctx: Ctx, input: string) => StepOutput;
}

/** "Stratus Systems" -> "Stratus Systems'"; "Nimbus Cloud" -> "Nimbus Cloud's". */
function possessive(name: string): string {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
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
  return `${termYears}-year TCO at ${volumeTB}TB/yr egress:\n${lines.join("\n")}`;
}

const STEP_DEFS: StepDef[] = [
  {
    seq: 1,
    agent: "coordinator",
    step: "decompose",
    title: "Break the task into subtasks",
    buildInput: (_ctx, task) => task,
    execute: (ctx, input) => {
      const plan = [
        "1) research vendor quotes",
        "2) profile the workload (transfer volume, term)",
        "3) check contract terms, SLAs, and support",
        `4) compute ${ctx.profile.termYears}-year total cost of ownership per vendor`,
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
    execute: (ctx, _input) => {
      const cheapest = VENDORS.reduce((a, b) => (b.headlineAnnual < a.headlineAnnual ? b : a));
      const budget = ctx.profile.contractAnnual;
      const fitting = VENDORS.filter((v) => v.headlineAnnual <= budget);
      const budgetNote =
        fitting.length === VENDORS.length
          ? `All ${VENDORS.length} headlines fit inside the ${fmt(budget)}/yr compute budget, so headline price alone cannot decide this.`
          : `${fitting.length} of ${VENDORS.length} headlines fit inside the ${fmt(budget)}/yr compute budget (${fitting.map((v) => v.name).join(", ")}); the rest open above budget, so total cost matters even more.`;
      return {
        outputSummary: `Gathered quotes from ${VENDORS.map((v) => v.name).join(", ")}. Cheapest headline: ${cheapest.name} at ${fmt(cheapest.headlineAnnual)}/yr.`,
        detail:
          `Vendor quotes (fictional vendors, illustrative pricing):\n` +
          VENDORS.map(quoteCard).join("\n") +
          `\n\n${budgetNote}`,
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
      const [nimbus, stratus, cirrus] = VENDORS;
      ctx.termsNote =
        `Nimbus Cloud: SLA ${nimbus.sla}, ${nimbus.supportTier}. Egress is uncapped and metered at the highest rate (${fmt(nimbus.egressPerGB)}/GB): ` +
        `at ${ctx.volumeTB}TB/yr egress alone costs ${fmt(Math.round(ctx.volumeTB * 1000 * nimbus.egressPerGB))}/yr, rivaling the compute. Annual commit with auto-renew.\n` +
        `Stratus Systems: SLA ${stratus.sla}, ${stratus.supportTier}. Egress ${fmt(stratus.egressPerGB)}/GB is included up to ${stratus.egressCapTB}TB/yr, ` +
        `then ${fmt(stratus.egressOveragePerGB)}/GB overage. ${stratus.egressCapTB !== null && ctx.volumeTB <= stratus.egressCapTB ? `At ${ctx.volumeTB}TB/yr the workload sits inside the cap with room to grow.` : `At ${ctx.volumeTB}TB/yr the workload EXCEEDS the ${stratus.egressCapTB}TB cap; overage fees apply and erase the rate advantage.`}\n` +
        `Cirrus Compute: SLA ${cirrus.sla}, ${cirrus.supportTier}. Egress ${fmt(cirrus.egressPerGB)}/GB with no cap: predictable at any scale, weakest support tier. Fine for a team with in-house ops.`;
      return {
        outputSummary: `Terms checked. Flag: Nimbus egress is uncapped at the highest metered rate; Stratus pricing hinges on the ${stratus.egressCapTB}TB cap.`,
        detail: `Contract terms and risk flags:\n${ctx.termsNote}`,
      };
    },
  },
  {
    seq: 5,
    agent: "compute",
    step: "compute-tco",
    title: "Compute TCO per vendor",
    buildTitle: (ctx) => `Compute ${ctx.profile.termYears}-year TCO per vendor`,
    buildInput: (ctx) =>
      `${ctx.profile.termYears}-year TCO for ${VENDORS.map((v) => v.name).join(", ")} at ${ctx.volumeTB}TB/yr egress, ` +
      `compute plus egress plus support`,
    execute: (ctx, _input) => {
      const rows = VENDORS.map((v) => computeTCO(v, ctx.volumeTB, ctx.profile.termYears));
      rows.sort((a, b) => a.tco - b.tco);
      ctx.tcoRows = rows;
      ctx.winner = rows[0];
      const order = rows.map((r) => `${r.vendor.name} ${fmtK(r.tco)}`).join(", ");
      const cheapestHeadline = rows.reduce((a, b) => (b.vendor.headlineAnnual < a.vendor.headlineAnnual ? b : a));
      const runnerUp = rows[1];
      return {
        outputSummary: `${ctx.profile.termYears}-year TCO at ${ctx.volumeTB}TB/yr: ${order}. Winner: ${ctx.winner.vendor.name}.`,
        detail:
          tcoTable(rows, ctx.volumeTB, ctx.profile.termYears) +
          `\n\nWinner on total cost: ${ctx.winner.vendor.name} at ${fmtK(ctx.winner.tco)}, ` +
          `${fmtK(runnerUp.tco - ctx.winner.tco)} below the runner-up ${runnerUp.vendor.name} (${fmtK(runnerUp.tco)}). ` +
          `Headline price misleads: the cheapest headline (${cheapestHeadline.vendor.name}, ${fmt(cheapestHeadline.vendor.headlineAnnual)}/yr) finishes ` +
          `${rows.indexOf(cheapestHeadline) + 1} of 3 because egress dominates the total.`,
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
        // Support and SLA claims come from the winner's own record. A
        // superlative is used only when the data supports it: the SLA
        // figure is the highest in the field, or the support package is
        // the most comprehensive (priciest) in the field.
        const bestSla = Math.max(...VENDORS.map((v) => parseFloat(v.sla)));
        const slaClaim =
          parseFloat(w.vendor.sla) >= bestSla
            ? `It also carries the strongest SLA in the field at ${w.vendor.sla}.`
            : `Its SLA is ${w.vendor.sla}.`;
        const priciestSupport = Math.max(...VENDORS.map((v) => v.supportAnnual));
        const supportClaim =
          w.vendor.supportAnnual >= priciestSupport
            ? `Support is ${w.vendor.supportTier} at ${fmt(w.vendor.supportAnnual)}/yr, the most comprehensive package in the field.`
            : `Support is ${w.vendor.supportTier} at ${fmt(w.vendor.supportAnnual)}/yr.`;
        const budgetClaim = VENDORS.every((v) => v.headlineAnnual <= ctx.profile.contractAnnual)
          ? `All three headlines fit the ${fmt(ctx.profile.contractAnnual)}/yr compute budget, so the decision comes down to total cost`
          : `The headlines straddle the ${fmt(ctx.profile.contractAnnual)}/yr compute budget, so the decision comes down to total cost`;
        ctx.recommendation =
          `Recommend ${w.vendor.name} for the ${ctx.profile.termYears}-year contract.\n` +
          `Rationale: ${ctx.profile.termYears}-year TCO of ${fmtK(w.tco)} at ${ctx.volumeTB}TB/yr egress, ` +
          `${fmtK(savingVsRunnerUp)} below ${runnerUp.vendor.name} (${fmtK(runnerUp.tco)}). ` +
          `Nimbus Cloud has the cheapest headline (${fmt(nimbus.vendor.headlineAnnual)}/yr) but finishes at ${fmtK(nimbus.tco)} because its uncapped ` +
          `${fmt(nimbus.vendor.egressPerGB)}/GB egress costs ${fmt(nimbus.egressAnnual)}/yr at this volume. ${budgetClaim}, where ${possessive(w.vendor.name)} ${w.vendor.differentiator} wins. ` +
          `${supportClaim} ${slaClaim}`;
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

// --- Evaluator pass ----------------------------------------------------------
// After the specialists finish, an evaluator step checks the synthesis
// against the receipts themselves, not against the pipeline's own claims:
//
//   1. It re-parses the TCO table recorded in the compute receipt, recomputes
//      the winner (lowest TCO), and confirms the recommendation names that
//      winner.
//   2. It confirms every dollar figure in the recommendation text appears in
//      an earlier receipt's recorded output, so the synthesis cannot invent
//      a number.
//   3. When a model is configured (and SAMPLE_MODE is off), the model adds a
//      critique of the synthesis against the receipt summaries.
//
// The evaluator emits its own $0 receipt (a system verification step, not a
// paid reasoning step). A failed check is recorded on that receipt and the
// final answer is annotated, never silently passed.

interface Evaluation {
  verdict: "pass" | "fail";
  checks: string[];
  discrepancies: string[];
  /** Winner recomputed from the recorded TCO table, if one was found. */
  recomputedWinner: string | null;
  critique: string | null;
  critiqueModel: string | null;
}

/** Dollar figures in a text, normalized ("$48,000" and "$237K" kept distinct). */
function dollarFigures(text: string): string[] {
  return (text.match(/\$[\d,]+(?:\.\d+)?K?/g) ?? []).map((s) => s.replace(/,/g, ""));
}

/** Parse the TCO table recorded in the compute receipt's detail text. */
function parseRecordedTco(detail: string): { vendor: string; tcoK: number }[] {
  const rows: { vendor: string; tcoK: number }[] = [];
  for (const line of detail.split("\n")) {
    const name = /^- (.+?): compute /.exec(line.trim());
    const tco = /= \$([\d,]+)K TCO/.exec(line);
    if (name && tco) rows.push({ vendor: name[1], tcoK: Number(tco[1].replace(/,/g, "")) });
  }
  return rows;
}

function deterministicEvaluation(receipts: Receipt[]): Evaluation {
  const checks: string[] = [];
  const discrepancies: string[] = [];

  const lastOk = (step: string): number =>
    receipts.map((r, i) => ({ r, i })).filter(({ r }) => r.step === step && r.status !== "failed").pop()?.i ?? -1;
  const computeIdx = lastOk("compute-tco");
  const recoIdx = lastOk("write-recommendation");

  let recomputedWinner: string | null = null;
  if (computeIdx < 0) {
    discrepancies.push("No compute receipt found in the chain, so no winner can be recomputed.");
  } else if (recoIdx < 0) {
    discrepancies.push("No recommendation receipt found in the chain, so there is nothing to verify.");
  } else {
    const table = parseRecordedTco(receipts[computeIdx].detail);
    if (table.length === 0) {
      discrepancies.push("The compute receipt records no TCO table, so the winner cannot be recomputed.");
    } else {
      const sorted = [...table].sort((a, b) => a.tcoK - b.tcoK);
      recomputedWinner = sorted[0].vendor;
      checks.push(
        `Winner recomputed from the TCO table recorded in receipt #${receipts[computeIdx].seq}: ` +
          `${sorted.map((r) => `${r.vendor} $${r.tcoK}K`).join(", ")}. Lowest: ${recomputedWinner}.`
      );
      const recommendation = receipts[recoIdx].detail;
      if (!recommendation.includes(recomputedWinner)) {
        discrepancies.push(
          `The recommendation in receipt #${receipts[recoIdx].seq} does not name ${recomputedWinner}, the winner recomputed from the recorded TCO figures.`
        );
      } else {
        checks.push(`The recommendation names ${recomputedWinner}, matching the recomputed winner.`);
      }

      // Every dollar figure in the recommendation must trace to an earlier
      // receipt's recorded output (its detail or output summary).
      const corpus = receipts
        .slice(0, recoIdx)
        .map((r) => `${r.detail}\n${r.outputSummary}`)
        .join("\n");
      const recorded = new Set(dollarFigures(corpus));
      const figures = [...new Set(dollarFigures(recommendation))];
      const untraced = figures.filter((f) => !recorded.has(f));
      if (untraced.length > 0) {
        discrepancies.push(
          `Dollar figure${untraced.length === 1 ? "" : "s"} in the recommendation appear in no earlier receipt: ${untraced.join(", ")}.`
        );
      } else {
        checks.push(
          `All ${figures.length} dollar figures in the recommendation appear in earlier receipts: ${figures.join(", ")}.`
        );
      }
    }
  }

  return {
    verdict: discrepancies.length === 0 ? "pass" : "fail",
    checks,
    discrepancies,
    recomputedWinner,
    critique: null,
    critiqueModel: null,
  };
}

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
    model?: string;
    targetAgent?: string | null;
    retryCount?: number;
  }): void {
    // The handoff target is the next step's agent. The last pipeline step
    // hands off to the evaluator; the evaluator hands off to nobody. Steps
    // run on deterministic template logic unless a caller records a real
    // model id.
    const defIndex = STEP_DEFS.indexOf(args.def);
    const nextAgent =
      defIndex >= 0 && defIndex < STEP_DEFS.length - 1
        ? STEP_DEFS[defIndex + 1].agent
        : defIndex === STEP_DEFS.length - 1
          ? "evaluator"
          : null;
    receipts.push({
      seq: args.def.seq,
      agent: args.def.agent,
      step: args.def.step,
      title: args.def.buildTitle ? args.def.buildTitle(ctx) : args.def.title,
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
      model: args.model ?? "deterministic",
      targetAgent: args.targetAgent !== undefined ? args.targetAgent : nextAgent,
      retryCount: args.retryCount ?? 0,
      prevHash: "",
      hash: "",
    });
  }

  // Scope gate: out-of-scope tasks stop here with an honest refusal. The
  // gate decision itself is receipted; no paid reasoning step runs and
  // nothing is charged.
  if (!isInScope(clean)) {
    const gateDef: StepDef = {
      seq: 1,
      agent: "coordinator",
      step: "scope-check",
      title: "Scope check",
      buildInput: (_ctx, task) => task,
      execute: () => ({ outputSummary: "", detail: "" }),
    };
    const answer =
      `This network only handles vendor and procurement decisions: choosing a vendor, supplier, or cloud provider ` +
      `for an infrastructure contract, and explaining the choice with a receipt chain.\n\n` +
      `Your task ("${summarize(clean, 200)}") is outside that scope, so the run stopped at the coordinator's scope check. ` +
      `No reasoning steps ran and nothing was charged. The gate decision is recorded in receipt #1.\n\n` +
      `Try a task like: "Select a vendor for our $60K annual cloud infrastructure contract."`;
    pushReceipt({
      def: gateDef,
      input: clean,
      outputSummary: "Scope check: task is not a vendor or procurement decision. Run declined before any paid reasoning step.",
      detail:
        `The coordinator's scope gate declined this task. This network selects vendors, suppliers, and cloud providers ` +
        `for infrastructure contracts; the task does not ask for that. No specialist was called, no payment was taken, ` +
        `and no vendor recommendation was produced.`,
      payment: {
        from: USER_WALLET,
        to: AGENT_WALLETS.coordinator ?? USER_WALLET,
        amountUSDC: "0",
        txRef: "no-tx",
        mock: MOCK_MODE,
      },
      status: "ok",
      note: "out of scope: no charge",
      targetAgent: null,
    });
    chainReceipts(receipts);
    return { answer, receipts };
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
          mock: MOCK_MODE,
        },
        status: "failed",
        note: "specialist timeout",
        retryCount: 0,
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
        retryCount: 1,
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

  // Evaluator pass: verify the finished synthesis against the receipts, then
  // record the verdict as a free receipt of its own. A model critique joins
  // the deterministic checks when a model is configured; SAMPLE_MODE skips
  // the model entirely, so no network call is attempted.
  const evaluation = deterministicEvaluation(receipts);
  if (!SAMPLE_MODE) {
    try {
      const receiptLines = receipts
        .filter((r) => r.status !== "failed")
        .map((r) => `#${r.seq} [${r.agent}] ${r.title}: ${r.outputSummary}`)
        .join("\n");
      const { text, model } = await reasonWithModelDetailed(
        `You are the evaluator agent in a pay-per-thought agent network. The network produced this vendor recommendation:\n\n${ctx.recommendation}\n\n` +
          `The receipts recorded during the run say:\n${receiptLines}\n\n` +
          `Critique the recommendation against the receipts in two or three plain sentences. Say whether the receipts support its claims, and name any claim they do not support. Do not invent numbers.`
      );
      evaluation.critique = text.replace(/\n{3,}/g, "\n\n").trim().slice(0, 1200);
      evaluation.critiqueModel = model;
    } catch {
      // No model configured: the deterministic checks stand on their own.
    }
  }

  const evalDef: StepDef = {
    seq: STEP_COUNT + 1,
    agent: "evaluator",
    step: "evaluate",
    title: "Evaluator verification",
    buildInput: (c) => `verify recommendation: ${c.winner?.vendor.name ?? "undecided"}`,
    execute: () => ({ outputSummary: "", detail: "" }),
  };
  const evalChecks = evaluation.checks.map((c) => `- ${c}`).join("\n");
  const evalProblems = evaluation.discrepancies.map((d) => `- ${d}`).join("\n");
  pushReceipt({
    def: evalDef,
    input: evalDef.buildInput(ctx, clean),
    outputSummary:
      evaluation.verdict === "pass"
        ? `Evaluator: PASS. The recommendation was verified against the receipts: the winner recomputed from the recorded TCO figures matches, and every dollar figure in the recommendation traces to an earlier receipt.${evaluation.critique ? " A model critique is recorded in this receipt." : ""}`
        : `Evaluator: FAIL. ${evaluation.discrepancies.join(" ")}`,
    detail:
      `Evaluator verification of the recommendation against the receipt chain.\n\nChecks:\n${evalChecks || "- none ran"}` +
      (evaluation.discrepancies.length > 0 ? `\n\nDiscrepancies:\n${evalProblems}` : `\n\nDiscrepancies: none.`) +
      (evaluation.critique
        ? `\n\nModel critique (${evaluation.critiqueModel}):\n${evaluation.critique}`
        : `\n\nModel critique: none. ${SAMPLE_MODE ? "SAMPLE_MODE is on, so no model was called." : "No model is configured; the deterministic checks above are the whole evaluation."}`),
    payment: {
      from: USER_WALLET,
      to: AGENT_WALLETS.evaluator ?? USER_WALLET,
      amountUSDC: "0",
      txRef: "no-tx",
      mock: MOCK_MODE,
    },
    status: "ok",
    note: "verification step: no charge",
    model: evaluation.critiqueModel
      ? `deterministic checks + ${evaluation.critiqueModel} critique`
      : "deterministic",
    targetAgent: null,
  });

  // A failed verification is never silently passed: the returned answer is
  // annotated with the discrepancy (and the recomputed winner, when known).
  let answer = ctx.finalAnswer;
  if (evaluation.verdict === "fail") {
    answer +=
      `\n\nEvaluator note: verification FAILED. ${evaluation.discrepancies.join(" ")}` +
      (evaluation.recomputedWinner
        ? ` Recomputed from the TCO figures recorded in the receipts, the winner is ${evaluation.recomputedWinner}.`
        : "") +
      ` Treat the recommendation above as unverified until this is resolved.`;
  }

  // Seal the chain: every receipt gets prevHash/hash in order.
  chainReceipts(receipts);
  return { answer, receipts };
}
