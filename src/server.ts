/**
 * Thought Receipts server: static frontend + JSON API.
 *
 *   GET  /api/health     -> { ok, mock, sampleMode, pricePerStepUSDC, stepsPerRun }
 *   POST /api/run        -> { answer, bill, receipts, mock, sampleMode }
 *   POST /api/challenge  -> { answer, bill, receipts, changedFrom, mock, sampleMode }
 *   GET  /api/verify     -> { valid } or { valid: false, brokenAt }
 *   POST /api/why        -> { answer, citations, mode, provider, model }
 *   POST /api/replay     -> { seq, step, replayable, result?, diffs?, via?, reason? }
 *
 * /api/run also accepts sabotage: true for the integrity drill: one value
 * in the run's working vendor data is corrupted in memory only, and the
 * pipeline's integrity check is expected to catch it against the
 * registered sources before pricing.
 *
 * /api/challenge re-runs the pipeline from one receipt with edited input and
 * returns the new chain. Steps before the challenged one are unchanged.
 * The posted receiptSeq is a chain position in the latest run (the number
 * the UI shows on the receipt), not a logical step number: positions and
 * step numbers diverge whenever a run inserts a $0 system receipt or a
 * chaos attempt. The handler resolves the position through the stored
 * chain to the receipt's step, then applies the override to that step.
 * Positions that land on a $0 system receipt (evaluator, dissent,
 * integrity, scope check) are refused with an honest 400, because those
 * receipts record no step input to edit.
 *
 * /api/run accepts optional chaos: { failStep: n } to simulate a step
 * failure and automatic recovery. The latest run's receipts are kept in
 * memory so /api/verify and /api/why can read them.
 */
import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFile } from "fs/promises";
import { dirname, join, normalize } from "path";
import { fileURLToPath } from "url";
import { logicalSeqForStep, runPipeline, replayReceipt, SAMPLE_MODE, STEP_COUNT } from "./agents.js";
import { buildBill, verifyChain, type Receipt } from "./receipts.js";
import { answerWhy } from "./why.js";
import { MOCK_MODE, PRICE_PER_STEP_USDC } from "./x402.js";

const PORT = Number(process.env.PORT || 3003);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

/** Latest run's receipts, kept in memory for /api/verify and /api/why. */
let latestReceipts: Receipt[] = [];
/** Latest run's flip note, passed into /api/why as a grounded fact. */
let latestFlipNote: string | null = null;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return false;
  try {
    const data = await readFile(file);
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream" });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/api/health") {
      json(res, 200, {
        ok: true,
        mock: MOCK_MODE,
        sampleMode: SAMPLE_MODE,
        pricePerStepUSDC: PRICE_PER_STEP_USDC.toFixed(2),
        stepsPerRun: STEP_COUNT,
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/run") {
      const body = JSON.parse(await readBody(req)) as {
        task?: string;
        chaos?: { failStep?: number };
        sabotage?: boolean;
      };
      if (!body.task || !body.task.trim()) throw new Error("task is required");
      let chaos: { failStep: number } | undefined;
      if (body.chaos && body.chaos.failStep !== undefined) {
        const n = Number(body.chaos.failStep);
        if (!Number.isInteger(n) || n < 1 || n > STEP_COUNT) {
          throw new Error(`chaos.failStep must be between 1 and ${STEP_COUNT}`);
        }
        chaos = { failStep: n };
      }
      const { answer, receipts, flipNote } = await runPipeline(body.task, new Map(), chaos, {
        sabotage: body.sabotage === true,
      });
      latestReceipts = receipts;
      latestFlipNote = flipNote;
      json(res, 200, { answer, bill: buildBill(receipts), receipts, flipNote, mock: MOCK_MODE, sampleMode: SAMPLE_MODE });
      return;
    }

    if (req.method === "POST" && pathname === "/api/challenge") {
      const body = JSON.parse(await readBody(req)) as {
        task?: string;
        receiptSeq?: number;
        newInput?: string;
      };
      const pos = Number(body.receiptSeq);
      const newInput = (body.newInput || "").trim().slice(0, 500);
      if (!body.task || !body.task.trim()) throw new Error("task is required");
      if (!Number.isInteger(pos) || pos < 1) {
        throw new Error(
          "receiptSeq must be a positive integer: the receipt's position in the latest run's chain"
        );
      }
      if (!newInput) throw new Error("newInput is required");
      // Resolve the posted chain position against the latest run's stored
      // chain. The stored chain is the bridge between the two numberings:
      // its receipts carry both their position (seq) and their step.
      if (latestReceipts.length === 0) {
        throw new Error("No run yet. Run the network first, then challenge a receipt from that run.");
      }
      const target = latestReceipts.find((r) => r.seq === pos);
      if (!target) {
        throw new Error(
          `Receipt ${pos} is not in the latest run, which has ${latestReceipts.length} receipt${latestReceipts.length === 1 ? "" : "s"}. Challenge a receipt from the current chain.`
        );
      }
      const stepSeq = logicalSeqForStep(target.step);
      if (stepSeq === null) {
        const what =
          target.step === "evaluate"
            ? "the evaluator's verification receipt"
            : target.step === "dissent"
              ? "the dissent receipt, the evaluator's recorded case for the runner-up"
              : target.step === "integrity-check"
                ? "the data integrity check receipt"
                : target.step === "scope-check"
                  ? "the scope-check receipt"
                  : `a $0 system receipt ("${target.step}")`;
        throw new Error(`Receipt ${pos} is ${what}, not a paid step; challenge a paid step instead.`);
      }
      const { answer, receipts, flipNote } = await runPipeline(body.task, new Map([[stepSeq, newInput]]));
      latestReceipts = receipts;
      latestFlipNote = flipNote;
      json(res, 200, {
        answer,
        bill: buildBill(receipts),
        receipts,
        flipNote,
        changedFrom: pos,
        step: target.step,
        stepTitle: target.title,
        stepSeq,
        mock: MOCK_MODE,
        sampleMode: SAMPLE_MODE,
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/replay") {
      const body = JSON.parse(await readBody(req)) as { seq?: number };
      const seq = Number(body.seq);
      if (!Number.isInteger(seq) || seq < 1) throw new Error("seq must be a positive integer");
      if (latestReceipts.length === 0) {
        json(res, 200, { seq, step: "", replayable: false, reason: "No run yet. Run the network first, then replay a receipt." });
        return;
      }
      json(res, 200, await replayReceipt(latestReceipts, seq));
      return;
    }

    if (req.method === "GET" && pathname === "/api/verify") {
      if (latestReceipts.length === 0) {
        json(res, 200, { valid: false, error: "No run yet. Run the network first." });
        return;
      }
      json(res, 200, verifyChain(latestReceipts));
      return;
    }

    if (req.method === "POST" && pathname === "/api/why") {
      const body = JSON.parse(await readBody(req)) as { question?: string };
      const result = await answerWhy(latestReceipts, body.question ?? "", latestFlipNote);
      json(res, 200, result);
      return;
    }

    if (req.method === "GET") {
      if (await serveStatic(pathname, res)) return;
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : "bad request" });
  }
});

server.listen(PORT, () => {
  console.log(`Thought Receipts listening on :${PORT} (mock=${MOCK_MODE}, sampleMode=${SAMPLE_MODE})`);
});
