/**
 * "Why?" answering over the receipt chain.
 *
 * Keyword/template based: extract keywords from the question, score each
 * receipt by overlap across its agent/title/inputSummary/outputSummary
 * fields, and compose a plain-English answer citing receipt sequence
 * numbers. Deterministic and dependency free.
 *
 * LLM upgrade seam: when a model is wired (reasonWithModelDetailed), it
 * drafts the answer instead, with the template citations kept as
 * grounding. A model draft is not trusted blindly: every dollar figure
 * and vendor name in the draft is checked against the cited receipts'
 * recorded contents, and on any mismatch the draft is discarded and the
 * template answer is returned. The response reports which mode produced
 * the answer ("model" or "template") and, for a model answer, which
 * provider answered ("meterless" or "openrouter") and the exact model
 * id. In SAMPLE_MODE no model call is attempted at all.
 */
import { reasonWithModelDetailed, SAMPLE_MODE, type ModelProvider } from "./agents.js";
import type { Receipt } from "./receipts.js";

export interface WhyAnswer {
  answer: string;
  citations: number[];
  /** "model" when a verified model draft was used, "template" otherwise. */
  mode: "model" | "template";
  /** Provider that drafted the answer; null for template answers. */
  provider: ModelProvider | null;
  /** Exact model id that drafted the answer; null for template answers. */
  model: string | null;
}

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "for",
  "with", "did", "do", "does", "was", "were", "is", "are", "you", "your",
  "it", "its", "that", "this", "what", "why", "how", "when", "where",
  "which", "who", "whom", "i", "we", "me", "us", "my", "our", "by", "at",
  "from", "as", "be", "been", "have", "has", "had", "not", "no", "so",
  "than", "too", "very", "can", "will", "just", "about", "into", "over",
  "after", "there", "their", "they", "them", "he", "she", "him", "her",
  "would", "could", "should", "pick", "picked", "choose", "chose", "make",
  "made", "tell", "show", "give", "explain", "decide", "decided", "use",
  "used", "get", "got", "any", "all", "each", "one", "two",
]);

function keywords(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scoreReceipt(r: Receipt, kws: string[]): number {
  const hay = `${r.agent} ${r.title} ${r.inputSummary} ${r.outputSummary}`.toLowerCase();
  let score = 0;
  for (const k of kws) {
    const hits = hay.match(new RegExp(`\\b${escapeRe(k)}`, "g"))?.length ?? 0;
    // Longer keywords are more specific, so they count double.
    score += hits * (k.length >= 6 ? 2 : 1);
  }
  // A failed attempt rarely explains anything.
  if (r.status === "failed") score *= 0.5;
  return score;
}

interface FlipFact {
  text: string;
  /** Sequence number of the compute receipt the fact is tied to. */
  citation: number;
}

function templateAnswer(hits: { r: Receipt; s: number }[], fact?: FlipFact | null): WhyAnswer {
  const top = hits.slice(0, 3);
  const lines = top.map(
    ({ r }) => `Receipt #${r.seq} (${r.agent}, "${r.title}"): ${r.outputSummary}`
  );
  let answer =
    `From the receipt chain:\n${lines.join("\n")}\n` +
    `In short: ${top[0].r.outputSummary}`;
  const citations = top.map(({ r }) => r.seq);
  if (fact) {
    answer += `\n\nFlip fact from receipt #${fact.citation}: ${fact.text}`;
    if (!citations.includes(fact.citation)) citations.push(fact.citation);
  }
  return { answer, citations, mode: "template", provider: null, model: null };
}

/** Recover the flip note from the finalize receipt when none was passed in. */
function flipNoteFromReceipts(receipts: Receipt[]): string | null {
  const finalize = receipts.find((r) => r.step === "finalize" && r.status !== "failed");
  if (!finalize) return null;
  const match = /(What would change this answer:[\s\S]*?)(?:\n\n|$)/.exec(finalize.detail);
  return match ? match[1].trim() : null;
}

/** Whether the question is about the decision, so the flip fact belongs in the answer. */
function flipFactRelevant(question: string, receipts: Receipt[]): boolean {
  const q = question.toLowerCase();
  if (
    /(flip|threshold|volume|egress|winner|cheapest|change your mind|change this answer|pick|picked|choose|chose|choice|recommend|selected|select)/.test(q)
  ) {
    return true;
  }
  return vendorNamesIn(receipts).some((name) => question.includes(name));
}

// --- Draft verification ------------------------------------------------------
// A model draft earns its place only if the cited receipts support it.

/**
 * Dollar amounts in a text as numeric values, so "$237K", "$237,000", and
 * "$48,000.00" compare equal when they are the same amount of money.
 */
function dollarValues(text: string): number[] {
  const values: number[] = [];
  for (const m of text.matchAll(/\$([\d,]+(?:\.\d+)?)(K)?/g)) {
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isFinite(n)) values.push(Math.round(n * (m[2] ? 1000 : 1) * 100) / 100);
  }
  return values;
}

