/**
 * Thought Receipts server: static frontend + JSON API.
 *
 *   GET  /api/health     -> { ok, mock, pricePerStepUSDC, stepsPerRun }
 *   POST /api/run        -> { answer, bill, receipts, mock }
 *   POST /api/challenge  -> { answer, bill, receipts, changedFrom, mock }
 *
 * /api/challenge re-runs the pipeline from one receipt with edited input and
 * returns the new chain. Steps before the challenged one are unchanged.
 */
import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFile } from "fs/promises";
import { dirname, join, normalize } from "path";
import { fileURLToPath } from "url";
import { runPipeline, STEP_COUNT } from "./agents.js";
import { buildBill } from "./receipts.js";
import { MOCK_MODE, PRICE_PER_STEP_USDC } from "./x402.js";

const PORT = Number(process.env.PORT || 3003);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

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
        pricePerStepUSDC: PRICE_PER_STEP_USDC.toFixed(2),
        stepsPerRun: STEP_COUNT,
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/run") {
      const body = JSON.parse(await readBody(req)) as { task?: string };
      if (!body.task || !body.task.trim()) throw new Error("task is required");
      const { answer, receipts } = await runPipeline(body.task);
      json(res, 200, { answer, bill: buildBill(receipts), receipts, mock: MOCK_MODE });
      return;
    }

    if (req.method === "POST" && pathname === "/api/challenge") {
      const body = JSON.parse(await readBody(req)) as {
        task?: string;
        receiptSeq?: number;
        newInput?: string;
      };
      const seq = Number(body.receiptSeq);
      const newInput = (body.newInput || "").trim().slice(0, 500);
      if (!body.task || !body.task.trim()) throw new Error("task is required");
      if (!Number.isInteger(seq) || seq < 1 || seq > STEP_COUNT) {
        throw new Error(`receiptSeq must be between 1 and ${STEP_COUNT}`);
      }
      if (!newInput) throw new Error("newInput is required");
      const { answer, receipts } = await runPipeline(body.task, new Map([[seq, newInput]]));
      json(res, 200, {
        answer,
        bill: buildBill(receipts),
        receipts,
        changedFrom: seq,
        mock: MOCK_MODE,
      });
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
  console.log(`Thought Receipts listening on :${PORT} (mock=${MOCK_MODE})`);
});
