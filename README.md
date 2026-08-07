# TokenOS

TokenOS is an economic memory compiler for production agents. A user gives it an objective and an execution contract: cost ceiling, latency SLA, quality floor, memory budget, strategy, and data region. TokenOS retrieves long-term memory, pins policy constraints, evaluates every candidate-memory portfolio, executes the winning context, evaluates the outcome, and records the economics.

The default build is a complete deterministic demo, so the core workflow works without credentials. Provider credentials switch the same workflow to EverOS and Snowflake.

## Why it is technically different

- Exact search across all candidate-memory subsets instead of top-k similarity retrieval. The incident demo evaluates all `2^15 = 32,768` portfolios.
- Hard feasibility checks for token and dollar budget, latency, quality, required facts, required tools, critical memories, dependencies, and region before inference.
- A memory relationship graph prices duplicates, contradictions, dependencies, and complements into each portfolio.
- Marginal utility per token explains why each memory was pinned, purchased, or rejected.
- The baseline and compiled context use the same model, temperature, task, and tools so the token and cost delta is controlled.
- Counterfactual runs remove pinned, purchased, and rejected-control memories to test whether safety, facts, or outcome quality changed.
- Post-run evaluation checks policy, fact coverage, tool use, regional fit, and answer completeness.
- The feedback loop writes the interaction to EverOS and a complete evidence payload to Snowflake.

The default incident scenario buys a 194-token safe context from 15 candidates and refuses contracts below that proven safety floor.

## Run it

```bash
npm install
cp .env.example .env
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Live providers

Add the following values to `.env`:

```dotenv
EVEROS_API_KEY=
EVEROS_BASE_URL=https://api.evermind.ai
EVEROS_USER_ID=tokenos-demo-user

SNOWFLAKE_ACCOUNT_URL=https://your-account.snowflakecomputing.com
SNOWFLAKE_PAT=
SNOWFLAKE_DATABASE=
SNOWFLAKE_SCHEMA=
SNOWFLAKE_WAREHOUSE=
SNOWFLAKE_ROLE=
SNOWFLAKE_LEDGER_TABLE=TOKENOS_RUN_LEDGER
```

The Snowflake database and schema must already exist. TokenOS creates the ledger table on the first successful run. If SQL persistence is not configured, the recent-run API remains available in process at `GET /api/runs`.

## Product flow

1. **Recall:** hybrid-search EverOS for episodic and profile memory.
2. **Constrain:** pin policy-critical memory and required tools.
3. **Optimize:** enumerate every memory subset, reject hard-constraint violations, score the surviving portfolios, and expose the Pareto frontier.
4. **Execute:** run a full-memory baseline and compiled-memory variant through the same Snowflake Cortex model and generation configuration.
5. **Evaluate:** score the answer, run three causal ablations, and verify policies and required facts.
6. **Learn:** add the interaction to EverOS and persist usage, exposure, graph, evaluation, and ablation evidence through the Snowflake SQL API.

## Acceptance coverage

`npm run check` runs lint, 17 behavioral tests, server and client type-checks, and the production build. The suite covers:

- exact optimization, strategy tradeoffs, graph decisions, dependency enforcement, and minimum-safe-budget refusal;
- deterministic and live-shaped EverOS retrieval, Cortex inference, and EverOS memory write-back;
- Snowflake SQL table creation, complete evidence insertion, and identifier safety;
- the streamed API lifecycle, same-model controlled comparison, ablations, recent-run ledger, validation, and pre-inference refusal.

## Useful commands

```bash
npm run lint
npm test
npm run build
npm run check
npm start
```

The API runs on `127.0.0.1:8787` by default. Vite proxies `/api` to it during development.
