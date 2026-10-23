# Thought Receipts

The pay-per-thought agent network. Open Agent Hackathon 2026, Track 2: **The Agent That Can Explain Why**.

## The idea

A coordinator agent breaks your task into subtasks. Three specialist agents (research, compute, synthesize) execute each subtask behind a **$0.01 x402 paywall**. Every payment, every input, and every output is logged as a receipt. Then a fourth role, the **evaluator**, checks the finished recommendation against the receipts before the answer stands, and after a pass it records a free **dissent** receipt with the strongest case for the runner-up.

The system is honestly a coordinator plus specialists plus an evaluator, not a free-form swarm: the specialists run in a planned order, and the evaluator is the second interaction, a verification pass over their work. Before pricing, an integrity check compares the working vendor data field by field against the registered sources and quarantines any disagreement. The evaluator recomputes the winner from the TCO table recorded in the compute receipt, confirms every dollar figure in the recommendation appears in an earlier receipt, and, when a model is configured, adds a model critique of the synthesis. Its verdict is its own receipt (#8, free), and the dissent follows as receipt #9. If verification fails, the discrepancy is recorded there and the final answer is annotated, never silently passed.

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

Five twist features are built on the same chain:

- **Sabotage round and integrity quarantine.** Tick "Sabotage round" and one value in the run's working copy of the vendor catalog is corrupted in memory only. The integrity check catches the disagreement against a fresh load of the registered sources before pricing, restores the source value, and receipts the catch. That integrity receipt records the corrupted working rows themselves with `dataSource: "working-catalog"` and `query: null`, because no query returned them; the label says working copy, not query result.
- **Replayable receipts.** Each data receipt (#2 and #4) records the exact query its own fetch ran, the rows that fetch returned, and which path served them. Replaying a receipt re-executes the recorded query in Zetaris mode through the data layer's own response parser, or re-derives the rows from the CSV sources, and reports MATCH or a field-level DIFF. Replaying the integrity receipt diffs its recorded working rows against a fresh source load and reproduces the caught discrepancy, which is the proof the catch was real.
- **Dissent receipt.** After the evaluator passes the recommendation, it records the strongest data-backed case for the runner-up (receipt #9 in a default run): the margin, the volumes at which the runner-up would win, its SLA rank, and its support terms. The recommendation stands; the chain shows the alternative was argued from the same data.
- **Dual-language receipts.** Every data receipt shows its SQL and a plain-English rendering generated from the query intent and the actual rows returned, so a non-SQL reader gets the same provenance a SQL reader gets.
- **Flip threshold.** The final answer states what would change it: the nearest egress volumes above and below the run's volume at which a different vendor becomes cheapest, computed from the actual records with the real TCO math over 0 to 5,000 TB/yr. The note ships as the `flipNote` field of the run response, and Why answers can cite it as a grounded fact tied to the compute receipt.

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
evaluator.dissent .............. $0.00 -> receipt #9 (strongest case for the
  |                                            runner-up, from the same records)
  v
answer + itemized bill ($0.07 across the 7 paid steps; the evaluator is free)

In a sabotage run the integrity check inserts its own free receipt just before
compute.compute-tco. Receipt sequence numbers are chain positions, assigned as
each receipt is emitted, so every later receipt numbers after the inserted one.
```

Payments use the x402 pattern with EIP-3009 USDC authorizations on Base Sepolia (see `src/x402.ts`, reused from our tested x402 buyer). Mock mode is the default: payments are simulated with fake signature refs and the UI says so loudly.

## AI and model usage (disclosure)

This section follows the structure required by the Open Agent Hackathon AI Usage Policy, section 6.

### Model providers and models

- Primary provider: Meterless, an OpenAI-compatible endpoint serving NVIDIA Nemotron. Model id: `nvidia/nemotron-3-ultra-550b-a55b` (the default `NEMOTRON_MODEL`). Receipts and Why answers record the id the provider actually returns when it reports one.
- Fallback provider: OpenRouter, used only when Meterless is not configured or is unreachable. Model ids, tried in order: `nvidia/nemotron-3-ultra-550b-a55b:free`, then `nvidia/nemotron-3-super-120b-a12b:free`. This fallback predates the build window (it was wired Oct 20, 2026) and is disclosed as such.
- Cursor's own models were used to write and debug code during development (see "How Cursor was used" below). They are not part of the product's run path, and no product API key was entered into Cursor.
- Model output enters the product in exactly two places: drafting Why-box answers, shown only after every dollar figure and vendor name in the draft is verified against the cited receipts (on any mismatch the draft is discarded and the template answer is used), and critiquing the synthesis inside the evaluator receipt. Every model result records its provider and the exact model id that answered.

### Agent framework

None. The pipeline is hand-rolled TypeScript on Node's built-in `http` module: a coordinator, three specialist agents (research, compute, synthesize), and an evaluator verification pass, running a planned sequence. It is not a free-form multi-agent swarm and is not described as one. The only runtime dependency is `viem`, used for EIP-3009 signing in live payment mode.

### How Zetaris is integrated

Zetaris is the data layer. The vendor dataset is prepared as three separate sources (vendor quotes, egress rates, support and SLA terms), bundled as CSV files under `data/` for registration in Zetaris as the matching tables. The pipeline's data steps fetch through the client in `src/zetaris.ts`: when `ZETARIS_BASE_URL` is configured, step 2 runs a SQL join across the three sources and step 4 runs a select against the terms source, and each data receipt records the exact query, the rows its own fetch returned, and `dataSource: "zetaris"`, so the receipt chain is the query chain. When no instance is configured, when `SAMPLE_MODE` is on, or when the live call errors, the same steps serve the bundled CSV sources and the receipts record `dataSource: "csv-fallback"` instead. The one provenance exception is the integrity receipt: it records the working copy's rows with `dataSource: "working-catalog"` and `query: null`, because no query returned them. The wiring is implemented in the pipeline and verified against a local stub endpoint; a live test against the managed AWS cluster is still pending. The managed cluster's exact HTTP SQL contract is not public, so the endpoint path and auth are environment-configurable in the one module that makes the call. Endpoint: TBD (from the cluster record; credentials are never published).

### How Meterless is integrated

A provider chain in `src/agents.ts` calls model providers in order: (1) Meterless, when `METERLESS_BASE_URL` and `METERLESS_API_KEY` are set: `POST {METERLESS_BASE_URL}/chat/completions` with a Bearer key, the provider contract headers (`meterless-app: thought-receipts` on every request, `meterless-scope: user` on chat), and model `NEMOTRON_MODEL`, with a 180 second timeout (a cold model load can take minutes); (2) OpenRouter, when `OPENROUTER_API_KEY` is set, 90 second timeout, models as listed above; (3) the deterministic path, with no model call. No named Meterless engine (H-MEM, World Model, Markovian, Scout Intent) is used, and none is claimed; Meterless serves as the Nemotron provider runtime. The chain is implemented and verified against a local OpenAI-compatible stub endpoint; the live test against the real event endpoint is still pending the event API key.

### How Cursor was used

Cursor is the development environment of record on the team laptop. This repo was developed and smoke-tested in the Cursor IDE with its Agent: the smoke test passed Oct 21, 2026 (the Agent created and ran a file in the clone using a Cursor model, with no product API key entered). Hackathon team access provisioning was still marked to be confirmed in the sponsor folder when this was written; the development above used the locally installed Cursor IDE.

### Where NVIDIA contributes

NVIDIA Nemotron models are the product's only reasoning models, reached through the provider chain above. They draft Why answers and critique the synthesis inside the evaluator receipt. NVIDIA technology is used nowhere else in the system. Event API key and credit provisioning was still marked to be confirmed in the sponsor folder when this was written; until it lands, the Nemotron path is exercised through the provider chain above (Meterless first, OpenRouter fallback).

### External tools and libraries

- Runtime: Node.js 20 or newer (developed on Node 24), TypeScript 7.
- Dependency: `viem` (EIP-3009 authorization signing in live payment mode). Everything else is Node built-ins.
- Payment pattern: x402, with EIP-3009 USDC authorizations on Base Sepolia (USDC contract `0x036CbD53842c5426634e7929541eC2318f3dCF7e`).
- Development and production tools: Cursor IDE; the demo video was produced with screen capture of the running app.

### Data sources

- Fictional cloud vendor dataset (synthetic, labeled as sample data everywhere it appears): three invented vendors (Nimbus Cloud, Stratus Systems, Cirrus Compute) with illustrative pricing, prepared as three CSV sources under `data/` (quotes, egress rates, support and SLA terms), with a data dictionary in `data/README.md`.
- No real vendor quotes, no scraped data, and no personal data are used anywhere in the system.

### Adapted open-source code

The x402 payment helper (`src/x402.ts`) was adapted from the team's own earlier x402 buyer work; it is declared as a pre-existing component (built Oct 19 to 20, 2026) in the submission form, together with the hash-chained receipt store, the coordinator and specialist pipeline, and the fictional vendor dataset. No third-party project code was copied into this repo. Everything else was built inside the build window (Oct 22 to 27, 2026) and is listed in the submission declaration.

### Known limitations

- Coordinator plus three specialists in a planned sequence plus an evaluator verification pass; not a free-form swarm. The evaluator cannot send work back for revision: on a failed check it records the discrepancy and the final answer is annotated, never silently passed.
- Core reasoning is deterministic logic keyed on the task text. Models only draft Why answers (verified against the cited receipts before display) and critique the synthesis inside the evaluator receipt. With no provider configured, both fall back to deterministic behavior and the demo runs with zero API keys.
- Scope is a deliberate domain gate: non-procurement tasks receive an honest out-of-scope refusal and a single $0 receipt, not a forced recommendation.
- Payments are simulated in mock mode, the default. Live mode signs EIP-3009 authorizations on Base Sepolia without submitting them; the seller side of x402 is out of scope for this project.
- Egress math uses decimal units (1 TB = 1000 GB), and the Stratus 500TB figure is a rate threshold, not free volume: the first 500TB per year are billed at $0.04 per GB and only volume above it at the $0.20 overage rate. See `data/README.md`.
- Zetaris: the data-layer wiring is implemented in the pipeline and verified against a local stub endpoint; the live AWS cluster test is pending. Meterless: the provider chain is implemented with the provider contract headers and verified against a local stub endpoint; the live endpoint test is pending the event API key.

### Fallback and sample-mode behavior

See the "Sample mode" section below. In short: `SAMPLE_MODE=true` makes no external network calls at all (model providers are refused even when keys are set) and runs the deterministic path over the bundled labeled sample dataset, disclosed in the health payload, the run payloads, and a UI banner. In default mode the same deterministic path serves any run where no model provider is configured, and the payload reports `sampleMode: false` because the model path is enabled but unused.

## Run it

Requires Node.js 20 or newer (developed on Node 24) and npm.

```bash
npm install
npm run build
npm start
```

Open http://localhost:3003. The demo task is prefilled: "Select a vendor for our $60K annual cloud infrastructure contract.".

API:

- `GET /api/health` -> `{ ok, mock, sampleMode, pricePerStepUSDC, stepsPerRun }`
- `POST /api/run` with `{ "task": "..." }` -> `{ answer, bill, receipts, flipNote, mock, sampleMode }`, where `flipNote` is the run's "what would change this answer" line (the nearest egress volumes above and below the run's volume at which the winner changes, or a constancy statement when no volume in 0 to 5,000 TB/yr changes it)
- `POST /api/run` with `{ "task": "...", "chaos": { "failStep": 3 } }` -> same, but step 3 fails once and recovers
- `POST /api/run` with `{ "task": "...", "sabotage": true }` -> same, with one working-copy value corrupted in memory so the integrity check can catch it
- `POST /api/challenge` with `{ "task": "...", "receiptSeq": 2, "newInput": "..." }` -> `{ answer, bill, receipts, changedFrom, flipNote, mock, sampleMode }`
- `GET /api/verify` -> `{ valid: true }` or `{ valid: false, brokenAt: <seq> }`
- `POST /api/replay` with `{ "seq": 4 }` -> `{ seq, step, replayable, result: "MATCH" | "DIFF", diffs?: [{ vendor, field, recorded, replayed }], via: "zetaris" | "csv-sources" | "working-copy-vs-sources", reason? }`; it re-derives the receipt's recorded rows (re-executing the recorded query for Zetaris receipts, reloading the CSV sources otherwise) and diffs them field by field
- `POST /api/why` with `{ "question": "..." }` -> `{ answer, citations: [<seq>, ...], mode: "model" | "template", provider: "meterless" | "openrouter" | null, model: <model id> | null }`; the latest run's `flipNote` is passed into the answer generation as a grounded fact tied to the compute receipt

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

1. Click **Run the network** with the default vendor task. Watch 9 receipts appear in the feed: 7 paid reasoning steps at $0.01 each with payer, payee, and signature ref, then a free eighth receipt from the evaluator and a free ninth, the dissent.
2. Open receipt **#8 (Evaluator verification)**: verdict PASS, with the winner recomputed from the recorded TCO table and every dollar figure in the recommendation traced to an earlier receipt. Note the bill still reads "This answer cost $0.07 across 7 reasoning steps": the evaluator is a verification step and is not charged. Then open receipt **#9 (Dissent)**: the strongest case for the runner-up, argued from the same records.
3. Read the recommendation: **Stratus Systems at $237K 3-year TCO**, beating Cirrus ($300K) and Nimbus ($306K). Point out the twist: Nimbus has the cheapest headline price ($48K/yr) and still finishes last, because its uncapped $0.12/GB egress costs $48K/yr at this volume. The obvious pick is not the right pick.
4. Click receipt **#3 (Profile the workload)**. Change its input to "double the data transfer volume". Click **Re-run from this step**.
5. Watch steps 3 through 7 re-execute (marked "re-executed"): the TCO table reprices at 800TB/yr, Stratus blows through its 500TB egress cap into $0.20/GB overage, and the winner flips to **Cirrus Compute at $408K** (Stratus $429K, Nimbus $450K). Steps 1 and 2 stay unchanged.
6. Ask **"why did you pick Stratus Systems?"** in the Why box. The answer cites the compute and recommendation receipts with the TCO numbers, and the line under the answer names the mode and provider that produced it (template here, since no model provider is configured; with one configured, a model draft appears only after it passes verification against the cited receipts, and the label names the provider and the exact model id). Click a citation chip to jump to that receipt.
7. Click **Verify chain**: the badge reads VALID. Then click **Simulate tampering** (client-side only): a copy of one receipt is edited, and the local checker reports `{ valid: false, brokenAt: 3 }`. One edited character breaks the chain from that point on.
8. Tick **"Simulate a step failure"** and run again: step 2's first attempt fails (a red $0 receipt records the timeout), the retry succeeds (green "recovered" badge), the pipeline completes, and the bill still totals $0.07.
9. Tick **"Sabotage round"** and run again: the integrity receipt appears at #5, recording the corrupted working-copy row (labeled working copy, no query), and the value is restored before pricing. Click **Replay against sources** on that receipt: the replay reproduces exactly the one-field diff against the registered sources. Replay receipts #2 and #4 as well: both report MATCH, because each records its own fetch's rows.
10. Point at the mock banner: all payments are simulated in this demo; flip `MOCK=false` for real EIP-3009 signatures. Vendor names and quotes are fictional and illustrative.

## Repo layout

- `src/x402.ts` ... x402 payment helper (mock + live EIP-3009 signing)
- `src/agents.ts` ... coordinator + 3 specialists + evaluator verification step, deterministic reasoning, LLM adapter seam (`reasonWithModel`), SAMPLE_MODE flag, chaos failure/recovery mode
- `src/receipts.ts` ... hash-chained receipts (sha256, prevHash), tamper verification, itemized bill
- `src/why.ts` ... "Why?" answering over the receipt chain with citations; model drafts are verified against the cited receipts before use, and the answer reports its mode
- `src/zetaris.ts` ... Zetaris data layer: the vendor queries, the live SQL client (env-configured endpoint), the bundled CSV fallback, and the loader that derives the vendor catalog from either path's rows
- `src/server.ts` ... plain `http` server, JSON API, static frontend
- `public/index.html` ... dark single-page UI: live feed, bill, challenge panel, Why box with answer-mode label, verify badge, tamper simulation
- `data/` ... the vendor dataset as three CSV sources (quotes, egress rates, support and SLA terms): the canonical catalog the pipeline loads, registered as the matching tables in Zetaris, with a data dictionary in `data/README.md`
- `scripts/` ... verification scripts; `zetaris-smoke.ts` checks the CSV sources reproduce the pipeline's TCO math exactly
- `metadata.json` ... submission metadata: track, team, sponsors, and honest integration status

## Honest notes

- The receipt chain, the bill math, the evaluator checks, and the challenge re-execution are all real and deterministic. Nothing in the demo is a hardcoded output: two different in-scope inputs produce different figures and different chains (verified in the submission dry run).
- Receipts carry the policy evidence fields: timestamp, agent name, action, input and output summaries, handoff target, model, status, and retry count.

## License

MIT
