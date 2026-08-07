# TokenOS

**Budget-aware memory for Raven.** Raven learns forever; TokenOS decides what it can afford to remember right now.

TokenOS sits between EverOS recall and Raven execution. It prices each recalled memory in tokens, connects duplicates and contradictions, pins non-negotiable policies, and runs an exact portfolio search to produce the smallest high-value context that satisfies the task's safety floor. It then compares uncontrolled Raven with governed Raven under the same task, model, tools, and generation settings.

The default build is a deterministic, fully labeled replay. Add EverOS credentials and an installed Raven CLI to switch the same pipeline to live recall, live execution, Raven trace-based token measurement, and EverOS learning.

## What is technically different

- EverOS user recall and Raven agent recall are separate: profiles/episodes and agent cases/skills are searched independently, then merged.
- The incident demo examines all `2^15 = 32,768` memory portfolios instead of accepting a similarity top-k.
- A memory-value graph prices duplicates, contradictions, dependencies, complements, staleness, distraction, and learned outcome lift.
- Policies and required facts are hard constraints. An unsafe token budget is refused before Raven runs, with a computed minimum safe budget.
- The A/B comparison changes memory only. Runtime, task fingerprint, configured model, tools, temperature, and output limit stay fixed.
- Live token usage comes from Raven's isolated `llm.call` traces. If a provider omits usage, TokenOS marks the displayed count as an estimate.
- Successful portfolios are appended to a small local evidence ledger and flushed to EverOS for Raven agent-case and skill extraction.
- On the next related task, memories from successful cases receive a measurable historical outcome lift.

The default balanced incident run selects four memories: the restart policy, prior connection-pool incident, successful diagnostic query, and operator communication preference.

## Run it

```bash
npm install
cp .env.example .env
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The API runs on `127.0.0.1:8787`; Vite proxies `/api` during development.

## Live EverOS and Raven

Configure `.env` without committing it:

```dotenv
EVEROS_API_KEY=
EVEROS_BASE_URL=https://api.evermind.ai
EVEROS_USER_ID=tokenos-demo-user
EVEROS_AGENT_ID=tokenos-raven

RAVEN_COMMAND=raven
RAVEN_MODEL=configured-default
RAVEN_WORKSPACE=
RAVEN_TIMEOUT_MS=120000

TOKENOS_LEDGER_PATH=.tokenos/run-ledger.jsonl
```

TokenOS invokes Raven's official one-shot form, `raven agent -m "..."`, and gives each run an isolated trace directory. The ledger directory and environment files are ignored by Git.

## Product flow

1. **Recall:** search both EverOS memory tracks for profiles, episodes, Raven cases, and skills.
2. **Price:** count every candidate's memory tokens and apply successful-case lift.
3. **Connect:** construct the memory relationship graph.
4. **Compile:** enumerate every portfolio and reject unsafe, incomplete, contradictory, or over-budget sets.
5. **Raven executes:** run uncontrolled and governed turns under one fixed execution contract, then compare token usage and policy results.
6. **Learn:** record compact A/B evidence locally and flush successful outcomes to EverOS.

## Verification

`npm run check` runs lint, 20 behavioral tests, server/client type-checks, and the production build. Coverage includes:

- exact memory search, all relationship classes, hard dependencies, learned-case bids, and computed safety refusal;
- dual-track EverOS retrieval plus add-and-flush agent-case writeback;
- official Raven CLI invocation and exact usage extraction from Raven traces;
- same-runtime A/B controls, the streamed six-stage lifecycle, local evidence, and next-run learning.

```bash
npm run lint
npm test
npm run build
npm run check
npm start
```
