import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { scenarios } from "../shared/catalog.ts";
import type { ExecutionComparison, RunResult, RunUsage } from "../shared/contracts.ts";
import { evaluateRun } from "./evaluator.ts";
import { persistRunToSnowflake } from "./ledger.ts";
import { compileExecutionPlan } from "./optimizer.ts";

const ledgerKeys = [
  "SNOWFLAKE_ACCOUNT_URL",
  "SNOWFLAKE_PAT",
  "SNOWFLAKE_DATABASE",
  "SNOWFLAKE_SCHEMA",
  "SNOWFLAKE_WAREHOUSE",
  "SNOWFLAKE_ROLE",
  "SNOWFLAKE_LEDGER_TABLE",
] as const;
const originalEnvironment = Object.fromEntries(ledgerKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

function clearLedgerEnvironment() {
  ledgerKeys.forEach((key) => delete process.env[key]);
}

function buildRun(): Omit<RunResult, "ledger"> {
  const scenario = scenarios[0];
  const compile = compileExecutionPlan(scenario, scenario.objective, {
    maxCost: 0.003,
    maxLatencyMs: 1800,
    minSuccess: 0.9,
    maxMemoryTokens: 360,
    strategy: "balanced",
    region: "ANY_REGION",
  }, scenario.memories);
  const optimizedUsage: RunUsage = {
    promptTokens: 674,
    completionTokens: 120,
    totalTokens: 794,
    actualCost: 0.0005,
    estimated: true,
  };
  const baselineUsage: RunUsage = {
    promptTokens: 1461,
    completionTokens: 120,
    totalTokens: 1581,
    actualCost: 0.0007,
    estimated: true,
  };
  const optimizedEvaluation = evaluateRun(scenario, scenario.demoAnswer, compile, "ANY_REGION");
  const baselineEvaluation = evaluateRun(
    scenario,
    scenario.demoAnswer,
    compile,
    "ANY_REGION",
    compile.baseline,
  );
  const comparison: ExecutionComparison = {
    baseline: { answer: scenario.demoAnswer, usage: baselineUsage, evaluation: baselineEvaluation },
    optimized: { answer: scenario.demoAnswer, usage: optimizedUsage, evaluation: optimizedEvaluation },
    tokenReduction: 1 - optimizedUsage.promptTokens / baselineUsage.promptTokens,
    costReduction: 1 - optimizedUsage.actualCost / baselineUsage.actualCost,
    requiredFactsPreserved: true,
    sameModel: true,
    modelId: compile.selected.modelId,
    measurementMode: "demo",
    generationConfig: { temperature: 0, maxCompletionTokens: 600 },
  };

  return {
    runId: "ledger-test-run",
    scenarioId: scenario.id,
    objective: scenario.objective,
    answer: scenario.demoAnswer,
    compile,
    usage: optimizedUsage,
    evaluation: optimizedEvaluation,
    comparison,
    counterfactuals: [],
    providers: { everos: "demo", snowflake: "demo", message: "test" },
    createdAt: "2026-08-07T18:00:00.000Z",
  };
}

afterEach(() => {
  ledgerKeys.forEach((key) => {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  globalThis.fetch = originalFetch;
});

test("the ledger stays locally available when Snowflake SQL is not configured", async () => {
  clearLedgerEnvironment();
  const result = await persistRunToSnowflake(buildRun());

  assert.equal(result.mode, "local");
  assert.match(result.detail, /in-process ledger/);
});

test("Snowflake persistence creates the evidence table and inserts a complete proof payload", async () => {
  clearLedgerEnvironment();
  process.env.SNOWFLAKE_ACCOUNT_URL = "https://snowflake.example";
  process.env.SNOWFLAKE_PAT = "snowflake-test-pat";
  process.env.SNOWFLAKE_DATABASE = "TOKENOS_DB";
  process.env.SNOWFLAKE_SCHEMA = "PUBLIC";
  process.env.SNOWFLAKE_LEDGER_TABLE = "RUN_EVIDENCE";
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const result = await persistRunToSnowflake(buildRun());
  const insert = requests[1];
  const bindings = insert.bindings as Record<string, { value: string }>;
  const payload = JSON.parse(bindings["1"].value) as Record<string, unknown>;
  const evidence = payload.evidence as Record<string, unknown>;

  assert.equal(result.mode, "snowflake");
  assert.equal(requests.length, 2);
  assert.match(String(requests[0].statement), /CREATE TABLE IF NOT EXISTS TOKENOS_DB\.PUBLIC\.RUN_EVIDENCE/);
  assert.match(String(insert.statement), /INSERT INTO TOKENOS_DB\.PUBLIC\.RUN_EVIDENCE/);
  assert.equal(payload.requiredFactsPreserved, true);
  assert.ok(Array.isArray(payload.memoryExposure));
  assert.ok(Array.isArray(evidence.relationshipEdges));
  assert.equal(evidence.evaluatedCount, 32768);
});

test("unsafe Snowflake identifiers are rejected before a SQL request is sent", async () => {
  clearLedgerEnvironment();
  process.env.SNOWFLAKE_ACCOUNT_URL = "https://snowflake.example";
  process.env.SNOWFLAKE_PAT = "snowflake-test-pat";
  process.env.SNOWFLAKE_DATABASE = "TOKENOS_DB";
  process.env.SNOWFLAKE_SCHEMA = "PUBLIC";
  process.env.SNOWFLAKE_LEDGER_TABLE = "RUN_EVIDENCE;DROP_TABLE";
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;

  const result = await persistRunToSnowflake(buildRun());

  assert.equal(result.mode, "fallback");
  assert.match(result.detail, /Invalid Snowflake identifier/);
  assert.equal(called, false);
});
