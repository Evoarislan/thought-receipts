# Thought Receipts

The pay-per-thought agent network. Open Agent Hackathon 2026, Track 2: **The Agent That Can Explain Why**.

## The idea

A coordinator agent breaks your task into subtasks. Three specialist agents (research, compute, synthesize) execute each subtask behind a **$0.01 x402 paywall**. Every payment, every input, and every output is logged as a receipt. Then a fourth role, the **evaluator**, checks the finished recommendation against the receipts before the answer stands.

The system is honestly a coordinator plus specialists plus an evaluator, not a free-form swarm: the specialists run in a planned order, and the evaluator is the second interaction, a verification pass over their work. The evaluator recomputes the winner from the TCO table recorded in the compute receipt, confirms every dollar figure in the recommendation appears in an earlier receipt, and, when a model is configured, adds a model critique of the synthesis. Its verdict is its own receipt (#8, free). If verification fails, the discrepancy is recorded there and the final answer is annotated, never silently passed.

The "why" is the receipt chain. Ask why the agent did something, and it shows you the receipt for the exact reasoning step: what it was paid, what it was told, what it produced.

## Why this task

The demo task is vendor selection for a $60K annual cloud infrastructure contract. That is deliberate. The event brief asks for production-oriented agents that solve meaningful problems for real users, not another demo. Procurement decisions carry real money, and they are exactly where explainability has economic value: "why did you pick vendor B?" should have an answer backed by math, not vibes. The receipt chain turns a $237K recommendation into an auditable artifact. A travel itinerary could never do that.

Three things make it memorable:

1. **The itemized bill for thinking.** When the agent answers, you see exactly what the thought cost: "This answer cost $0.07 across 7 reasoning steps." Nobody has shown a receipt for an agent's thought process before.
2. **Challenge a step.** Click any receipt, edit that step's input, and watch the downstream chain re-execute. Double the data transfer volume at the workload step and watch the winner flip from Stratus Systems to Cirrus Compute as the egress math reprices itself.
3. **Tamper-evident receipts.** Every receipt is hash-chained (sha256 over the previous hash plus the receipt body). Edit one character and verification breaks downstream of the edit. The **Verify chain** button proves it live.

Three more demo beats:

- **Ask why.** A "Why?" box answers questions about the run in plain English, grounded in the receipt chain with clickable citations. Try: "why did you pick Stratus Systems?" The answer is labeled with the mode and provider that produced it: a model draft (shown only after its dollar figures and vendor names are verified against the cited receipts) or the built-in template.
- **The evaluator.** Receipt #8 is a free verification step, not a paid thought. Open it to see the checks: the winner recomputed from the recorded TCO figures, the figure-by-figure trace of the recommendation back to earlier receipts, and a model critique when one is configured.
- **Break and recover.** Tick "Simulate a step failure" before running. That step's first attempt fails (a $0 receipt records the timeout), the coordinator retries automatically (a "recovered" receipt records the retry), and the pipeline completes. The bill still totals $0.07.

## The non-obvious winner

Three fictional vendors quote for the contract (illustrative pricing, not real quotes):

- **Nimbus Cloud**: cheapest headline at $48K/yr compute, but uncapped egress metered at $0.12/GB.
- **Stratus Systems**: $54K/yr compute, egress billed at $0.04/GB for the first 500TB/yr, then $0.20/GB overage, 24/7 engineer support.
- **Cirrus Compute**: $60K/yr compute, egress $0.09/GB with no cap.

At 400TB/yr the 3-year TCOs are Stratus $237K, Cirrus $300K, Nimbus $306K. The cheapest headline loses because egress dominates the total. Double the transfer volume to 800TB/yr and Stratus blows through its 500TB cap into punitive overage: Cirrus wins at $408K against Stratus $429K and Nimbus $450K. The obvious pick is not the right pick, and the receipt chain shows exactly why, in dollars.

## Track fit

Track 2 asks for the agent that can explain why. Most entries will bolt an explanation UI onto a black box. Here the explanation is structural: every reasoning step is a paid, logged, attributable transaction. The audit trail is not a feature, it is the architecture.

## How it works

```
task: "Select a vendor for our $60K annual cloud infrastructure contract."
  |
  v
coordinator.decompose ......... $0.01 -> receipt #1
  |
  +--> research.gather-quotes .... $0.01 -> receipt #2
  +--> research.profile-workload . $0.01 -> receipt #3
  +--> research.check-terms ...... $0.01 -> receipt #4
  |
  v
compute.compute-tco ............ $0.01 -> receipt #5
  |
  v
synthesize.write-recommendation  $0.01 -> receipt #6
  |
  v
coordinator.finalize ........... $0.01 -> receipt #7
  |
  v
evaluator.evaluate ............. $0.00 -> receipt #8 (verification: winner recomputed
  |                                            from the recorded TCO table, every
  |                                            dollar figure traced to an earlier
  |                                            receipt, optional model critique)
  v
answer + itemized bill ($0.07 across the 7 paid steps; the evaluator is free)
```

Payments use the x402 pattern with EIP-3009 USDC authorizations on Base Sepolia (see `src/x402.ts`, reused from our tested x402 buyer). Mock mode is the default: payments are simulated with fake signature refs and the UI says so loudly.

## How we built it: AI, models, and sponsors

- **Meterless** is the primary model provider in a provider chain implemented in `src/agents.ts`. When `METERLESS_BASE_URL` and `METERLESS_API_KEY` are set, model calls go to the Meterless endpoint (OpenAI-compatible) running NVIDIA Nemotron; OpenRouter is the fallback when Meterless is not configured or unreachable. The chain is implemented and verified against a local stub endpoint; a live test against the event endpoint is pending the event API key.
- **Zetaris** is the data layer in progress. The vendor dataset is prepared as three separate CSV sources under `data/` (quotes, egress rates, support and SLA terms), and `src/zetaris.ts` is the client seam that resolves those sources offline today. Wiring the app to the live Zetaris AWS cluster is the remaining step and is in progress; live SQL queries do not run yet.
- **Cursor** is the development environment: this repo was developed and smoke-tested in the Cursor IDE with its Agent.
- **NVIDIA** Nemotron models are the product's reasoning models, reached through the provider chain above. The model ids in use are `nvidia/nemotron-3-ultra-550b-a55b` (the default `NEMOTRON_MODEL` on the Meterless path) and, on the OpenRouter fallback path, `nvidia/nemotron-3-ultra-550b-a55b:free` then `nvidia/nemotron-3-super-120b-a12b:free`. Model output enters the product in exactly two places: drafting Why answers (shown only after verification against the cited receipts) and critiquing the synthesis inside the evaluator receipt. Both record the provider and the exact model id that answered.

## Run it

```bash
npm install
npm run build
npm start
```

Open http://localhost:3003. The demo task is prefilled: "Select a vendor for our $60K annual cloud infrastructure contract.".

API:

- `GET /api/health` -> `{ ok, mock, sampleMode, pricePerStepUSDC, stepsPerRun }`
- `POST /api/run` with `{ "task": "..." }` -> `{ answer, bill, receipts, mock, sampleMode }`
- `POST /api/run` with `{ "task": "...", "chaos": { "failStep": 3 } }` -> same, but step 3 fails once and recovers
- `POST /api/challenge` with `{ "task": "...", "receiptSeq": 2, "newInput": "..." }` -> `{ answer, bill, receipts, changedFrom, mock, sampleMode }`
- `GET /api/verify` -> `{ valid: true }` or `{ valid: false, brokenAt: <seq> }`
- `POST /api/why` with `{ "question": "..." }` -> `{ answer, citations: [<seq>, ...], mode: "model" | "template", provider: "meterless" | "openrouter" | null, model: <model id> | null }`

Live mode (real EIP-3009 signing on Base Sepolia):

```bash
MOCK=false PRIVATE_KEY=0x... PAYEE_ADDRESS=0x... npm start
```

In live mode the buyer signs a real authorization per step. Signed, not submitted: in x402 the seller submits the authorization onchain, the buyer only signs.

Environment variables (see `.env.example` for the full list with placeholders):

- `MOCK`: `true` (default) simulates payments; `false` enables live EIP-3009 signing.
- `PRIVATE_KEY` and `PAYEE_ADDRESS`: live mode only, as shown above.
- `METERLESS_BASE_URL`, `METERLESS_API_KEY`, `NEMOTRON_MODEL` (optional, primary model provider): when the base URL and key are set, model calls run NVIDIA Nemotron through the Meterless endpoint (OpenAI-compatible: `POST {METERLESS_BASE_URL}/chat/completions`, Bearer key, model `NEMOTRON_MODEL`, default `nvidia/nemotron-3-ultra-550b-a55b`). The evaluator adds a model critique of the recommendation, and the Why box drafts its answers with the model. Every model result records truthful provenance: the evaluator receipt's model field names the provider and the exact model id that answered, and each Why answer reports `provider` and `model` next to its mode, with both shown in the UI.
- `OPENROUTER_API_KEY` (optional, fallback model provider): used when Meterless is not configured or is unreachable. When set, the Why box drafts its answers with real Nemotron models through OpenRouter (it tries `nvidia/nemotron-3-ultra-550b-a55b:free`, then `nvidia/nemotron-3-super-120b-a12b:free`), and the evaluator adds a model critique of the recommendation. A Why draft is shown only after every dollar figure and vendor name in it is verified against the cited receipts; on any mismatch the draft is discarded and the template answer is returned. With neither provider configured, the Why box uses its built-in template answers and the evaluator runs its deterministic checks only, so the demo still runs with zero API keys.
- `SAMPLE_MODE`: `true` runs the server fully offline (see Sample mode below). Default `false`.
- `PORT`: HTTP port, default 3003.

## Sample mode

```bash
SAMPLE_MODE=true npm start
```

Sample mode exists for judges and reviewers who have no API keys. With `SAMPLE_MODE=true`:

- The server makes **no external network calls at all**. The model seam refuses to run even if provider keys (`METERLESS_API_KEY`, `OPENROUTER_API_KEY`) are set.
- Reasoning runs on the deterministic path over the bundled sample data (the fictional vendor catalog), the Why box answers from its templates, and the evaluator runs its deterministic checks only, with no model critique.
- Sample mode is disclosed everywhere it matters: `GET /api/health` and the run payloads carry `sampleMode: true`, and the UI shows a SAMPLE MODE banner next to the payment-mode banner.

With `SAMPLE_MODE=false` (the default), the behavior above flips only where a model is configured: the Why box drafts with the model (verified against the citations before being shown) and the evaluator adds its critique. Payments are governed separately by `MOCK`; sample mode says nothing about payments, and in the default configuration they are simulated.

## Demo script for judges

1. Click **Run the network** with the default vendor task. Watch 8 receipts appear in the feed: 7 paid reasoning steps at $0.01 each with payer, payee, and signature ref, then a free eighth receipt from the evaluator.
2. Open receipt **#8 (Evaluator verification)**: verdict PASS, with the winner recomputed from the recorded TCO table and every dollar figure in the recommendation traced to an earlier receipt. Note the bill still reads "This answer cost $0.07 across 7 reasoning steps": the evaluator is a verification step and is not charged.
3. Read the recommendation: **Stratus Systems at $237K 3-year TCO**, beating Cirrus ($300K) and Nimbus ($306K). Point out the twist: Nimbus has the cheapest headline price ($48K/yr) and still finishes last, because its uncapped $0.12/GB egress costs $48K/yr at this volume. The obvious pick is not the right pick.
4. Click receipt **#3 (Profile the workload)**. Change its input to "double the data transfer volume". Click **Re-run from this step**.
5. Watch steps 3 through 7 re-execute (marked "re-executed"): the TCO table reprices at 800TB/yr, Stratus blows through its 500TB egress cap into $0.20/GB overage, and the winner flips to **Cirrus Compute at $408K** (Stratus $429K, Nimbus $450K). Steps 1 and 2 stay unchanged.
6. Ask **"why did you pick Stratus Systems?"** in the Why box. The answer cites the compute and recommendation receipts with the TCO numbers, and the line under the answer names the mode and provider that produced it (template here, since no model provider is configured; with one configured, a model draft appears only after it passes verification against the cited receipts, and the label names the provider and the exact model id). Click a citation chip to jump to that receipt.
7. Click **Verify chain**: the badge reads VALID. Then click **Simulate tampering** (client-side only): a copy of one receipt is edited, and the local checker reports `{ valid: false, brokenAt: 3 }`. One edited character breaks the chain from that point on.
8. Tick **"Simulate a step failure"** and run again: step 2's first attempt fails (a red $0 receipt records the timeout), the retry succeeds (green "recovered" badge), the pipeline completes, and the bill still totals $0.07.
9. Point at the mock banner: all payments are simulated in this demo; flip `MOCK=false` for real EIP-3009 signatures. Vendor names and quotes are fictional and illustrative.

## Repo layout

- `src/x402.ts` ... x402 payment helper (mock + live EIP-3009 signing)
- `src/agents.ts` ... coordinator + 3 specialists + evaluator verification step, deterministic reasoning, LLM adapter seam (`reasonWithModel`), SAMPLE_MODE flag, chaos failure/recovery mode
- `src/receipts.ts` ... hash-chained receipts (sha256, prevHash), tamper verification, itemized bill
- `src/why.ts` ... "Why?" answering over the receipt chain with citations; model drafts are verified against the cited receipts before use, and the answer reports its mode
- `src/zetaris.ts` ... Zetaris client seam: resolves the three vendor CSV sources under `data/` offline today; the live cluster endpoint plugs in here
- `src/server.ts` ... plain `http` server, JSON API, static frontend
- `public/index.html` ... dark single-page UI: live feed, bill, challenge panel, Why box with answer-mode label, verify badge, tamper simulation
- `data/` ... the vendor dataset as three CSV sources (quotes, egress rates, support and SLA terms) prepared for Zetaris registration, with a data dictionary in `data/README.md`
- `scripts/` ... verification scripts; `zetaris-smoke.ts` checks the CSV sources reproduce the in-code TCO math exactly
- `metadata.json` ... submission metadata: track, team, sponsors, and honest integration status

## Honest notes

- The pipeline is a coordinator plus three specialists running a planned sequence, plus an evaluator that verifies the result against the receipts. It is not a free-form multi-agent swarm, and the README does not claim otherwise.
- Core reasoning is deterministic logic keyed on the task text. The model, when a provider is configured (Meterless serving Nemotron first, OpenRouter as fallback), does two bounded jobs: drafting Why answers (verified against the cited receipts before being shown) and critiquing the synthesis inside the evaluator receipt. With no provider, both fall back to deterministic behavior and the demo runs with zero API keys.
- `SAMPLE_MODE=true` disables the model seam entirely, so a run makes no external network calls. That is the mode to judge in when you have no keys.
- Mock mode simulates payments. Nothing here moves real money unless you set `MOCK=false` with your own key.
- The receipt chain, the bill math, the evaluator checks, and the challenge re-execution are all real and deterministic.

## License

MIT
