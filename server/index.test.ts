import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { CompileResult } from "../shared/contracts.ts";
import type {
  RavenRunEvent,
  RavenRunRequest,
  RavenRunResult,
  SafeBudgetRefusal,
} from "../shared/raven-contract.ts";
import { app, recentRuns } from "./index.ts";
import { resetMemoryLedger } from "./ledger.ts";

let server: Server;
let baseUrl = "";

const standardRequest: RavenRunRequest = {
  scenarioId: "incident",
  objective: "Production checkout latency is back. Investigate it, but do not restart anything during business hours.",
  constraints: {
    minSuccess: 0.9,
    maxMemoryTokens: 360,
    strategy: "balanced",
  },
};

const environmentKeys = [
  "EVEROS_API_KEY",
  "EVEROS_BASE_URL",
  "EVEROS_USER_ID",
  "EVEROS_AGENT_ID",
  "RAVEN_COMMAND",
  "TOKENOS_LEDGER_PATH",
] as const;
const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));

async function run(input: RavenRunRequest) {
  const response = await fetch(`${baseUrl}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const events = (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RavenRunEvent);
  return { response, events };
}

before(async () => {
  environmentKeys.forEach((key) => delete process.env[key]);
  process.env.RAVEN_COMMAND = "/definitely/not/a/raven/binary";
  process.env.TOKENOS_LEDGER_PATH = ":memory:";
  resetMemoryLedger();
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
  environmentKeys.forEach((key) => {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  resetMemoryLedger();
});

test("health exposes EverOS and Raven without a model-routing provider", async () => {
  const [healthResponse, scenariosResponse] = await Promise.all([
    fetch(`${baseUrl}/api/health`),
    fetch(`${baseUrl}/api/scenarios`),
  ]);
  const health = await healthResponse.json() as {
    ok: boolean;
    service: string;
    providers: Record<string, string>;
  };
  const scenarioList = await scenariosResponse.json() as Array<{ id: string }>;

  assert.equal(health.ok, true);
  assert.equal(health.service, "tokenos-raven-memory-governor");
  assert.equal(health.providers.everos, "demo");
  assert.equal(health.providers.raven, "demo");
  assert.deepEqual(Object.keys(health.providers).sort(), ["everos", "message", "raven"]);
  assert.deepEqual(scenarioList.map((scenario) => scenario.id), ["incident", "support", "fraud"]);
});

test("the streamed lifecycle proves a controlled Raven A/B run and learns from it", { timeout: 20_000 }, async () => {
  const { response, events } = await run(standardRequest);
  const result = events.at(-1)?.data as RavenRunResult;

  assert.equal(response.status, 200);
  assert.deepEqual(events.map((event) => event.type), [
    "run.started",
    "recall.started",
    "recall.completed",
    "price.completed",
    "connect.completed",
    "compile.started",
    "compile.completed",
    "raven.started",
    "uncontrolled.completed",
    "governed.completed",
    "comparison.completed",
    "learn.started",
    "learn.completed",
    "run.completed",
  ]);
  assert.equal(result.kind, "completed");
  assert.equal(result.compile.evaluatedCount, 32768);
  assert.deepEqual(result.compile.selected.memoryIds, [
    "inc-policy-1",
    "inc-episode-1",
    "inc-case-1",
    "inc-profile-2",
  ]);
  assert.equal(result.comparison.uncontrolled.memoriesLoaded, 15);
  assert.equal(result.comparison.governed.memoriesLoaded, 4);
  assert.ok(result.comparison.tokenReduction > 0.3);
  assert.ok(result.comparison.memoryTokenReduction > 0.7);
  assert.equal(result.comparison.requiredFactsPreserved, true);
  assert.equal(result.comparison.sameRuntime, true);
  assert.equal(result.comparison.sameModel, true);
  assert.equal(result.comparison.sameTask, true);
  assert.equal(result.comparison.sameTools, true);
  assert.equal(result.comparison.executionContract.runtime, "raven");
  assert.equal(result.comparison.uncontrolled.usage.estimated, true);
  assert.equal(result.learning.written, true);
  assert.equal(result.learning.mode, "local");
  assert.equal(result.ledger.mode, "memory");
  assert.deepEqual(result.counterfactuals.map((item) => item.role), ["pinned", "selected", "rejected_control"]);
  assert.equal(result.counterfactuals[0].policyPassed, false);
  assert.equal(result.counterfactuals[2].outcomeChanged, false);

  const recentResponse = await fetch(`${baseUrl}/api/runs`);
  const stored = await recentResponse.json() as RavenRunResult[];
  assert.equal(stored[0].runId, result.runId);
});

test("the next related task visibly receives historical outcome lift", { timeout: 20_000 }, async () => {
  const { events } = await run(standardRequest);
  const recall = events.find((event) => event.type === "recall.completed")!;
  const recallData = recall.data as {
    historicalLiftApplied: boolean;
    memories: Array<{ id: string; historicalOutcomeLift?: number }>;
  };

  assert.equal(recallData.historicalLiftApplied, true);
  assert.ok((recallData.memories.find((memory) => memory.id === "inc-case-1")?.historicalOutcomeLift ?? 0) > 0);
  assert.equal(events.at(-1)?.type, "run.completed");
});

test("a budget below the computed safety floor refuses before Raven", { timeout: 10_000 }, async () => {
  const storedRunsBefore = recentRuns.length;
  const { events } = await run({
    ...standardRequest,
    constraints: { ...standardRequest.constraints, maxMemoryTokens: 160 },
  });
  const finalEvent = events.at(-1)!;
  const data = finalEvent.data as { refusal: SafeBudgetRefusal; compile: CompileResult };

  assert.equal(finalEvent.type, "compile.refused");
  assert.match(finalEvent.message, /Minimum safe budget: 194 tokens/);
  assert.equal(data.refusal.minimumSafeBudget, 194);
  assert.equal(data.compile.selected.feasible, false);
  assert.equal(events.some((event) => event.type === "raven.started"), false);
  assert.equal(events.some((event) => event.type === "learn.started"), false);
  assert.equal(recentRuns.length, storedRunsBefore);
});

test("invalid contracts return a normal JSON error", async () => {
  const response = await fetch(`${baseUrl}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...standardRequest, objective: "" }),
  });
  const payload = await response.json() as { error: string };

  assert.equal(response.status, 400);
  assert.match(payload.error, /token budget/);
});
