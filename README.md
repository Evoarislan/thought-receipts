# Thought Receipts

The pay-per-thought agent network. Open Agent Hackathon 2026, Track 2: **The Agent That Can Explain Why**.

## The idea

A coordinator agent breaks your task into subtasks. Three specialist agents (research, compute, synthesize) execute each subtask behind a **$0.01 x402 paywall**. Every payment, every input, and every output is logged as a receipt.

The "why" is the receipt chain. Ask why the agent did something, and it shows you the receipt for the exact reasoning step: what it was paid, what it was told, what it produced.

## Why this task

The demo task is vendor selection for a $60K annual cloud infrastructure contract. That is deliberate. The event brief asks for production-oriented agents that solve meaningful problems for real users, not another demo. Procurement decisions carry real money, and they are exactly where explainability has economic value: "why did you pick vendor B?" should have an answer backed by math, not vibes. The receipt chain turns a $237K recommendation into an auditable artifact. A travel itinerary could never do that.

Three things make it memorable:

1. **The itemized bill for thinking.** When the agent answers, you see exactly what the thought cost: "This answer cost $0.07 across 7 reasoning steps." Nobody has shown a receipt for an agent's thought process before.
2. **Challenge a step.** Click any receipt, edit that step's input, and watch the downstream chain re-execute. Double the data transfer volume at the workload step and watch the winner flip from Stratus Systems to Cirrus Compute as the egress math reprices itself.
3. **Tamper-evident receipts.** Every receipt is hash-chained (sha256 over the previous hash plus the receipt body). Edit one character and verification breaks downstream of the edit. The **Verify chain** button proves it live.

Two more demo beats:

- **Ask why.** A "Why?" box answers questions about the run in plain English, grounded in the receipt chain with clickable citations. Try: "why did you pick Stratus Systems?"
- **Break and recover.** Tick "Simulate a step failure" before running. That step's first attempt fails (a $0 receipt records the timeout), the coordinator retries automatically (a "recovered" receipt records the retry), and the pipeline completes. The bill still totals $0.07.

## The non-obvious winner

Three fictional vendors quote for the contract (illustrative pricing, not real quotes):

- **Nimbus Cloud**: cheapest headline at $48K/yr compute, but uncapped egress metered at $0.12/GB.
- **Stratus Systems**: $54K/yr compute, egress $0.04/GB included up to 500TB/yr then $0.20/GB overage, 24/7 engineer support.
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
answer + itemized bill ($0.07)
```

Payments use the x402 pattern with EIP-3009 USDC authorizations on Base Sepolia (see `src/x402.ts`, reused from our tested x402 buyer). Mock mode is the default: payments are simulated with fake signature refs and the UI says so loudly.

## Run it

```bash
npm install
npm run build
npm start
```

Open http://localhost:3003. The demo task is prefilled: "Select a vendor for our $60K annual cloud infrastructure contract.".

API:

- `GET /api/health` -> `{ ok, mock, pricePerStepUSDC, stepsPerRun }`
- `POST /api/run` with `{ "task": "..." }` -> `{ answer, bill, receipts, mock }`
- `POST /api/run` with `{ "task": "...", "chaos": { "failStep": 3 } }` -> same, but step 3 fails once and recovers
- `POST /api/challenge` with `{ "task": "...", "receiptSeq": 2, "newInput": "..." }` -> `{ answer, bill, receipts, changedFrom, mock }`
- `GET /api/verify` -> `{ valid: true }` or `{ valid: false, brokenAt: <seq> }`
- `POST /api/why` with `{ "question": "..." }` -> `{ answer, citations: [<seq>, ...] }`

Live mode (real EIP-3009 signing on Base Sepolia):

```bash
MOCK=false PRIVATE_KEY=0x... PAYEE_ADDRESS=0x... npm start
```

In live mode the buyer signs a real authorization per step. Signed, not submitted: in x402 the seller submits the authorization onchain, the buyer only signs.

Environment variables (see `.env.example` for the full list with placeholders):

- `MOCK`: `true` (default) simulates payments; `false` enables live EIP-3009 signing.
- `PRIVATE_KEY` and `PAYEE_ADDRESS`: live mode only, as shown above.
- `OPENROUTER_API_KEY` (optional): when set, the Why box drafts its answers with real Nemotron models through OpenRouter (it tries `nvidia/nemotron-3-ultra-550b-a55b:free`, then `nvidia/nemotron-3-super-120b-a12b:free`), grounded in the receipt citations. With no key set, the Why box falls back to its built-in template answers, so the demo still runs with zero API keys.
- `PORT`: HTTP port, default 3003.

## Demo script for judges

1. Click **Run the network** with the default vendor task. Watch 7 receipts appear in the feed, each a $0.01 payment with payer, payee, and signature ref.
2. Read the itemized bill: "This answer cost $0.07 across 7 reasoning steps."
3. Read the recommendation: **Stratus Systems at $237K 3-year TCO**, beating Cirrus ($300K) and Nimbus ($306K). Point out the twist: Nimbus has the cheapest headline price ($48K/yr) and still finishes last, because its uncapped $0.12/GB egress costs $48K/yr at this volume. The obvious pick is not the right pick.
4. Click receipt **#3 (Profile the workload)**. Change its input to "double the data transfer volume". Click **Re-run from this step**.
5. Watch steps 3 through 7 re-execute (marked "re-executed"): the TCO table reprices at 800TB/yr, Stratus blows through its 500TB egress cap into $0.20/GB overage, and the winner flips to **Cirrus Compute at $408K** (Stratus $429K, Nimbus $450K). Steps 1 and 2 stay unchanged.
6. Ask **"why did you pick Stratus Systems?"** in the Why box. The answer cites the compute and recommendation receipts with the TCO numbers. Click a citation chip to jump to that receipt.
7. Click **Verify chain**: the badge reads VALID. Then click **Simulate tampering** (client-side only): a copy of one receipt is edited, and the local checker reports `{ valid: false, brokenAt: 3 }`. One edited character breaks the chain from that point on.
8. Tick **"Simulate a step failure"** and run again: step 2's first attempt fails (a red $0 receipt records the timeout), the retry succeeds (green "recovered" badge), the pipeline completes, and the bill still totals $0.07.
9. Point at the mock banner: all payments are simulated in this demo; flip `MOCK=false` for real EIP-3009 signatures. Vendor names and quotes are fictional and illustrative.

## Repo layout

- `src/x402.ts` ... x402 payment helper (mock + live EIP-3009 signing)
- `src/agents.ts` ... coordinator + 3 specialists, deterministic mock reasoning, LLM adapter seam (`reasonWithModel`), chaos failure/recovery mode
- `src/receipts.ts` ... hash-chained receipts (sha256, prevHash), tamper verification, itemized bill
- `src/why.ts` ... "Why?" answering over the receipt chain with citations, LLM upgrade seam
- `src/server.ts` ... plain `http` server, JSON API, static frontend
- `public/index.html` ... dark single-page UI: live feed, bill, challenge panel, Why box, verify badge, tamper simulation

## Honest notes

- Reasoning is deterministic mock logic keyed on the task text, with an LLM adapter seam for a future upgrade. It runs with zero API keys.
- Mock mode simulates payments. Nothing here moves real money unless you set `MOCK=false` with your own key.
- The receipt chain, the bill math, and the challenge re-execution are all real and deterministic.

## License

MIT
