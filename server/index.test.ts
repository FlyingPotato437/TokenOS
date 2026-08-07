import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import type { CompileResult, RunEvent, RunRequest, RunResult } from "../shared/contracts.ts";
import { app, recentRuns } from "./index.ts";

let server: Server;
let baseUrl = "";

const standardRequest: RunRequest = {
  scenarioId: "incident",
  objective: "Production checkout latency is back. Investigate it, but do not restart anything during business hours.",
  constraints: {
    maxCost: 0.003,
    maxLatencyMs: 1800,
    minSuccess: 0.9,
    maxMemoryTokens: 360,
    strategy: "balanced",
    region: "ANY_REGION",
  },
};

function clearLiveProviderEnvironment() {
  [
    "EVEROS_API_KEY",
    "SNOWFLAKE_ACCOUNT_URL",
    "SNOWFLAKE_PAT",
    "SNOWFLAKE_DATABASE",
    "SNOWFLAKE_SCHEMA",
  ].forEach((key) => delete process.env[key]);
}

async function run(input: RunRequest) {
  const response = await fetch(`${baseUrl}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const events = (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);
  return { response, events };
}

before(async () => {
  clearLiveProviderEnvironment();
  recentRuns.length = 0;
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test("health and scenario contracts are available", async () => {
  const [healthResponse, scenariosResponse] = await Promise.all([
    fetch(`${baseUrl}/api/health`),
    fetch(`${baseUrl}/api/scenarios`),
  ]);
  const health = await healthResponse.json() as { ok: boolean; providers: { everos: string; snowflake: string } };
  const scenarios = await scenariosResponse.json() as Array<{ id: string }>;

  assert.equal(health.ok, true);
  assert.equal(health.providers.everos, "demo");
  assert.equal(health.providers.snowflake, "demo");
  assert.deepEqual(scenarios.map((scenario) => scenario.id), ["incident", "support", "fraud"]);
});

test("the streaming API completes the controlled experiment and records evidence", { timeout: 15_000 }, async () => {
  const { response, events } = await run(standardRequest);
  const eventTypes = events.map((event) => event.type);
  const finalEvent = events.at(-1)!;
  const result = finalEvent.data as RunResult;

  assert.equal(response.status, 200);
  assert.deepEqual(eventTypes, [
    "run.started",
    "recall.started",
    "recall.completed",
    "policy.completed",
    "search.started",
    "search.completed",
    "inference.started",
    "baseline.completed",
    "optimized.completed",
    "inference.completed",
    "evaluation.completed",
    "counterfactual.completed",
    "ledger.completed",
  ]);
  assert.equal(result.compile.evaluatedCount, 32768);
  assert.equal(result.compile.selected.feasible, true);
  assert.equal(result.comparison.sameModel, true);
  assert.equal(result.comparison.generationConfig.temperature, 0);
  assert.ok(result.comparison.tokenReduction > 0.5);
  assert.ok(result.comparison.costReduction > 0.2);
  assert.equal(result.comparison.requiredFactsPreserved, true);
  assert.deepEqual(result.counterfactuals.map((item) => item.role), ["pinned", "selected", "rejected_control"]);
  assert.equal(result.counterfactuals[0].policyPassed, false);
  assert.equal(result.counterfactuals[2].outcomeChanged, false);
  assert.equal(result.ledger.mode, "local");

  const recentResponse = await fetch(`${baseUrl}/api/runs`);
  const recent = await recentResponse.json() as RunResult[];
  assert.equal(recent.length, 1);
  assert.equal(recent[0].runId, result.runId);
});

test("a contract below the safety floor refuses before inference", { timeout: 10_000 }, async () => {
  const { events } = await run({
    ...standardRequest,
    constraints: { ...standardRequest.constraints, maxMemoryTokens: 160 },
  });
  const eventTypes = events.map((event) => event.type);
  const errorEvent = events.at(-1)!;
  const compile = (errorEvent.data as { compile: CompileResult }).compile;

  assert.equal(errorEvent.type, "run.error");
  assert.match(errorEvent.message, /Minimum safe context: 194 memory tokens/);
  assert.equal(compile.selected.feasible, false);
  assert.equal(compile.minimumSafeMemoryTokens, 194);
  assert.equal(eventTypes.includes("inference.started"), false);
  assert.equal(eventTypes.includes("ledger.completed"), false);
  assert.equal(recentRuns.length, 1);
});

test("invalid contracts are rejected as normal JSON errors", async () => {
  const response = await fetch(`${baseUrl}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...standardRequest, objective: "" }),
  });
  const payload = await response.json() as { error: string };

  assert.equal(response.status, 400);
  assert.match(payload.error, /valid constraints/);
});
