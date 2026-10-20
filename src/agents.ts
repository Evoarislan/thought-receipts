/**
 * Thought Receipts pipeline: a coordinator agent breaks the user's task into
 * subtasks, then three specialist agents (research, compute, synthesize) each
 * execute behind a $0.01 x402 paywall. Every step pays first, reasons second,
 * and emits a receipt third. The receipt chain is the explanation of "why".
 *
 * Reasoning is deterministic mock logic so the demo runs with zero API keys.
 * LLM adapter seam: replace any executor's body with a call to
 * reasonWithModel() later; the receipt shape stays identical.
 */
import { payForStep, AGENT_WALLETS, USER_WALLET, PRICE_PER_STEP_USDC } from "./x402.js";
import type { Receipt } from "./receipts.js";

export const STEP_COUNT = 7;
export const PRICE_PER_STEP = PRICE_PER_STEP_USDC;

export type AgentName = "coordinator" | "research" | "compute" | "synthesize";
export type Tier = "budget" | "standard" | "luxury";

export interface Priced {
  name: string;
  price: number;
  note: string;
}

export interface TaskProfile {
  destination: string;
  days: number;
  budget: number;
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

export function detectTier(text: string): Tier {
  const t = text.toLowerCase();
  if (/luxury|premium|5-star|five star|finest|best/.test(t)) return "luxury";
  if (/budget|cheap|backpack|hostel|cheapest|lowest/.test(t)) return "budget";
  return "standard";
}

export function parseTask(task: string): TaskProfile {
  const t = task.toLowerCase();
  const days = /(\d+)\s*-?\s*day/.exec(t);
  const budget = /\$\s*([\d,]+)/.exec(t);
  const destination = /tokyo/.test(t)
    ? "Tokyo"
    : /paris/.test(t)
      ? "Paris"
      : /london/.test(t)
        ? "London"
        : /new york/.test(t)
          ? "New York"
          : "your destination";
  return {
    destination,
    days: days ? Math.min(14, Math.max(1, parseInt(days[1], 10))) : 3,
    budget: budget ? parseInt(budget[1].replace(/,/g, ""), 10) : 1500,
  };
}

function fmt(n: number): string {
  return n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`;
}

// --- Option catalogs --------------------------------------------------------

const TOKYO_HOTELS: Record<Tier, Priced[]> = {
  budget: [
    { name: "Hostel Khaosan Asakusa", price: 35, note: "dorm bed, shared bath" },
    { name: "Capsule Hotel Anshin Oyado Shinjuku", price: 45, note: "capsule pod, sauna included" },
    { name: "Toyoko Inn Ueno", price: 85, note: "business hotel, breakfast included" },
  ],
  standard: [
    { name: "Sakura Hotel Ikebukuro", price: 95, note: "boutique, English speaking staff" },
    { name: "Richmond Hotel Asakusa", price: 120, note: "riverside, Skytree views" },
    { name: "Hotel Gracery Shinjuku", price: 140, note: "landmark Godzilla head" },
  ],
  luxury: [
    { name: "The Ritz-Carlton Tokyo", price: 480, note: "52nd floor, Tokyo Midtown" },
    { name: "Park Hyatt Tokyo", price: 550, note: "New York Bar, skyline views" },
    { name: "Aman Tokyo", price: 700, note: "Otemachi Tower, washi paper interiors" },
  ],
};

const TOKYO_ACTIVITIES: Priced[] = [
  { name: "Senso-ji Temple and Nakamise", price: 0, note: "Asakusa, free" },
  { name: "teamLab Planets", price: 25, note: "Toyosu, timed entry" },
  { name: "Day trip to Kamakura", price: 15, note: "train from Shinjuku" },
  { name: "Sushi lunch at Tsukiji outer market", price: 40, note: "street food crawl" },
  { name: "Meiji Shrine and Yoyogi Park", price: 0, note: "Harajuku, free" },
  { name: "Shibuya crossing at night", price: 0, note: "evening, free" },
];

const TOKYO_TRANSPORT: Priced[] = [
  { name: "72-hour Tokyo subway pass", price: 15, note: "unlimited metro" },
  { name: "Narita Express round trip", price: 40, note: "airport transfer" },
  { name: "Suica top-up buffer", price: 20, note: "JR lines and buses" },
];

const GENERIC_HOTELS: Record<Tier, Priced[]> = {
  budget: [
    { name: "Downtown backpacker hostel", price: 30, note: "dorm bed" },
    { name: "Capsule pod hotel", price: 45, note: "pod, shared lounge" },
    { name: "Budget business hotel", price: 80, note: "compact room, wifi" },
  ],
  standard: [
    { name: "Central 3-star hotel", price: 110, note: "near transit" },
    { name: "Boutique guesthouse", price: 130, note: "local character" },
    { name: "Riverside 4-star hotel", price: 160, note: "city views" },
  ],
  luxury: [
    { name: "Grand palace hotel", price: 450, note: "5-star, spa" },
    { name: "Skyline suite hotel", price: 600, note: "top floor suites" },
    { name: "Private villa resort", price: 800, note: "concierge, private pool" },
  ],
};

const GENERIC_ACTIVITIES: Priced[] = [
  { name: "Old town walking tour", price: 0, note: "self guided, free" },
  { name: "Signature museum", price: 20, note: "timed entry" },
  { name: "Local food market crawl", price: 35, note: "street food" },
  { name: "Sunset viewpoint", price: 0, note: "free" },
  { name: "Day trip to nearby town", price: 18, note: "regional train" },
];

const GENERIC_TRANSPORT: Priced[] = [
  { name: "3-day transit pass", price: 18, note: "unlimited local transit" },
  { name: "Airport transfer round trip", price: 35, note: "express train" },
  { name: "Ride buffer", price: 20, note: "late night taxis" },
];

function perDiem(tier: Tier): number {
  return tier === "luxury" ? 150 : tier === "budget" ? 35 : 60;
}

// --- Pipeline context -------------------------------------------------------

interface Ctx {
  profile: TaskProfile;
  tier: Tier;
  hotels: Priced[];
  activities: Priced[];
  transport: Priced[];
  hotel?: Priced;
  acts: Priced[];
  trans: Priced[];
  lines: string[];
  total: number;
  verdict: string;
  itinerary: string;
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

function pricedList(items: Priced[]): string {
  return items.map((p) => `- ${p.name}: ${fmt(p.price)} (${p.note})`).join("\n");
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
        "1) research lodging options",
        "2) research activities and food",
        "3) research transport",
        "4) verify the total against the budget",
        "5) write the day-by-day itinerary",
        "6) assemble the final answer",
      ].join("\n");
      return {
        outputSummary: "Planned 6 subtasks: research x3, budget check, synthesis, final assembly.",
        detail: `Task: "${summarize(input, 200)}"\n\nExecution plan:\n${plan}\n\nEach reasoning step below is a paid x402 call at $${PRICE_PER_STEP.toFixed(2)}.`,
      };
    },
  },
  {
    seq: 2,
    agent: "research",
    step: "gather-lodging",
    title: "Research lodging options",
    buildInput: (ctx, task) => `${task} :: lodging options for ${ctx.profile.days} nights`,
    execute: (ctx, input) => {
      const tier = detectTier(input);
      ctx.tier = tier;
      const catalog = ctx.profile.destination === "Tokyo" ? TOKYO_HOTELS : GENERIC_HOTELS;
      ctx.hotels = catalog[tier];
      // Deterministic pick: cheapest for budget, middle of the list otherwise.
      ctx.hotel = ctx.hotels[tier === "budget" ? 0 : 1];
      return {
        outputSummary: `Found 3 ${tier} options. Picked "${ctx.hotel.name}" at ${fmt(ctx.hotel.price)}/night.`,
        detail: `Tier detected from input: ${tier}.\n\nOptions:\n${pricedList(ctx.hotels)}\n\nPicked: ${ctx.hotel.name} (${ctx.hotel.note}).`,
      };
    },
  },
  {
    seq: 3,
    agent: "research",
    step: "gather-activities",
    title: "Research activities and food",
    buildInput: (ctx, task) => `${task} :: activities and food worth the time`,
    execute: (ctx, _input) => {
      const catalog = ctx.profile.destination === "Tokyo" ? TOKYO_ACTIVITIES : GENERIC_ACTIVITIES;
      ctx.activities = catalog;
      ctx.acts = catalog.slice(0, 4);
      const free = ctx.acts.filter((a) => a.price === 0).length;
      return {
        outputSummary: `Shortlisted ${ctx.acts.length} activities, ${free} of them free.`,
        detail: `Shortlist:\n${pricedList(ctx.acts)}`,
      };
    },
  },
  {
    seq: 4,
    agent: "research",
    step: "gather-transport",
    title: "Research transport",
    buildInput: (ctx, task) => `${task} :: transport for ${ctx.profile.days} days`,
    execute: (ctx, _input) => {
      ctx.transport = ctx.profile.destination === "Tokyo" ? TOKYO_TRANSPORT : GENERIC_TRANSPORT;
      ctx.trans = ctx.transport;
      return {
        outputSummary: `Priced ${ctx.trans.length} transport legs.`,
        detail: `Transport:\n${pricedList(ctx.trans)}`,
      };
    },
  },
  {
    seq: 5,
    agent: "compute",
    step: "check-budget",
    title: "Verify the budget",
    buildInput: (ctx) =>
      `lodging ${ctx.hotel?.name} ${fmt(ctx.hotel?.price ?? 0)} x ${ctx.profile.days} nights; ` +
      `activities ${ctx.acts.map((a) => `${a.name} ${fmt(a.price)}`).join(", ")}; ` +
      `transport ${ctx.trans.map((t) => `${t.name} ${fmt(t.price)}`).join(", ")}; ` +
      `budget cap ${fmt(ctx.profile.budget)}`,
    execute: (ctx, _input) => {
      const days = ctx.profile.days;
      const hotel = ctx.hotel ?? { name: "undecided", price: 0, note: "" };
      const lodging = hotel.price * days;
      const food = perDiem(ctx.tier) * days;
      const acts = ctx.acts.reduce((s, a) => s + a.price, 0);
      const trans = ctx.trans.reduce((s, t) => s + t.price, 0);
      ctx.total = lodging + food + acts + trans;
      const diff = ctx.profile.budget - ctx.total;
      ctx.verdict =
        diff >= 0
          ? `Under budget by ${fmt(diff)}.`
          : `Over budget by ${fmt(-diff)}. The plan needs cheaper picks.`;
      ctx.lines = [
        `Lodging: ${hotel.name} ${fmt(hotel.price)} x ${days} nights = ${fmt(lodging)}`,
        `Food: ${fmt(perDiem(ctx.tier))}/day x ${days} days = ${fmt(food)}`,
        `Activities: ${fmt(acts)}`,
        `Transport: ${fmt(trans)}`,
        `Total: ${fmt(ctx.total)} vs ${fmt(ctx.profile.budget)} cap`,
        ctx.verdict,
      ];
      return {
        outputSummary: `Total ${fmt(ctx.total)} vs ${fmt(ctx.profile.budget)} cap. ${ctx.verdict}`,
        detail: `Budget check (${ctx.tier} tier):\n${ctx.lines.map((l) => `- ${l}`).join("\n")}`,
      };
    },
  },
  {
    seq: 6,
    agent: "synthesize",
    step: "write-itinerary",
    title: "Write the itinerary",
    buildInput: (ctx) => `picks plus budget verdict: ${ctx.verdict}`,
    execute: (ctx, _input) => {
      const { profile, hotel, acts, trans } = ctx;
      const h = hotel ?? { name: "undecided", price: 0, note: "" };
      const lines: string[] = [
        `Base: ${h.name} (${fmt(h.price)}/night, ${h.note}).`,
        `Getting around: ${trans.map((t) => `${t.name} (${fmt(t.price)})`).join(", ")}.`,
      ];
      for (let d = 1; d <= profile.days; d++) {
        const act = acts[(d - 1) % Math.max(acts.length, 1)];
        const actText = act
          ? `${act.name} (${act.price === 0 ? "free" : fmt(act.price)}, ${act.note})`
          : "free exploration";
        lines.push(`Day ${d}: ${actText}. Food budget ${fmt(perDiem(ctx.tier))}.`);
      }
      ctx.itinerary = lines.join("\n");
      return {
        outputSummary: `${profile.days}-day plan drafted around "${h.name}".`,
        detail: `${profile.days}-day ${profile.destination} itinerary (${ctx.tier} tier):\n${ctx.itinerary}`,
      };
    },
  },
  {
    seq: 7,
    agent: "coordinator",
    step: "finalize",
    title: "Assemble the final answer",
    buildInput: (ctx) => `itinerary draft plus ${fmt(ctx.total)} total`,
    execute: (ctx, _input) => {
      const { profile } = ctx;
      ctx.finalAnswer =
        `${profile.days}-day ${profile.destination} itinerary (${ctx.tier} tier).\n` +
        `Total ${fmt(ctx.total)} against a ${fmt(profile.budget)} budget. ${ctx.verdict}\n\n` +
        `${ctx.itinerary}\n\n` +
        `Paid for with ${STEP_COUNT} receipted reasoning steps. The receipt chain above is the full explanation of how this answer was built.`;
      return {
        outputSummary: "Final answer assembled with cost summary.",
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
 */
export async function runPipeline(
  task: string,
  overrides: Map<number, string> = new Map()
): Promise<PipelineRun> {
  const clean = task.trim().slice(0, 500);
  if (!clean) throw new Error("task is required");

  const ctx: Ctx = {
    profile: parseTask(clean),
    tier: detectTier(clean),
    hotels: [],
    activities: [],
    transport: [],
    acts: [],
    trans: [],
    lines: [],
    total: 0,
    verdict: "",
    itinerary: "",
    finalAnswer: "",
  };

  const firstChanged = overrides.size > 0 ? Math.min(...overrides.keys()) : Number.POSITIVE_INFINITY;
  const receipts: Receipt[] = [];

  for (const def of STEP_DEFS) {
    // Every reasoning step is paid before it runs.
    const input = overrides.get(def.seq) ?? def.buildInput(ctx, clean);
    const payment = await payForStep({
      from: USER_WALLET,
      to: AGENT_WALLETS[def.agent] ?? USER_WALLET,
      amountUSDC: PRICE_PER_STEP,
      memo: `thought-receipts/${def.step}`,
    });
    const out = def.execute(ctx, input);
    receipts.push({
      seq: def.seq,
      agent: def.agent,
      step: def.step,
      title: def.title,
      inputSummary: summarize(input),
      inputFull: input,
      outputSummary: out.outputSummary,
      detail: out.detail,
      amountUSDC: PRICE_PER_STEP.toFixed(2),
      payer: payment.from,
      payee: payment.to,
      txRef: payment.txRef,
      timestamp: new Date().toISOString(),
      mock: payment.mock,
      rechained: def.seq >= firstChanged,
    });
  }

  return { answer: ctx.finalAnswer, receipts };
}
