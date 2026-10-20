/**
 * "Why?" answering over the receipt chain.
 *
 * Keyword/template based: extract keywords from the question, score each
 * receipt by overlap across its agent/title/inputSummary/outputSummary
 * fields, and compose a plain-English answer citing receipt sequence
 * numbers. Deterministic and dependency free.
 *
 * LLM upgrade seam: wire reasonWithModel() to a real model and the answer
 * below is drafted by the model instead, with the template citations kept
 * as grounding. The seam is shared with agents.ts.
 */
import { reasonWithModel } from "./agents.js";
import type { Receipt } from "./receipts.js";

export interface WhyAnswer {
  answer: string;
  citations: number[];
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

function templateAnswer(question: string, hits: { r: Receipt; s: number }[]): WhyAnswer {
  const top = hits.slice(0, 3);
  const lines = top.map(
    ({ r }) => `Receipt #${r.seq} (${r.agent}, "${r.title}"): ${r.outputSummary}`
  );
  const answer =
    `From the receipt chain:\n${lines.join("\n")}\n` +
    `In short: ${top[0].r.outputSummary}`;
  return { answer, citations: top.map(({ r }) => r.seq) };
}

/**
 * Answer a "why" question about the latest run. Throws when there are no
 * receipts or the question is empty.
 */
export async function answerWhy(receipts: Receipt[], question: string): Promise<WhyAnswer> {
  const q = question.trim().slice(0, 500);
  if (!q) throw new Error("question is required");
  if (receipts.length === 0) {
    throw new Error("No receipts yet. Run the network first, then ask why.");
  }

  const kws = keywords(q);
  const scored = receipts
    .map((r) => ({ r, s: scoreReceipt(r, kws) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  // LLM seam: if a model is wired, it drafts the answer; the template
  // citations below stay as grounding either way.
  let modelDraft: string | null = null;
  try {
    modelDraft = await reasonWithModel(
      `Receipts:\n${receipts
        .map((r) => `#${r.seq} [${r.agent}] ${r.title}: ${r.outputSummary}`)
        .join("\n")}\n\nQuestion: ${q}\n\nAnswer in plain English, citing receipt numbers.`
    );
  } catch {
    // reasonWithModel is not configured: the template answer stands.
  }

  if (scored.length === 0) {
    return {
      answer: `I could not find anything in the receipt chain about "${q}". Try asking about a hotel, a budget number, or a step the agents took.`,
      citations: [],
    };
  }

  if (modelDraft) {
    return { answer: modelDraft, citations: scored.slice(0, 3).map(({ r }) => r.seq) };
  }
  return templateAnswer(q, scored);
}
