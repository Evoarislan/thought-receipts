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
import {
  CATALOG_SQL,
  TERMS_SQL,
  extractRows,
  fetchCatalog,
  fetchTerms,
  buildVendorRecords,
  loadSource,
  normalizeRows,
  runSql,
  type SourceFetch,
} from "./zetaris.js";

export const STEP_COUNT = 7;
export const PRICE_PER_STEP = PRICE_PER_STEP_USDC;

/**
 * SAMPLE_MODE=true: fully offline sample run. No external network calls are
 * made at all (reasonWithModel refuses to run, and the data layer serves
 * the bundled CSV sources without attempting live SQL), reasoning stays on
 * the deterministic path, the why box uses its template answers, and the
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
  /** TB/yr billed at egressPerGB before the overage rate applies; null means no cap. */
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
 * LLM adapter seam: a provider chain over OpenAI-compatible chat
 * completions. Wire a model call here to upgrade an executor from
 * deterministic mock logic to real reasoning. The receipt shape does not
 * change, so the UI, bill, and challenge flow keep working, and every
 * result carries the provider and the exact model id that produced it,
 * so callers can record the truth about which provider answered.
 *
 * Provider order (when SAMPLE_MODE is off):
 *   1. Meterless: NVIDIA Nemotron served through the Meterless endpoint.
 *      Set METERLESS_BASE_URL (including the /v1 prefix) and
 *      METERLESS_API_KEY; NEMOTRON_MODEL selects the model id.
 *   2. OpenRouter fallback: set OPENROUTER_API_KEY and the same calls go
 *      to OpenRouter's hosted Nemotron models (verified Oct 20, 2026).
 *   3. Nothing configured, or every provider failed: the call throws and
 *      the callers fall back to the deterministic path, so the demo
 *      still runs with zero API keys.
 * A provider failure (network error, non-200, timeout) falls through to
 * the next provider in the chain.
 */
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
];
const DEFAULT_NEMOTRON_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const NOT_CONFIGURED =
  "reasonWithModel is not configured. Set METERLESS_BASE_URL and METERLESS_API_KEY (Nemotron through Meterless) or OPENROUTER_API_KEY to enable model calls. Without either, this scaffold uses deterministic reasoning so it runs with zero API keys.";

export type ModelProvider = "meterless" | "openrouter";

