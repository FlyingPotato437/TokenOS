import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { scenarios } from "../shared/catalog.ts";
import type { MemoryGovernorConstraints } from "../shared/raven-contract.ts";
import { retrieveEverOSMemories, writeRavenCaseToEverOS } from "./everos.ts";
import { compileMemoryPortfolio } from "./optimizer.ts";
import {
  buildExecutionContract,
  buildRavenPrompt,
  executeRaven,
  getRavenProviderStatus,
} from "./raven.ts";

const incident = scenarios.find((scenario) => scenario.id === "incident")!;
const constraints: MemoryGovernorConstraints = {
  minSuccess: 0.9,
  maxMemoryTokens: 360,
  strategy: "balanced",
};
const environmentKeys = [
  "EVEROS_API_KEY",
  "EVEROS_BASE_URL",
  "EVEROS_USER_ID",
  "EVEROS_AGENT_ID",
  "RAVEN_COMMAND",
  "RAVEN_MODEL",
  "RAVEN_WORKSPACE",
  "RAVEN_TIMEOUT_MS",
] as const;
const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

function clearEnvironment() {
  environmentKeys.forEach((key) => delete process.env[key]);
}

afterEach(async () => {
  environmentKeys.forEach((key) => {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  globalThis.fetch = originalFetch;
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

test("EverOS replay returns all 15 candidates when credentials are absent", async () => {
  clearEnvironment();
  const retrieval = await retrieveEverOSMemories(incident, incident.objective);

  assert.equal(retrieval.mode, "demo");
  assert.equal(retrieval.memories.length, 15);
  assert.equal(retrieval.historicalLiftApplied, false);
});

test("live EverOS recall searches user and Raven tracks separately", async () => {
  clearEnvironment();
  process.env.EVEROS_API_KEY = "test-key";
  process.env.EVEROS_BASE_URL = "https://everos.example";
  process.env.EVEROS_USER_ID = "user-1";
  process.env.EVEROS_AGENT_ID = "raven-1";
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const data = body.user_id
      ? {
          episodes: [{ id: "live-episode", summary: "A live checkout incident memory.", score: 0.93 }],
          profiles: [{ id: "live-profile", profile_data: { format: "lead with the safe action" } }],
        }
      : {
          agent_cases: [{ id: "live-case", task_intent: "Diagnose checkout latency", key_insight: "Inspect pool saturation", score: 0.95 }],
          agent_skills: [{ id: "live-skill", name: "Pool diagnostics", content: "Run query Q-17", score: 0.91 }],
        };
    return new Response(JSON.stringify({ request_id: "req-1", data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const retrieval = await retrieveEverOSMemories(incident, incident.objective);
  const ids = new Set(retrieval.memories.map((memory) => memory.id));

  assert.equal(retrieval.mode, "live");
  assert.equal(bodies.length, 2);
  assert.equal(bodies.find((body) => body.user_id)?.include_profile, true);
  assert.equal(bodies.find((body) => body.agent_id)?.agent_id, "raven-1");
  assert.ok(bodies.every((body) => body.method === "hybrid" && body.top_k === 12));
  assert.ok(ids.has("inc-policy-1"));
  assert.ok(ids.has("live-episode"));
  assert.ok(ids.has("live-profile"));
  assert.ok(ids.has("live-case"));
  assert.ok(ids.has("live-skill"));
  assert.equal(retrieval.memories.find((memory) => memory.id === "live-case")?.type, "agent_case");
  assert.equal(retrieval.memories.find((memory) => memory.id === "live-skill")?.type, "agent_skill");
});

test("successful Raven outcomes are added and flushed for EverOS agent-case extraction", async () => {
  clearEnvironment();
  process.env.EVEROS_API_KEY = "test-key";
  process.env.EVEROS_BASE_URL = "https://everos.example";
  process.env.EVEROS_USER_ID = "user-1";
  process.env.EVEROS_AGENT_ID = "raven-1";
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ request_id: "case-request-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const receipt = await writeRavenCaseToEverOS({
    runId: "run-1",
    objective: incident.objective,
    answer: incident.demoAnswer,
    lesson: "Four memories were sufficient.",
    selectedMemoryIds: ["inc-policy-1", "inc-episode-1", "inc-case-1", "inc-profile-2"],
    historicalLiftApplied: false,
  });
  const messages = requests[0].body.messages as Array<{ sender_id: string; role: string }>;

  assert.equal(receipt.mode, "everos");
  assert.equal(receipt.written, true);
  assert.match(requests[0].url, /\/api\/v2\/memory\/add$/);
  assert.match(requests[1].url, /\/api\/v2\/memory\/flush$/);
  assert.equal(requests[1].body.session_id, "tokenos-run-1");
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "assistant"]);
  assert.deepEqual(messages.map((message) => message.sender_id), ["user-1", "raven-1", "raven-1"]);
});

test("Raven executions read exact model usage from isolated Raven traces", async () => {
  clearEnvironment();
  const directory = await mkdtemp(join(tmpdir(), "tokenos-raven-test-"));
  temporaryDirectories.push(directory);
  const runner = join(directory, "fake-raven.mjs");
  await writeFile(runner, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-m") + 1] || "";
const uncontrolled = prompt.includes("documentation search index");
const inputTokens = uncontrolled ? 1180 : 430;
const outputTokens = 126;
const directory = process.env.RAVEN_TRACING_DIR;
mkdirSync(join(directory, "logs"), { recursive: true });
writeFileSync(join(directory, "logs", "audit-spans.log"), JSON.stringify({
  spanId: "llm-1",
  name: "llm.call",
  attributes: {
    "llm.model": "openrouter/raven-fixed-test",
    "llm.usage.input_tokens": inputTokens,
    "llm.usage.output_tokens": outputTokens,
    "llm.usage.total_tokens": inputTokens + outputTokens
  }
}) + "\\n");
console.log(JSON.stringify({ answer: ${JSON.stringify(incident.demoAnswer)} }));
`, "utf8");
  await chmod(runner, 0o755);
  process.env.RAVEN_COMMAND = runner;
  process.env.RAVEN_MODEL = "openrouter/raven-fixed-test";

  const compile = compileMemoryPortfolio(incident, incident.objective, constraints, incident.memories);
  const contract = buildExecutionContract(incident, incident.objective);
  const governedPrompt = buildRavenPrompt(
    incident,
    incident.objective,
    compile.selected,
    incident.memories,
    contract,
  );
  const [uncontrolled, governed] = await Promise.all([
    executeRaven({
      runId: "run-1",
      kind: "uncontrolled",
      scenario: incident,
      objective: incident.objective,
      plan: compile.baseline,
      memories: incident.memories,
      contract,
    }),
    executeRaven({
      runId: "run-1",
      kind: "governed",
      scenario: incident,
      objective: incident.objective,
      plan: compile.selected,
      memories: incident.memories,
      contract,
    }),
  ]);

  assert.equal((await getRavenProviderStatus()).raven, "live");
  assert.doesNotMatch(governedPrompt, /documentation search index/);
  assert.match(governedPrompt, /No production restarts before 18:00 PT/);
  assert.equal(uncontrolled.usage.inputTokens, 1180);
  assert.equal(governed.usage.inputTokens, 430);
  assert.equal(uncontrolled.usage.estimated, false);
  assert.equal(governed.model, "openrouter/raven-fixed-test");
  assert.equal(uncontrolled.mode, "live");
  assert.equal(governed.mode, "live");
});

test("Raven replay is explicit and labels token counts as estimates", async () => {
  clearEnvironment();
  process.env.RAVEN_COMMAND = "/definitely/not/a/raven/binary";
  const compile = compileMemoryPortfolio(incident, incident.objective, constraints, incident.memories);
  const contract = buildExecutionContract(incident, incident.objective);
  const result = await executeRaven({
    runId: "run-2",
    kind: "governed",
    scenario: incident,
    objective: incident.objective,
    plan: compile.selected,
    memories: incident.memories,
    contract,
  });

  assert.equal(result.mode, "demo");
  assert.equal(result.usage.estimated, true);
  assert.equal(result.answer, incident.demoAnswer);
});