/**
 * Vendor names, derived from the quote and TCO lines the research and
 * compute steps recorded ("- Nimbus Cloud: compute ..."). Nothing is
 * hardcoded: a name is a vendor here because the receipts say so.
 */
function vendorNamesIn(receipts: Receipt[]): string[] {
  const names = new Set<string>();
  for (const r of receipts) {
    for (const line of r.detail.split("\n")) {
      const m = /^- ([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)*): compute /.exec(line.trim());
      if (m) names.add(m[1]);
    }
  }
  return [...names];
}

/**
 * True when every dollar figure and every vendor name in the draft appears
 * in the cited receipts' recorded contents (input, output, and detail).
 */
function draftIsGrounded(draft: string, cited: Receipt[], allReceipts: Receipt[]): boolean {
  const corpus = cited
    .map((r) => `${r.inputSummary}\n${r.outputSummary}\n${r.detail}`)
    .join("\n");
  const recordedAmounts = new Set(dollarValues(corpus));
  for (const v of dollarValues(draft)) {
    if (!recordedAmounts.has(v)) return false;
  }
  const corpusLower = corpus.toLowerCase();
  for (const name of vendorNamesIn(allReceipts)) {
    if (draft.includes(name) && !corpusLower.includes(name.toLowerCase())) return false;
  }
  return true;
}

/**
 * Answer a "why" question about the latest run. Throws when there are no
 * receipts or the question is empty.
 */
export async function answerWhy(
  receipts: Receipt[],
  question: string,
  flipNote?: string | null
): Promise<WhyAnswer> {
  const q = question.trim().slice(0, 500);
  if (!q) throw new Error("question is required");
  if (receipts.length === 0) {
    throw new Error("No receipts yet. Run the network first, then ask why.");
  }

  // The run's flip note is a grounded fact of the run, tied to the
  // compute receipt whose records it was derived from. It joins the
  // answer when the question is about the decision, so a why answer
  // states the flip in the correct direction for the run's volume.
  const computeReceipt = receipts.find((r) => r.step === "compute-tco" && r.status !== "failed");
  const flipText = (flipNote ?? "").trim() || flipNoteFromReceipts(receipts);
  const fact: FlipFact | null =
    flipText && computeReceipt ? { text: flipText, citation: computeReceipt.seq } : null;
  const relevantFact = fact && flipFactRelevant(q, receipts) ? fact : null;

  const kws = keywords(q);
  const scored = receipts
    .map((r) => ({ r, s: scoreReceipt(r, kws) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  if (scored.length === 0) {
    if (relevantFact) {
      return {
        answer: `Flip fact from receipt #${relevantFact.citation}: ${relevantFact.text}`,
        citations: [relevantFact.citation],
        mode: "template",
        provider: null,
        model: null,
      };
    }
    return {
      answer: `I could not find anything in the receipt chain about "${q}". Try asking about a vendor, a TCO number, or a step the agents took.`,
      citations: [],
      mode: "template",
      provider: null,
      model: null,
    };
  }
  const cited = scored.slice(0, 3).map(({ r }) => r);

  // LLM seam: if a model is wired, it drafts the answer. The draft is shown
  // only if its figures and vendor names check out against the cited
  // receipts; otherwise the template answer stands. The response records
  // which provider and model produced a shown draft. SAMPLE_MODE never
  // attempts the call.
  if (!SAMPLE_MODE) {
    let draft: { text: string; model: string; provider: ModelProvider } | null = null;
    try {
      draft = await reasonWithModelDetailed(
        `Receipts:\n${receipts
          .map((r) => `#${r.seq} [${r.agent}] ${r.title}: ${r.outputSummary}`)
          .join("\n")}` +
          (relevantFact
            ? `\n\nGrounded flip fact from receipt #${relevantFact.citation}: ${relevantFact.text}`
            : "") +
          `\n\nQuestion: ${q}\n\nAnswer in plain English, citing receipt numbers.`
      );
    } catch {
      // No provider configured, or every provider failed: the template
      // answer stands.
    }
    if (draft && draftIsGrounded(draft.text, cited, receipts)) {
      let answer = draft.text;
      const citations = cited.map((r) => r.seq);
      if (relevantFact && !answer.includes(relevantFact.text)) {
        answer += `\n\nFlip fact from receipt #${relevantFact.citation}: ${relevantFact.text}`;
        if (!citations.includes(relevantFact.citation)) citations.push(relevantFact.citation);
      }
      return {
        answer,
        citations,
        mode: "model",
        provider: draft.provider,
        model: draft.model,
      };
    }
  }
  return templateAnswer(scored, relevantFact);
}
