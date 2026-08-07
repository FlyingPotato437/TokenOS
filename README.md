# TokenOS

TokenOS is an inference compiler for production agents. A user gives it an objective and an execution contract: cost ceiling, latency SLA, quality floor, strategy, and data region. TokenOS retrieves long-term memory, pins policy constraints, evaluates thousands of model-memory-tool portfolios, executes the winning plan, evaluates the outcome, and records the economics.

The default build is a complete deterministic demo, so the core workflow works without credentials. Provider credentials switch the same workflow to EverOS and Snowflake.

## Why it is technically different

- Exact portfolio search across models, memories, and tools instead of a single model-routing heuristic.
- Hard feasibility checks for budget, latency, quality, required tools, critical memories, and region before inference.
- Pareto pruning exposes the cost-quality frontier and blocked alternatives.
- Memory is treated as an economic input: each item has token cost, expected success lift, utility, and a visible selected/pruned decision.
- Post-run evaluation checks policy, tool use, regional fit, and answer completeness.
- The feedback loop writes the interaction to EverOS and the plan economics to Snowflake.

With the included scenarios, the compiler enumerates 6,144 portfolios per run.

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
3. **Optimize:** enumerate every model, memory, and tool subset, reject violations, score strategies, and Pareto-prune the survivors.
4. **Execute:** invoke the selected model through Snowflake Cortex REST.
5. **Evaluate:** score the response against structural and policy checks.
6. **Learn:** add the interaction to EverOS and persist run economics through the Snowflake SQL API.

## Useful commands

```bash
npm run lint
npm run build
npm start
```

The API runs on `127.0.0.1:8787` by default. Vite proxies `/api` to it during development.
