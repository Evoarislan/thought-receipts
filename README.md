# Thought Receipts

The pay-per-thought agent network. Open Agent Hackathon 2026, Track 2: **The Agent That Can Explain Why**.

## The idea

A coordinator agent breaks your task into subtasks. Three specialist agents (research, compute, synthesize) execute each subtask behind a **$0.01 x402 paywall**. Every payment, every input, and every output is logged as a receipt.

The "why" is the receipt chain. Ask why the agent did something, and it shows you the receipt for the exact reasoning step: what it was paid, what it was told, what it produced.

Two things make it memorable:

1. **The itemized bill for thinking.** When the agent answers, you see exactly what the thought cost: "This answer cost $0.07 across 7 reasoning steps." Nobody has shown a receipt for an agent's thought process before.
2. **Challenge a step.** Click any receipt, edit that step's input, and watch the downstream chain re-execute. Change "budget traveler" to "luxury traveler" at the lodging step and watch the hotel pick, the budget total, and the itinerary all rewrite themselves.

## Track fit

Track 2 asks for the agent that can explain why. Most entries will bolt an explanation UI onto a black box. Here the explanation is structural: every reasoning step is a paid, logged, attributable transaction. The audit trail is not a feature, it is the architecture.

## How it works

```
task
  |
  v
coordinator.decompose ......... $0.01 -> receipt #1
  |
  +--> research.gather-lodging .... $0.01 -> receipt #2
  +--> research.gather-activities . $0.01 -> receipt #3
  +--> research.gather-transport .. $0.01 -> receipt #4
  |
  v
compute.check-budget ........... $0.01 -> receipt #5
  |
  v
synthesize.write-itinerary ..... $0.01 -> receipt #6
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

Open http://localhost:3003. The demo task is prefilled: "Plan a 3-day Tokyo itinerary under $1500".

API:

- `GET /api/health` -> `{ ok, mock, pricePerStepUSDC, stepsPerRun }`
- `POST /api/run` with `{ "task": "..." }` -> `{ answer, bill, receipts, mock }`
- `POST /api/challenge` with `{ "task": "...", "receiptSeq": 2, "newInput": "..." }` -> `{ answer, bill, receipts, changedFrom, mock }`

Live mode (real EIP-3009 signing on Base Sepolia):

```bash
MOCK=false PRIVATE_KEY=0x... PAYEE_ADDRESS=0x... npm start
```

In live mode the buyer signs a real authorization per step. Signed, not submitted: in x402 the seller submits the authorization onchain, the buyer only signs.

## Demo script for judges

1. Click **Run the network** with the default Tokyo task. Watch 7 receipts appear in the feed, each a $0.01 payment with payer, payee, and signature ref.
2. Read the itemized bill: "This answer cost $0.07 across 7 reasoning steps."
3. Click receipt **#2 (Research lodging options)**. Change its input to "luxury traveler, 5-star hotels only". Click **Re-run from this step**.
4. Watch steps 2 through 7 re-execute (marked "re-executed"): the hotel pick jumps to Park Hyatt tier pricing, the budget total jumps with it, the itinerary rewrites. The bill updates. Steps 1 stays unchanged.
5. Point at the mock banner: all payments are simulated in this demo; flip `MOCK=false` for real EIP-3009 signatures.

## Repo layout

- `src/x402.ts` ... x402 payment helper (mock + live EIP-3009 signing)
- `src/agents.ts` ... coordinator + 3 specialists, deterministic mock reasoning, LLM adapter seam (`reasonWithModel`)
- `src/receipts.ts` ... receipt chain and itemized bill
- `src/server.ts` ... plain `http` server, JSON API, static frontend
- `public/index.html` ... dark single-page UI: live feed, bill, challenge panel

## Honest notes

- Reasoning is deterministic mock logic keyed on the task text, with an LLM adapter seam for a future upgrade. It runs with zero API keys.
- Mock mode simulates payments. Nothing here moves real money unless you set `MOCK=false` with your own key.
- The receipt chain, the bill math, and the challenge re-execution are all real and deterministic.

## License

MIT