async function callChatCompletions(args: {
  url: string;
  apiKey: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  providerLabel: string;
  extraHeaders?: Record<string, string>;
}): Promise<{ text: string; model: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), args.timeoutMs);
  try {
    const res = await fetch(args.url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
        ...(args.extraHeaders ?? {}),
      },
      body: JSON.stringify({
        model: args.model,
        messages: [{ role: "user", content: args.prompt }],
        max_tokens: 600,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${args.providerLabel} ${res.status} for ${args.model}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error(`${args.providerLabel} returned no content for ${args.model}.`);
    // Prefer the model id the provider reports in its response; fall back
    // to the id we requested.
    return { text, model: (data.model ?? "").trim() || args.model };
  } finally {
    clearTimeout(timer);
  }
}

function meterlessConfig(): { baseUrl: string; apiKey: string; model: string } | null {
  const baseUrl = (process.env.METERLESS_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = (process.env.METERLESS_API_KEY ?? "").trim();
  if (!baseUrl || !apiKey) return null;
  const model = (process.env.NEMOTRON_MODEL ?? "").trim() || DEFAULT_NEMOTRON_MODEL;
  return { baseUrl, apiKey, model };
}

export interface ModelResult {
  text: string;
  /** The exact model id that produced the text. */
  model: string;
  /** The provider that answered: "meterless" or "openrouter". */
  provider: ModelProvider;
}

/**
 * Like reasonWithModel, but also reports which provider and model
 * answered, so callers (the evaluator, the why box) can record the truth
 * in their receipt or response. In SAMPLE_MODE this throws before any
 * network call is attempted, even if provider keys are set.
 */
export async function reasonWithModelDetailed(prompt: string): Promise<ModelResult> {
  if (SAMPLE_MODE) {
    throw new Error(
      "SAMPLE_MODE is on: model calls are disabled, so a run makes no external network requests."
    );
  }
  let lastErr: unknown = null;

  // 1. Meterless: Nemotron through the Meterless endpoint.
  const ml = meterlessConfig();
  if (ml) {
    try {
      const r = await callChatCompletions({
        url: `${ml.baseUrl}/chat/completions`,
        apiKey: ml.apiKey,
        model: ml.model,
        prompt,
        // The Meterless provider contract asks for a 180 s timeout (a cold
        // model load can take minutes) and for meterless-app on every
        // request plus meterless-scope: user on chat, so the runtime can
        // keep this app's requests apart from other apps.
        timeoutMs: 180000,
        providerLabel: "Meterless",
        extraHeaders: {
          "meterless-app": "thought-receipts",
          "meterless-scope": "user",
        },
      });
      return { ...r, provider: "meterless" };
    } catch (err) {
      lastErr = err;
    }
  }

  // 2. OpenRouter fallback: hosted Nemotron models.
  const apiKey = (process.env.OPENROUTER_API_KEY ?? "").trim();
  if (apiKey) {
    for (const model of OPENROUTER_MODELS) {
      try {
        const r = await callChatCompletions({
          url: OPENROUTER_URL,
          apiKey,
          model,
          prompt,
          timeoutMs: 90000,
          providerLabel: "OpenRouter",
          extraHeaders: {
            "HTTP-Referer": "https://github.com/Evoarislan/thought-receipts",
            "X-Title": "Thought Receipts (Open Agent Hackathon)",
          },
        });
        return { ...r, provider: "openrouter" };
      } catch (err) {
        lastErr = err;
      }
    }
  }

  // 3. Nothing configured, or every provider failed.
  if (lastErr) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  throw new Error(NOT_CONFIGURED);
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
 * Annual data transfer in TB stated by a step input, or null when the
 * input is silent about volume. The challenge flow overrides a step's
 * input, so "double the data transfer volume" typed into the challenge
 * panel lands here as a statement and re-prices everything downstream.
 * Silence is not a statement: a caller re-pricing from an edited input
 * must not read it as the default below, or an edit that never mentions
 * volume would silently re-price at a volume the run never profiled.
 */
export function parseStatedVolumeTB(text: string): number | null {
  const t = text.toLowerCase();
  const explicit = /(\d+(?:\.\d+)?)\s*tb/.exec(t);
  if (explicit) return Math.min(10000, Math.max(1, parseFloat(explicit[1])));
  if (/triple|3x|three times/.test(t)) return 1200;
  if (/double|2x|twice/.test(t)) return 800;
  if (/half/.test(t)) return 200;
  return null;
}

/**
 * The workload step's parse of the same input: a task that states no
 * volume profiles the documented default of 400 TB/yr.
 */
export function parseVolumeTB(text: string): number {
  return parseStatedVolumeTB(text) ?? 400;
}

function fmt(n: number): string {
  return n % 1 === 0 ? `$${n.toLocaleString("en-US")}` : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function fmtK(n: number): string {
  return `$${Math.round(n / 1000)}K`;
}

// --- Vendor catalog ----------------------------------------------------------
// The catalog is data, not code: three sources under data/ (quotes,
// egress rates, support and SLA terms), loaded per run through the
// Zetaris data layer in src/zetaris.ts. Step 2 fetches the joined
// catalog (live SQL when a Zetaris instance is configured, the bundled
// CSV sources otherwise) and buildVendorRecords() derives the records
// below. Fictional vendors and illustrative quotes; not real prices from
// real companies. The point is the shape of the decision, not the numbers.

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

// --- Data layer: working catalog vs registered sources -----------------------
// The vendor catalog lives in the three registered CSV sources in data/
// (quotes, egress_rates, terms). Step 2 fetches the joined catalog
// through the data layer (src/zetaris.ts) and builds this run's working
// records from the fetch. Before pricing, an integrity check compares
// that working copy field by field against a fresh, independent load of
// the CSV sources. Any disagreement is a data corruption by definition:
// the working value is quarantined, the source value is restored, and
// the catch is receipted. The check reads only the two datasets; it
// knows nothing about how a disagreement got there.
//
// Data receipts record the rows the step actually read, so a later
// replay can re-derive the rows from the sources and diff them against
// the recording.

/** One joined vendor record, keyed by the source column names. */
export type DataRow = Record<string, string | number | null>;

/** The working catalog as joined source records. */
function catalogRecords(catalog: Vendor[]): DataRow[] {
  return catalog.map((v) => ({
    vendor: v.name,
    compute_annual_usd: v.headlineAnnual,
    egress_per_gb_usd: v.egressPerGB,
    allowance_tb: v.egressCapTB,
    overage_per_gb_usd: v.egressOveragePerGB,
    support_tier: v.supportTier,
    support_annual_usd: v.supportAnnual,
    sla_percent: parseFloat(v.sla),
  }));
}

/**
 * A fresh, independent load of the three registered CSV sources, joined
 * on vendor. This is the reference read for the integrity check and for
 * replay; it never touches the working catalog.
 */
function csvRecords(): DataRow[] {
  const byVendor = new Map<string, DataRow>();
  for (const q of loadSource("quotes")) {
    byVendor.set(q.vendor, { vendor: q.vendor, compute_annual_usd: Number(q.compute_annual_usd) });
  }
  for (const e of loadSource("egress_rates")) {
    const r = byVendor.get(e.vendor) ?? { vendor: e.vendor };
    r.egress_per_gb_usd = Number(e.egress_per_gb_usd);
    r.allowance_tb = e.allowance_tb === "" ? null : Number(e.allowance_tb);
    r.overage_per_gb_usd = Number(e.overage_per_gb_usd);
    byVendor.set(e.vendor, r);
  }
  for (const t of loadSource("terms")) {
    const r = byVendor.get(t.vendor) ?? { vendor: t.vendor };
    r.support_tier = t.support_tier;
    r.support_annual_usd = Number(t.support_annual_usd);
    r.sla_percent = Number(t.sla_percent);
    byVendor.set(t.vendor, r);
  }
  return [...byVendor.values()];
}

/** Normalize a recorded or re-derived value for comparison. */
function normVal(v: string | number | null | undefined): string | number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return v;
}

export interface RowDiff {
  vendor: string;
  field: string;
  recorded: string | number | null;
  replayed: string | number | null;
}

/**
 * Field-by-field diff of two row sets, matched by vendor. `recorded` is
 * the side being checked (working catalog rows, or a receipt's recorded
 * rows); `replayed` is the fresh reference read. Only fields present in
 * the recorded rows are compared, so a step that recorded a subset is
 * checked on exactly that subset.
 */
function diffRecords(recorded: DataRow[], replayed: DataRow[]): RowDiff[] {
  const diffs: RowDiff[] = [];
  const replayByVendor = new Map(replayed.map((r) => [String(r.vendor), r]));
  for (const rec of recorded) {
    const vendor = String(rec.vendor);
    const rep = replayByVendor.get(vendor);
    if (!rep) {
      diffs.push({ vendor, field: "(row)", recorded: "present", replayed: null });
      continue;
    }
    for (const field of Object.keys(rec)) {
      if (field === "vendor") continue;
      if (normVal(rec[field]) !== normVal(rep[field])) {
        diffs.push({
          vendor,
          field,
          recorded: rec[field] ?? null,
          replayed: rep[field] ?? null,
        });
      }
    }
  }
  const recordedVendors = new Set(recorded.map((r) => String(r.vendor)));
  for (const rep of replayed) {
    if (!recordedVendors.has(String(rep.vendor))) {
      diffs.push({ vendor: String(rep.vendor), field: "(row)", recorded: null, replayed: "present" });
    }
  }
  return diffs;
}

/** Human label for a source column, for integrity and replay reporting. */
const FIELD_LABELS: Record<string, string> = {
  compute_annual_usd: "headline compute price",
  egress_per_gb_usd: "egress rate",
  allowance_tb: "egress allowance",
  overage_per_gb_usd: "egress overage rate",
  support_tier: "support tier",
  support_annual_usd: "support price",
  sla_percent: "SLA",
};

/** A field value rendered for disclosure text, e.g. "$0.2/GB" or "99.99%". */
function fieldValueText(field: string, val: string | number | null): string {
  if (val === null) return "no cap";
  if (field === "egress_per_gb_usd" || field === "overage_per_gb_usd") return `${fmt(Number(val))}/GB`;
  if (field === "compute_annual_usd" || field === "support_annual_usd") return fmt(Number(val));
  if (field === "allowance_tb") return `${val}TB/yr`;
  if (field === "sla_percent") return `${val}%`;
  return String(val);
}

/** Restore one source column's value into a working-catalog vendor. */
const COLUMN_SETTERS: Record<string, (v: Vendor, val: string | number | null) => void> = {
  compute_annual_usd: (v, val) => { v.headlineAnnual = Number(val); },
  egress_per_gb_usd: (v, val) => { v.egressPerGB = Number(val); },
  allowance_tb: (v, val) => { v.egressCapTB = val === null ? null : Number(val); },
  overage_per_gb_usd: (v, val) => { v.egressOveragePerGB = Number(val); },
  support_tier: (v, val) => { v.supportTier = String(val); },
  support_annual_usd: (v, val) => { v.supportAnnual = Number(val); },
  sla_percent: (v, val) => { v.sla = `${Number(val)}%`; },
};

export interface IntegrityEvent {
  vendor: string;
  field: string;
  fieldLabel: string;
  workingText: string;
  sourceText: string;
}

/**
 * The disclosure sentence for a set of integrity catches. The same string
 * is recorded in the integrity receipt and appended to the recommendation,
 * so every dollar figure in the recommendation still traces to an earlier
 * receipt (the evaluator's figure check).
 */
function integrityDisclosure(events: IntegrityEvent[]): string {
  const parts = events.map(
    (e) => `${e.vendor} ${e.fieldLabel} read ${e.workingText} in the working copy against ${e.sourceText} in the registered source`
  );
  return (
    `Integrity note: the data integrity check found working vendor data that disagrees with the registered sources: ` +
    `${parts.join("; ")}. The source value was restored before pricing, so the figures below use the registered data.`
  );
}

// --- Flip threshold ("what would change your mind") ---------------------------

export interface FlipInfo {
  /** Egress volume (TB/yr) at which the winner changes, bisected. */
  thresholdTB: number;
  /** Vendor that wins just past the threshold, in the stated direction. */
  newWinner: string;
  /** Direction from the run's volume in which this crossing sits. */
  direction: "above" | "below";
}

/** Cheapest vendor name at a given egress volume, from real records. */
function winnerAt(catalog: Vendor[], volumeTB: number, termYears: number): string {
  let best: TcoRow | null = null;
  for (const v of catalog) {
    const r = computeTCO(v, volumeTB, termYears);
    if (!best || r.tco < best.tco) best = r;
  }
  return best!.vendor.name;
}

/**
 * Find the nearest egress volume in one direction from `fromTB` (the
 * tested range is 0 to 5000 TB/yr) where `accept(winner)` becomes true,
 * then bisect the crossing for precision. Returns the threshold and the
 * winner just past it in that direction, or null when the predicate
 * never fires in that direction. Computed from the actual records via
 * computeTCO; nothing is hardcoded.
 */
function findFlipVolume(
  catalog: Vendor[],
  termYears: number,
  fromTB: number,
  accept: (winnerName: string) => boolean,
  direction: "above" | "below" = "above"
): FlipInfo | null {
  if (direction === "above") {
    let prev = fromTB;
    for (let v = Math.floor(fromTB) + 1; v <= 5000; v++) {
      if (accept(winnerAt(catalog, v, termYears))) {
        let lo = prev;
        let hi = v;
        for (let i = 0; i < 40; i++) {
          const mid = (lo + hi) / 2;
          if (accept(winnerAt(catalog, mid, termYears))) hi = mid;
          else lo = mid;
        }
        return { thresholdTB: hi, newWinner: winnerAt(catalog, hi, termYears), direction };
      }
      prev = v;
    }
    return null;
  }

  let prev = fromTB;
  for (let v = Math.ceil(fromTB) - 1; v >= 0; v--) {
    if (accept(winnerAt(catalog, v, termYears))) {
      // lo is on the accepting side of the crossing and hi is on the
      // run's side. Bisect toward the boundary, then report the boundary
      // from the run's side so "below roughly N" names the crossing.
      let lo = v;
      let hi = prev;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (accept(winnerAt(catalog, mid, termYears))) lo = mid;
        else hi = mid;
      }
      return { thresholdTB: hi, newWinner: winnerAt(catalog, lo, termYears), direction };
    }
    prev = v;
  }
  return null;
}

/** Compose the run's flip note from its nearest crossings in both directions. */
function flipNoteText(
  volumeTB: number,
  winnerName: string,
  above: FlipInfo | null,
  below: FlipInfo | null
): string {
  const clauses: string[] = [];
  if (above) {
    clauses.push(
      `above roughly ${Math.round(above.thresholdTB)} TB/yr of egress, ${above.newWinner} becomes the cheapest vendor`
    );
  }
  if (below) {
    clauses.push(
      `below roughly ${Math.round(below.thresholdTB)} TB/yr of egress, ${below.newWinner} becomes the cheapest vendor`
    );
  }
  if (clauses.length === 0) {
    return (
      `What would change this answer: no egress volume from 0 to 5,000 TB/yr changes the winner; ` +
      `${winnerName} stays cheapest across the whole range tested.`
    );
  }
  return `What would change this answer: ${clauses.join("; ")} (this run priced ${volumeTB} TB/yr).`;
}

// --- Data-step row recording (dual-language receipts + replay) ----------------

interface DataStepSpec {
  /** Source columns this step records, in order. */
  columns: string[];
  /** The query the step conceptually runs against the registered sources. */
  query: string;
  /** What the step asked for, in plain words, for the plain-English line. */
  ask: string;
}

const CATALOG_COLUMNS = [
  "vendor",
  "compute_annual_usd",
  "egress_per_gb_usd",
  "allowance_tb",
  "overage_per_gb_usd",
  "support_tier",
  "support_annual_usd",
  "sla_percent",
];

const TERMS_COLUMNS = ["vendor", "support_tier", "support_annual_usd", "sla_percent"];

const DATA_STEP_SPECS: Record<string, DataStepSpec> = {
  "gather-quotes": {
    columns: CATALOG_COLUMNS,
    query: CATALOG_SQL,
    ask:
      "the joined vendor catalog: each vendor's headline compute quote, egress rate, " +
      "egress allowance, overage rate, support package, and SLA, joined on vendor across " +
      "the quotes, egress_rates, and terms sources",
  },
  "check-terms": {
    columns: TERMS_COLUMNS,
    query: TERMS_SQL,
    ask: "each vendor's support package, support price, and SLA from the terms source",
  },
  "compute-tco": {
    columns: CATALOG_COLUMNS,
    query: CATALOG_SQL,
    ask: "the joined vendor record the pricing math runs on",
  },
};

function projectRows(records: DataRow[], columns: string[]): DataRow[] {
  return records.map((r) => {
    const out: DataRow = {};
    for (const c of columns) out[c] = r[c] ?? null;
    return out;
  });
}

/** Project rows to the given columns, normalized to string values. */
function projectStringRows(rows: readonly Record<string, unknown>[], columns: string[]): DataRow[] {
  return rows.map((row) => {
    const out: DataRow = {};
    for (const c of columns) {
      const value = row[c];
      out[c] = value === null || value === undefined ? "" : String(value);
    }
    return out;
  });
}

/**
 * Plain-English rendering of a data step's query, generated from the
 * query intent and the rows actually returned (source columns, row
 * count, vendor names). Works whether or not a SQL string was recorded:
 * the text is built from the step's data source and rows.
 */
function plainEnglishFor(spec: DataStepSpec, rows: DataRow[]): string {
  const names = rows.map((r) => String(r.vendor)).join(", ");
  return (
    `In plain English: this step asked the registered vendor sources for ${spec.ask} ` +
    `and got ${rows.length} row${rows.length === 1 ? "" : "s"} back, one per vendor (${names}).`
  );
}

interface ReceiptDataFields {
  query: string | null;
  rows: DataRow[];
  dataSource: "zetaris" | "csv-fallback" | "working-catalog";
  plainEnglish: string;
}

/**
 * Data fields for a step's receipt, assembled from the step's own fetch
 * (the data layer's SourceFetch: the query it ran, the rows it returned,
 * and which path served them) plus a plain-English rendering of the ask.
 *
 * Each data receipt records its own fetch's rows, projected to that
 * fetch's query columns and normalized to string values. The catalog
 * receipt records the joined catalog fetch; the terms receipt records
 * the terms fetch, not a projection of the working catalog. The two
 * fetches can therefore disagree on a divergent source, and each
 * receipt says what its own fetch actually returned. The sabotage
 * catch is proven by the separate integrity receipt, which records the
 * corrupted working copy itself.
 *
 * Returns undefined for steps that made no fetch.
 */
function dataFieldsFor(step: string, _ctx: Ctx, fetch?: SourceFetch): ReceiptDataFields | undefined {
  const spec = DATA_STEP_SPECS[step];
  if (!spec || step === "compute-tco") return undefined;
  if (step !== "gather-quotes" && step !== "check-terms") return undefined;
  if (!fetch) return undefined;
  const rows = projectStringRows(fetch.rows, spec.columns);
  return {
    query: fetch.query,
    rows,
    dataSource: fetch.dataSource,
    plainEnglish: plainEnglishFor(spec, rows),
  };
}

// --- Pipeline context -------------------------------------------------------

interface Ctx {
  profile: TaskProfile;
  volumeTB: number;
  /**
   * The working vendor catalog for this run: the records step 2 built
   * from its data-layer fetch, and the records every later step reads.
   * The records are per-run copies, so the sabotage drill can corrupt
   * this copy in memory only; the integrity check compares it against a
   * fresh load of the registered CSV sources and restores any field
   * that disagrees before pricing runs.
   */
  vendors: Vendor[];
  tcoRows: TcoRow[];
  winner?: TcoRow;
  termsNote: string;
  recommendation: string;
  finalAnswer: string;
  /** Corruptions the integrity check caught during this run, if any. */
  integrityEvents: IntegrityEvent[];
  /** Egress volume where the winner flips, computed from the catalog. */
  flip: FlipInfo | null;
  /** The "what would change this answer" line for the final answer. */
  flipNote: string | null;
}

interface StepOutput {
  outputSummary: string;
  detail: string;
  /** Data provenance when the step fetched data; recorded on its receipt. */
  data?: SourceFetch;
}

interface StepDef {
  seq: number;
  agent: AgentName;
  step: string;
  title: string;
  /** Optional dynamic title, e.g. when the label depends on the task's term. */
  buildTitle?: (ctx: Ctx) => string;
  buildInput: (ctx: Ctx, task: string) => string;
  execute: (ctx: Ctx, input: string) => StepOutput | Promise<StepOutput>;
}

/**
 * The logical step number (a STEP_DEFS seq) for a receipt's step name, or
 * null when the step is not one of the seven paid steps. The $0 system
 * receipts (scope check, integrity check, evaluator, dissent) return
 * null: they record no step input, so there is nothing to challenge.
 * Receipt sequence numbers are chain positions, which diverge from
 * logical step numbers whenever a run inserts a system receipt or a
 * chaos attempt; the challenge flow resolves a posted chain position
 * through the stored chain to the receipt's step, then to this number.
 */
export function logicalSeqForStep(step: string): number | null {
  const def = STEP_DEFS.find((d) => d.step === step);
  return def ? def.seq : null;
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
    `support ${fmt(v.supportAnnual)}/yr (${v.supportTier}), SLA ${v.sla}. Edge: ${v.differentiator || "none recorded"}.`
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
    execute: async (ctx, _input) => {
      // The catalog fetch: live SQL through the Zetaris data layer when
      // an instance is configured, the bundled CSV sources otherwise.
      // The fetch travels with this step's receipt (query, rows, source).
      const catalog = await fetchCatalog();
      ctx.vendors = buildVendorRecords(catalog.rows);
      const vendors = ctx.vendors;
      const cheapest = vendors.reduce((a, b) => (b.headlineAnnual < a.headlineAnnual ? b : a));
      const budget = ctx.profile.contractAnnual;
      const fitting = vendors.filter((v) => v.headlineAnnual <= budget);
      const budgetNote =
        fitting.length === vendors.length
          ? `All ${vendors.length} headlines fit inside the ${fmt(budget)}/yr compute budget, so headline price alone cannot decide this.`
          : `${fitting.length} of ${vendors.length} headlines fit inside the ${fmt(budget)}/yr compute budget (${fitting.map((v) => v.name).join(", ")}); the rest open above budget, so total cost matters even more.`;
      return {
        outputSummary: `Gathered quotes from ${vendors.map((v) => v.name).join(", ")}. Cheapest headline: ${cheapest.name} at ${fmt(cheapest.headlineAnnual)}/yr.`,
        detail:
          `Vendor quotes (fictional vendors, illustrative pricing):\n` +
          vendors.map(quoteCard).join("\n") +
          `\n\n${budgetNote}`,
        data: catalog,
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
    buildInput: (ctx) => `contract terms for ${ctx.vendors.map((v) => v.name).join(", ")} at ${ctx.volumeTB}TB/yr`,
    execute: async (ctx, _input) => {
      // The terms fetch, recorded on this step's receipt the same way
      // the catalog fetch is recorded on step 2's. The names, support
      // tiers, support prices, and SLAs in the narrative come from this
      // fetch's own rows; egress context comes from the catalog records
      // actually present. A different vendor set changes the narrative
      // instead of throwing.
      const terms = await fetchTerms();
      const termsByVendor = new Map(terms.rows.map((row) => [row.vendor, row]));
      const catalogByVendor = new Map(ctx.vendors.map((v) => [v.name, v]));
      const names = [
        ...new Set([...terms.rows.map((row) => row.vendor), ...ctx.vendors.map((v) => v.name)]),
      ];
      const lines = names.map((name) => {
        const term = termsByVendor.get(name);
        const vendor = catalogByVendor.get(name);
        const termsText = term
          ? `SLA ${term.sla_percent}%, ${term.support_tier}, support ${fmt(Number(term.support_annual_usd))}/yr`
          : "no terms row was returned for this vendor";
        let egressText = "Egress terms were not part of this terms fetch.";
        if (vendor) {
          if (vendor.egressCapTB !== null) {
            egressText =
              `Egress is billed at ${fmt(vendor.egressPerGB)}/GB for the first ${vendor.egressCapTB}TB/yr, ` +
              `then ${fmt(vendor.egressOveragePerGB)}/GB overage. ` +
              (ctx.volumeTB <= vendor.egressCapTB
                ? `At ${ctx.volumeTB}TB/yr the workload sits inside the threshold with room to grow.`
                : `At ${ctx.volumeTB}TB/yr the workload EXCEEDS the ${vendor.egressCapTB}TB threshold; overage fees apply.`);
          } else {
            egressText =
              `Egress has no cap and is metered at ${fmt(vendor.egressPerGB)}/GB: ` +
              `at ${ctx.volumeTB}TB/yr egress alone costs ${fmt(Math.round(ctx.volumeTB * 1000 * vendor.egressPerGB))}/yr.`;
          }
        }
        return `${name}: ${termsText}. ${egressText}`;
      });
      ctx.termsNote = lines.join("\n");
      const highestRate =
        ctx.vendors.length > 0
          ? ctx.vendors.reduce((a, b) => (b.egressPerGB > a.egressPerGB ? b : a))
          : null;
      const capped = ctx.vendors.filter((v) => v.egressCapTB !== null);
      return {
        outputSummary:
          `Terms checked for ${names.join(", ")}. Flag: ` +
          (highestRate
            ? `${highestRate.name} has the highest metered egress rate at ${fmt(highestRate.egressPerGB)}/GB`
            : "no egress records were returned") +
          (capped.length > 0
            ? `; ${capped.map((v) => `${v.name} pricing hinges on its ${v.egressCapTB}TB/yr threshold`).join("; ")}.`
            : "; no returned vendor record has an egress threshold."),
        detail: `Contract terms and risk flags:\n${ctx.termsNote}`,
        data: terms,
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
      `${ctx.profile.termYears}-year TCO for ${ctx.vendors.map((v) => v.name).join(", ")} at ${ctx.volumeTB}TB/yr egress, ` +
      `compute plus egress plus support`,
    execute: (ctx, input) => {
      // This step's input is its pricing instruction: the built input
      // names the volume the math runs at ("at 400TB/yr egress"), so a
      // volume the input states is read back out of it here. A challenge
      // that edits this step's input ("double the data transfer volume")
      // therefore re-prices at the edited volume, exactly as editing the
      // workload step does. On an unedited run the built input restates
      // the profiled volume, so nothing changes. An edit silent about
      // volume states nothing, so the volume the workload step profiled
      // stands: silence never resets the price to a volume this run
      // never profiled.
      const statedVolume = parseStatedVolumeTB(input);
      if (statedVolume !== null) ctx.volumeTB = statedVolume;
      const rows = ctx.vendors.map((v) => computeTCO(v, ctx.volumeTB, ctx.profile.termYears));
      rows.sort((a, b) => a.tco - b.tco);
      ctx.tcoRows = rows;
      ctx.winner = rows[0];
      // "What would change your mind": the nearest egress volumes in
      // both directions where the winner flips, computed from the
      // actual records via computeTCO over 0 to 5,000 TB/yr.
      const winnerName = rows[0].vendor.name;
      const flipAbove = findFlipVolume(
        ctx.vendors,
        ctx.profile.termYears,
        ctx.volumeTB,
        (name) => name !== winnerName,
        "above"
      );
      const flipBelow = findFlipVolume(
        ctx.vendors,
        ctx.profile.termYears,
        ctx.volumeTB,
        (name) => name !== winnerName,
        "below"
      );
      ctx.flip = flipAbove ?? flipBelow;
      ctx.flipNote = flipNoteText(ctx.volumeTB, winnerName, flipAbove, flipBelow);
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
          `${rows.indexOf(cheapestHeadline) + 1} of ${rows.length} because egress dominates the total.`,
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
      // The cautionary example is picked by role from the records, never
      // by vendor name: the vendor with the highest base egress rate. In
      // the shipped catalog that is Nimbus Cloud, which also happens to
      // be the cheapest headline; neither fact is assumed here, both are
      // read from the records below, so a different catalog produces a
      // recommendation about its own vendors.
      const priciestEgress = rows.length > 0
        ? rows.reduce((a, b) => (b.vendor.egressPerGB > a.vendor.egressPerGB ? b : a))
        : undefined;
      if (!w || !runnerUp || !priciestEgress) {
        ctx.recommendation = "TCO not computed; cannot recommend.";
      } else {
        const savingVsRunnerUp = w.tco === runnerUp.tco ? 0 : runnerUp.tco - w.tco;
        // Support and SLA claims come from the winner's own record. A
        // superlative is used only when the data supports it: the SLA
        // figure is the highest in the field, or the support package is
        // the most comprehensive (priciest) in the field.
        const bestSla = Math.max(...ctx.vendors.map((v) => parseFloat(v.sla)));
        const slaClaim =
          parseFloat(w.vendor.sla) >= bestSla
            ? `It also carries the strongest SLA in the field at ${w.vendor.sla}.`
            : `Its SLA is ${w.vendor.sla}.`;
        const priciestSupport = Math.max(...ctx.vendors.map((v) => v.supportAnnual));
        const supportClaim =
          w.vendor.supportAnnual >= priciestSupport
            ? `Support is ${w.vendor.supportTier} at ${fmt(w.vendor.supportAnnual)}/yr, the most comprehensive package in the field.`
            : `Support is ${w.vendor.supportTier} at ${fmt(w.vendor.supportAnnual)}/yr.`;
        const countWord = (n: number): string =>
          n === 2 ? "two" : n === 3 ? "three" : n === 4 ? "four" : String(n);
        const budgetClaim = ctx.vendors.every((v) => v.headlineAnnual <= ctx.profile.contractAnnual)
          ? `All ${countWord(ctx.vendors.length)} headlines fit the ${fmt(ctx.profile.contractAnnual)}/yr compute budget, so the decision comes down to total cost`
          : `The headlines straddle the ${fmt(ctx.profile.contractAnnual)}/yr compute budget, so the decision comes down to total cost`;
        const pe = priciestEgress.vendor;
        const egressClaim =
          pe.egressCapTB === null
            ? `its uncapped ${fmt(pe.egressPerGB)}/GB egress costs ${fmt(priciestEgress.egressAnnual)}/yr at this volume`
            : `its ${fmt(pe.egressPerGB)}/GB egress costs ${fmt(priciestEgress.egressAnnual)}/yr at this volume (first ${pe.egressCapTB}TB/yr at that rate, then ${fmt(pe.egressOveragePerGB)}/GB overage)`;
        const cheapestHeadline = Math.min(...rows.map((r) => r.vendor.headlineAnnual));
        const exampleClaim =
          pe.headlineAnnual <= cheapestHeadline
            ? `${pe.name} has the cheapest headline (${fmt(pe.headlineAnnual)}/yr) but finishes at ${fmtK(priciestEgress.tco)} because ${egressClaim}. `
            : `${pe.name} finishes at ${fmtK(priciestEgress.tco)} because ${egressClaim}. `;
        const edgeClaim = w.vendor.differentiator
          ? `where ${possessive(w.vendor.name)} ${w.vendor.differentiator} wins`
          : `where its recorded terms win`;
        ctx.recommendation =
          `Recommend ${w.vendor.name} for the ${ctx.profile.termYears}-year contract.\n` +
          `Rationale: ${ctx.profile.termYears}-year TCO of ${fmtK(w.tco)} at ${ctx.volumeTB}TB/yr egress, ` +
          `${fmtK(savingVsRunnerUp)} below ${runnerUp.vendor.name} (${fmtK(runnerUp.tco)}). ` +
          `${exampleClaim}${budgetClaim}, ${edgeClaim}. ` +
          `${supportClaim} ${slaClaim}`;
      }
      // If the integrity check caught corrupted working data earlier in
      // this run, the recommendation discloses the catch. The identical
      // sentence is recorded in the integrity receipt, so the figures in
      // it still trace to an earlier receipt.
      if (ctx.integrityEvents.length > 0) {
        ctx.recommendation += `\n${integrityDisclosure(ctx.integrityEvents)}`;
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
        (ctx.flipNote ? `${ctx.flipNote}\n\n` : "") +
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
  critiqueProvider: ModelProvider | null;
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
    critiqueProvider: null,
  };
}

export interface PipelineRun {
  answer: string;
  receipts: Receipt[];
  /** "What would change your mind" line for the run, when one was computed. */
  flipNote: string | null;
}

export interface PipelineOptions {
  /**
   * Sabotage round (integrity drill): after the working catalog is
   * loaded, one value in it is corrupted in memory only. Nothing is
   * written to disk and the registered sources are never touched. The
   * integrity check is expected to catch the corruption from the data
   * disagreement itself and quarantine it before pricing.
   */
  sabotage?: boolean;
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
  chaos?: { failStep: number },
  options?: PipelineOptions
): Promise<PipelineRun> {
  const clean = task.trim().slice(0, 500);
  if (!clean) throw new Error("task is required");

  const ctx: Ctx = {
    profile: parseTask(clean),
    volumeTB: 400,
    vendors: [],
    tcoRows: [],
    termsNote: "",
    recommendation: "",
    finalAnswer: "",
    integrityEvents: [],
    flip: null,
    flipNote: null,
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
    /** Data-contract fields for data receipts (query, rows, source, plain English). */
    data?: ReceiptDataFields;
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
      // Sequence numbers are chain positions, assigned at emission.
      // A free receipt inserted mid-chain (the integrity catch) takes
      // the next position and every later receipt numbers after it, so
      // seq always matches the receipt's place in the chain.
      seq: receipts.length + 1,
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
      // Data-contract fields are attached only when the step recorded
      // data. Receipts without data keep their exact old shape, so their
      // hashes are unchanged.
      ...(args.data
        ? {
            query: args.data.query,
            rows: args.data.rows,
            dataSource: args.data.dataSource,
            plainEnglish: args.data.plainEnglish,
          }
        : {}),
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
    return { answer, receipts, flipNote: null };
  }

  // Integrity check: compare the working catalog against a fresh,
  // independent load of the registered CSV sources. The check reads only
  // the two datasets. On any disagreement it quarantines the field
  // (restores the source value into the working catalog), records the
  // event for the recommendation's disclosure, and receipts the catch.
  // It runs once per run, just before the pricing step consumes the
  // catalog, so a catch always lands before any TCO is computed.
  const runIntegrityCheck = (): void => {
    let sourceRecords: DataRow[];
    try {
      sourceRecords = csvRecords();
    } catch {
      // The registered sources cannot be read in this environment, so
      // there is no reference to check against. The run continues on the
      // working catalog; replay and the smoke script surface the problem.
      return;
    }
    const diffs = diffRecords(catalogRecords(ctx.vendors), sourceRecords);
    if (diffs.length === 0) return;
    // Capture the corrupted working rows before quarantine restores
    // them. These rows are the integrity receipt's evidence: they are a
    // working copy, labeled as such, with no query behind them.
    const caughtVendors = new Set(diffs.map((d) => d.vendor));
    const caughtRows = projectStringRows(
      catalogRecords(ctx.vendors).filter((row) => caughtVendors.has(String(row.vendor))),
      CATALOG_COLUMNS
    );
    const events: IntegrityEvent[] = diffs.map((d) => ({
      vendor: d.vendor,
      field: d.field,
      fieldLabel: FIELD_LABELS[d.field] ?? d.field,
      workingText: fieldValueText(d.field, d.recorded),
      sourceText: fieldValueText(d.field, d.replayed),
    }));
    // Quarantine: restore every disagreed field from the source record.
    for (const d of diffs) {
      const vendor = ctx.vendors.find((v) => v.name === d.vendor);
      const setter = COLUMN_SETTERS[d.field];
      if (vendor && setter) setter(vendor, d.replayed);
    }
    ctx.integrityEvents = events;
    const integrityDef: StepDef = {
      seq: 0,
      agent: "evaluator",
      step: "integrity-check",
      title: "Data integrity check",
      buildInput: () => "compare the working vendor data against a fresh load of the registered sources",
      execute: () => ({ outputSummary: "", detail: "" }),
    };
    pushReceipt({
      def: integrityDef,
      input: integrityDef.buildInput(ctx, clean),
      outputSummary:
        `Integrity check: caught ${events.length} corrupted value${events.length === 1 ? "" : "s"} in the working vendor data ` +
        `(${events.map((e) => `${e.vendor} ${e.fieldLabel}`).join("; ")}). Quarantined and restored from the registered sources before pricing.`,
      detail:
        `Data integrity check: the working vendor data was compared field by field against a fresh load of the registered sources (quotes, egress_rates, terms).\n\n` +
        `${integrityDisclosure(events)}\n\n` +
        `Quarantine: each disagreed field was restored to the registered source value in the working data before the TCO step ran, so no downstream figure uses the corrupted value.`,
      payment: {
        from: USER_WALLET,
        to: AGENT_WALLETS.evaluator ?? USER_WALLET,
        amountUSDC: "0",
        txRef: "no-tx",
        mock: MOCK_MODE,
      },
      status: "ok",
      note: "integrity catch: no charge",
      targetAgent: "compute",
      data: {
        query: null,
        rows: caughtRows,
        dataSource: "working-catalog",
        plainEnglish:
          "In plain English: these are rows from the run's working copy at the moment the integrity check caught it. " +
          "No query returned them; they are recorded so replay can compare this working copy against a fresh load of the registered sources.",
      },
    });
  };

  for (const def of STEP_DEFS) {
    // Sabotage drill: step 2 has loaded the working catalog by now, so
    // corrupt one value in it, in memory only. The target is Stratus
    // Systems' egress overage rate, inflated tenfold. Nothing is
    // written to disk and the registered sources are never touched. The
    // integrity check below gets no hint this happened; it either finds
    // the disagreement with the registered sources or it does not.
    if (def.seq === 3 && options?.sabotage) {
      const target = ctx.vendors.find((v) => v.name === "Stratus Systems");
      if (target) target.egressOveragePerGB = 2;
    }
    // The integrity check runs before the pricing step consumes the
    // catalog, whichever path (normal, chaos retry) that step takes.
    if (def.seq === 5) runIntegrityCheck();
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
      const out = await def.execute(ctx, input);
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
        data: dataFieldsFor(def.step, ctx, out.data),
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
    const out = await def.execute(ctx, input);
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
      data: dataFieldsFor(def.step, ctx, out.data),
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
      const { text, model, provider } = await reasonWithModelDetailed(
        `You are the evaluator agent in a pay-per-thought agent network. The network produced this vendor recommendation:\n\n${ctx.recommendation}\n\n` +
          `The receipts recorded during the run say:\n${receiptLines}\n\n` +
          `Critique the recommendation against the receipts in two or three plain sentences. Say whether the receipts support its claims, and name any claim they do not support. Do not invent numbers.`
      );
      evaluation.critique = text.replace(/\n{3,}/g, "\n\n").trim().slice(0, 1200);
      evaluation.critiqueModel = model;
      evaluation.critiqueProvider = provider;
    } catch {
      // No model configured: the deterministic checks stand on their own.
    }
  }

  const evalDef: StepDef = {
    seq: 0,
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
        ? `\n\nModel critique (${evaluation.critiqueModel} via ${evaluation.critiqueProvider}):\n${evaluation.critique}`
        : `\n\nModel critique: none. ${SAMPLE_MODE ? "SAMPLE_MODE is on, so no model was called." : "No model critique is recorded; the deterministic checks above are the whole evaluation."}`),
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
      ? `deterministic checks + ${evaluation.critiqueModel} critique via ${evaluation.critiqueProvider}`
      : "deterministic",
    targetAgent: null,
  });

  // Dissent receipt: after a PASS, the evaluator records the strongest
  // data-backed case for the runner-up, so the chain shows the road not
  // taken. Every claim is derived from the run's own records: the TCO
  // margin, the volume at which the runner-up would win (computed with
  // the same flip machinery), its SLA rank, and its support terms.
  if (evaluation.verdict === "pass" && ctx.tcoRows.length >= 2 && ctx.winner) {
    const winner = ctx.tcoRows[0];
    const runnerUp = ctx.tcoRows[1];
    const ru = runnerUp.vendor;
    const margin = runnerUp.tco - winner.tco;
    const ruFlipAbove = findFlipVolume(
      ctx.vendors,
      ctx.profile.termYears,
      ctx.volumeTB,
      (name) => name === ru.name,
      "above"
    );
    const ruFlipBelow = findFlipVolume(
      ctx.vendors,
      ctx.profile.termYears,
      ctx.volumeTB,
      (name) => name === ru.name,
      "below"
    );
    const slaRank =
      [...ctx.vendors].sort((a, b) => parseFloat(b.sla) - parseFloat(a.sla)).findIndex((v) => v.name === ru.name) + 1;
    const cheapestSupport = Math.min(...ctx.vendors.map((v) => v.supportAnnual));
    const dissentLines: string[] = [
      `The case for ${ru.name}, the runner-up at ${fmtK(runnerUp.tco)} (${fmtK(margin)} behind ${winner.vendor.name} over ${ctx.profile.termYears} years at ${ctx.volumeTB}TB/yr).`,
    ];
    if (ruFlipAbove) {
      dissentLines.push(
        `Volume is its path to winning: past roughly ${Math.round(ruFlipAbove.thresholdTB)}TB/yr of egress, ${ru.name} has the lowest total cost of the field.` +
          (ru.egressCapTB === null && winner.vendor.egressCapTB !== null
            ? ` Its egress rate of ${fmt(ru.egressPerGB)}/GB has no cap, while ${winner.vendor.name} bills ${fmt(winner.vendor.egressOveragePerGB)}/GB in overage past ${winner.vendor.egressCapTB}TB/yr.`
            : ` The ranking reverses there on the records as priced.`)
      );
    }
    if (ruFlipBelow) {
      dissentLines.push(
        `Volume is also its path back: below roughly ${Math.round(ruFlipBelow.thresholdTB)}TB/yr of egress, ${ru.name} has the lowest total cost of the field. The ranking reverses there on the records as priced.`
      );
    }
    if (!ruFlipAbove && !ruFlipBelow) {
      dissentLines.push(
        `On volume alone it never catches up: at every egress volume from 0 to 5,000TB/yr, some other vendor prices lower. Its case rests on terms, not on scale.`
      );
    }
    dissentLines.push(
      `Its SLA of ${ru.sla} ranks ${slaRank} of ${ctx.vendors.length} in the field. ` +
        `Support is ${ru.supportTier} at ${fmt(ru.supportAnnual)}/yr` +
        (ru.supportAnnual <= cheapestSupport
          ? `, the cheapest support package in the field.`
          : ru.supportAnnual < winner.vendor.supportAnnual
            ? `, ${fmt(winner.vendor.supportAnnual - ru.supportAnnual)}/yr cheaper than the winner's package.`
            : `.`) +
        (ru.differentiator ? ` Its stated edge: ${ru.differentiator}.` : ` No differentiator is recorded for it in the sources.`)
    );
    const dissentDef: StepDef = {
      seq: 0,
      agent: "evaluator",
      step: "dissent",
      title: `Dissent: the case for ${ru.name}`,
      buildInput: (c) => `strongest case for the runner-up, ${c.tcoRows[1]?.vendor.name ?? "none"}`,
      execute: () => ({ outputSummary: "", detail: "" }),
    };
    pushReceipt({
      def: dissentDef,
      input: dissentDef.buildInput(ctx, clean),
      outputSummary:
        `Dissent recorded for the record: the strongest case for ${ru.name} (runner-up). ` +
        (ruFlipAbove
          ? `It wins outright above roughly ${Math.round(ruFlipAbove.thresholdTB)}TB/yr of egress. `
          : "") +
        (ruFlipBelow
          ? `It wins outright below roughly ${Math.round(ruFlipBelow.thresholdTB)}TB/yr of egress. `
          : "") +
        (!ruFlipAbove && !ruFlipBelow ? `It does not win at any volume from 0 to 5,000TB/yr. ` : "") +
        `The recommendation above stands; this receipt exists so the chain shows the alternative was argued from the same data.`,
      detail:
        `Evaluator dissent, recorded after a PASS verdict. The recommendation stands; this is the strongest case the same records make for the runner-up.\n\n` +
        dissentLines.join("\n"),
      payment: {
        from: USER_WALLET,
        to: AGENT_WALLETS.evaluator ?? USER_WALLET,
        amountUSDC: "0",
        txRef: "no-tx",
        mock: MOCK_MODE,
      },
      status: "ok",
      note: "dissent: no charge",
      targetAgent: null,
    });
  }

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
  return { answer, receipts, flipNote: ctx.flipNote };
}

// --- Replayable receipts -------------------------------------------------------
// A data receipt can be replayed: the rows it recorded are compared
// against a fresh derivation from the registered sources (or, when the
// receipt came from a live Zetaris read, a re-execution of its recorded
// query). MATCH means the receipt's data still agrees with the sources.
// A DIFF lists every field that moved, which is what makes an integrity
// catch provable after the fact: replaying the integrity receipt from a
// sabotage run compares its recorded working-copy rows against a fresh
// load of the registered sources and reproduces the discrepancy.

export interface ReplayResult {
  seq: number;
  step: string;
  replayable: boolean;
  /** Present when replayable: "MATCH" or "DIFF". */
  result?: "MATCH" | "DIFF";
  /** Field-level differences, present when result is "DIFF". */
  diffs?: RowDiff[];
  /** How the reference rows were obtained. */
  via?: "zetaris" | "csv-sources" | "working-copy-vs-sources";
  /** Why the receipt cannot be replayed, when replayable is false. */
  reason?: string;
}

export async function replayReceipt(receipts: Receipt[], seq: number): Promise<ReplayResult> {
  const receipt = receipts.find((r) => r.seq === seq);
  if (!receipt) {
    return { seq, step: "", replayable: false, reason: `No receipt #${seq} in the latest run.` };
  }
  if (!Array.isArray(receipt.rows) || receipt.rows.length === 0) {
    return {
      seq,
      step: receipt.step,
      replayable: false,
      reason: `Receipt #${seq} ("${receipt.title}") recorded no data rows, so there is nothing to replay against the sources. Only data receipts (vendor quotes, contract terms, and the integrity check) carry replayable rows.`,
    };
  }
  const recorded = receipt.rows as DataRow[];

  // Reference rows: an integrity receipt's working-copy rows are always
  // compared against a fresh load of the registered sources. A live
  // Zetaris receipt re-executes its recorded query through the data
  // layer's own response parser; otherwise (and on any failure of the
  // live path) the rows are re-derived from the CSV sources.
  // SAMPLE_MODE never attempts the network call.
  let replayed: DataRow[] | null = null;
  let via: "zetaris" | "csv-sources" | "working-copy-vs-sources" = "csv-sources";
  if (receipt.dataSource === "working-catalog") {
    try {
      replayed = csvRecords();
      via = "working-copy-vs-sources";
    } catch {
      return {
        seq,
        step: receipt.step,
        replayable: false,
        reason: "The registered CSV sources could not be read in this environment, so the replay has no reference rows.",
      };
    }
  } else if (receipt.dataSource === "zetaris" && receipt.query && !SAMPLE_MODE) {
    try {
      const rows = normalizeRows(extractRows(await runSql(receipt.query)));
      if (rows.length > 0) {
        replayed = rows;
        via = "zetaris";
      }
    } catch {
      replayed = null; // fall through to the CSV derivation
    }
  }
  if (!replayed) {
    try {
      replayed = csvRecords();
    } catch {
      return {
        seq,
        step: receipt.step,
        replayable: false,
        reason: "The registered CSV sources could not be read in this environment, so the replay has no reference rows.",
      };
    }
  }

  // Compare on exactly the fields the receipt recorded. An integrity
  // receipt records only the rows it caught, so its reference read is
  // limited to those vendors: unrecorded vendors are not a discrepancy.
  const columns = Object.keys(recorded[0]);
  const reference =
    receipt.dataSource === "working-catalog"
      ? replayed.filter((r) => recorded.some((rec) => String(rec.vendor) === String(r.vendor)))
      : replayed;
  const diffs = diffRecords(recorded, projectRows(reference, columns));
  return {
    seq,
    step: receipt.step,
    replayable: true,
    result: diffs.length === 0 ? "MATCH" : "DIFF",
    ...(diffs.length > 0 ? { diffs } : {}),
    via,
  };
}
