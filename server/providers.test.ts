import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { scenarios } from "../shared/catalog.ts";
import type { RunConstraints } from "../shared/contracts.ts";
import { compileExecutionPlan } from "./optimizer.ts";
import {
  CORTEX_GENERATION_CONFIG,
  executeInference,
  getProviderStatus,
  retrieveMemories,
  writeInteractionToEverOS,
} from "./providers.ts";

const incident = scenarios.find((scenario) => scenario.id === "incident")!;
const constraints: RunConstraints = {
  maxCost: 0.003,
  maxLatencyMs: 1800,
  minSuccess: 0.9,
  maxMemoryTokens: 360,
  strategy: "balanced",
  region: "ANY_REGION",
};
const providerKeys = [
  "EVEROS_API_KEY",
  "EVEROS_BASE_URL",
  "EVEROS_USER_ID",
  "SNOWFLAKE_ACCOUNT_URL",
  "SNOWFLAKE_PAT",
  "TOKENOS_FORCE_MODEL",
] as const;
const originalEnvironment = Object.fromEntries(providerKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

function clearProviderEnvironment() {
  providerKeys.forEach((key) => delete process.env[key]);
}

afterEach(() => {
  providerKeys.forEach((key) => {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  globalThis.fetch = originalFetch;
});

test("deterministic adapters preserve a same-model baseline and optimized comparison", async () => {
  clearProviderEnvironment();
  const retrieval = await retrieveMemories(incident, incident.objective);
  const compile = compileExecutionPlan(incident, incident.objective, constraints, retrieval.memories);
  const baseline = await executeInference(
    incident,
    incident.objective,
    compile,
    retrieval.memories,
    compile.baseline,
    "baseline",
  );
  const optimized = await executeInference(
    incident,
    incident.objective,
    compile,
    retrieval.memories,
    compile.selected,
    "optimized",
  );

  assert.equal(getProviderStatus().everos, "demo");
  assert.equal(getProviderStatus().snowflake, "demo");
  assert.equal(retrieval.mode, "demo");
  assert.equal(retrieval.memories.length, 15);
  assert.equal(baseline.mode, optimized.mode);
  assert.equal(baseline.answer, optimized.answer);
  assert.ok(baseline.usage.promptTokens > optimized.usage.promptTokens);
  assert.equal(baseline.usage.estimated, true);
});

test("live EverOS retrieval preserves workspace policy and required-fact anchors", async () => {
  clearProviderEnvironment();
  process.env.EVEROS_API_KEY = "everos-test-key";
  process.env.EVEROS_BASE_URL = "https://everos.example";
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      data: {
        episodes: [{ id: "live-episode", summary: "A live incident memory.", score: 0.93 }],
        profiles: [{ id: "live-profile", profile_data: { format: "lead with the safe action" } }],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const retrieval = await retrieveMemories(incident, incident.objective);
  const ids = new Set(retrieval.memories.map((memory) => memory.id));

  assert.equal(retrieval.mode, "live");
  assert.equal(requestBody?.method, "hybrid");
  assert.equal(requestBody?.top_k, 15);
  assert.ok(ids.has("inc-policy-1"));
  assert.ok(ids.has("inc-episode-1"));
  assert.ok(ids.has("inc-case-1"));
  assert.ok(ids.has("live-episode"));
  assert.ok(ids.has("live-profile"));
  assert.equal(retrieval.memories.length, 15);
});

test("live Cortex execution sends only purchased memory and records provider usage", async () => {
  clearProviderEnvironment();
  process.env.SNOWFLAKE_ACCOUNT_URL = "https://snowflake.example";
  process.env.SNOWFLAKE_PAT = "snowflake-test-pat";
  const compile = compileExecutionPlan(incident, incident.objective, constraints, incident.memories);
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      choices: [{ message: { content: incident.demoAnswer } }],
      usage: { prompt_tokens: 515, completion_tokens: 128, total_tokens: 643 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const result = await executeInference(
    incident,
    incident.objective,
    compile,
    incident.memories,
    compile.selected,
    "optimized",
  );
  const messages = requestBody?.messages as Array<{ content: string }>;

  assert.equal(result.mode, "live");
  assert.equal(result.usage.promptTokens, 515);
  assert.equal(result.usage.estimated, false);
  assert.equal(requestBody?.temperature, CORTEX_GENERATION_CONFIG.temperature);
  assert.equal(requestBody?.max_completion_tokens, CORTEX_GENERATION_CONFIG.maxCompletionTokens);
  assert.match(messages[0].content, /No production restarts before 18:00 PT/);
  assert.doesNotMatch(messages[0].content, /documentation search index/);
});

test("completed interactions are written back to EverOS memory", async () => {
  clearProviderEnvironment();
  process.env.EVEROS_API_KEY = "everos-test-key";
  process.env.EVEROS_BASE_URL = "https://everos.example";
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(null, { status: 202 });
  }) as typeof fetch;

  const written = await writeInteractionToEverOS(incident.objective, incident.demoAnswer, "run-1");
  const messages = requestBody?.messages as Array<{ role: string; content: string }>;

  assert.equal(written, true);
  assert.equal(requestBody?.session_id, "tokenos-run-1");
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(messages[0].content, incident.objective);
});
