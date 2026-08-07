import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const objective =
  "Production checkout latency is back. Investigate it, but do not restart anything during business hours.";
const normalConstraints = {
  maxCost: 0.003,
  maxLatencyMs: 1800,
  minSuccess: 0.9,
  maxMemoryTokens: 360,
  strategy: "balanced",
  region: "ANY_REGION",
};

let apiProcess;
let apiOutput = "";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function check(label, condition, failureMessage) {
  if (!condition) throw new Error(failureMessage);
  console.log(`✓ ${label}`);
}

function eventOfType(events, type) {
  return events.find((event) => event.type === type);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!port) throw new Error("Could not reserve a local port for the smoke-test API.");
  return port;
}

async function startDemoApi(port) {
  const executable = path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx",
  );
  await access(executable).catch(() => {
    throw new Error("Missing local dependencies. Run npm install before npm run smoke.");
  });

  apiProcess = spawn(executable, ["server/index.ts"], {
    cwd: repoRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      PORT: String(port),
      EVEROS_API_KEY: "",
      EVEROS_BASE_URL: "",
      EVEROS_USER_ID: "",
      SNOWFLAKE_ACCOUNT_URL: "",
      SNOWFLAKE_PAT: "",
      SNOWFLAKE_DATABASE: "",
      SNOWFLAKE_SCHEMA: "",
      SNOWFLAKE_WAREHOUSE: "",
      SNOWFLAKE_ROLE: "",
      SNOWFLAKE_LEDGER_TABLE: "",
      TOKENOS_FORCE_MODEL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const collectOutput = (chunk) => {
    apiOutput = `${apiOutput}${chunk.toString()}`.slice(-4000);
  };
  apiProcess.stdout.on("data", collectOutput);
  apiProcess.stderr.on("data", collectOutput);
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (apiProcess?.exitCode !== null) {
      throw new Error(`Local API exited before becoming healthy.${apiOutput ? ` ${apiOutput.trim()}` : ""}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(750),
      });
      if (response.ok) return await response.json();
    } catch {
      // The server may still be loading TypeScript modules.
    }
    await delay(100);
  }
  throw new Error(`Health endpoint did not become ready within 15 seconds.${apiOutput ? ` ${apiOutput.trim()}` : ""}`);
}

async function runExperiment(baseUrl, constraints) {
  const response = await fetch(`${baseUrl}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenarioId: "incident", objective, constraints }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Expected POST /api/run to return 200, received ${response.status}: ${detail}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-ndjson")) {
    throw new Error(`Expected an NDJSON run stream, received ${contentType || "no content type"}.`);
  }

  const payload = await response.text();
  return payload
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Run stream line ${index + 1} was not valid JSON: ${line}`);
      }
    });
}

async function stopDemoApi() {
  if (!apiProcess || apiProcess.exitCode !== null) return;
  if (process.platform === "win32") {
    apiProcess.kill("SIGTERM");
  } else {
    try {
      process.kill(-apiProcess.pid, "SIGTERM");
    } catch {
      apiProcess.kill("SIGTERM");
    }
  }

  const exited = new Promise((resolve) => apiProcess.once("exit", resolve));
  await Promise.race([exited, delay(1500)]);
  if (apiProcess.exitCode === null) {
    if (process.platform === "win32") apiProcess.kill("SIGKILL");
    else {
      try {
        process.kill(-apiProcess.pid, "SIGKILL");
      } catch {
        apiProcess.kill("SIGKILL");
      }
    }
  }
}

async function main() {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  await startDemoApi(port);

  const health = await waitForHealth(baseUrl);
  check(
    "Health endpoint",
    health.ok === true && health.providers?.everos === "demo" && health.providers?.snowflake === "demo",
    `Expected a healthy deterministic demo API, received ${JSON.stringify(health)}.`,
  );

  const events = await runExperiment(baseUrl, normalConstraints);
  const unexpectedError = eventOfType(events, "run.error");
  if (unexpectedError) throw new Error(`Normal run returned run.error: ${unexpectedError.message}`);

  const recall = eventOfType(events, "recall.completed");
  const retrievedCount = Array.isArray(recall?.data?.memories) ? recall.data.memories.length : 0;
  check(
    "Retrieved 15 memories",
    retrievedCount === 15,
    `Expected 15 retrieved memories, received ${retrievedCount}.`,
  );

  const search = eventOfType(events, "search.completed");
  const compile = search?.data;
  check(
    "Evaluated 32,768 portfolios",
    compile?.evaluatedCount === 32_768,
    `Expected 32,768 evaluated portfolios, received ${compile?.evaluatedCount ?? "no value"}.`,
  );

  const inference = eventOfType(events, "inference.completed");
  const comparison = inference?.data?.comparison;
  const selectedModel = compile?.selected?.modelId;
  const baselineModel = compile?.baseline?.modelId;
  check(
    "Same Cortex model",
    comparison?.sameModel === true && selectedModel && selectedModel === baselineModel,
    `Expected the same Cortex model, received baseline=${baselineModel ?? "missing"}, optimized=${selectedModel ?? "missing"}, sameModel=${String(comparison?.sameModel)}.`,
  );

  const baselineTokens = comparison?.baseline?.usage?.promptTokens;
  const optimizedTokens = comparison?.optimized?.usage?.promptTokens;
  check(
    "Prompt tokens reduced",
    Number.isFinite(baselineTokens) && Number.isFinite(optimizedTokens) && optimizedTokens < baselineTokens,
    `Expected optimized prompt tokens below baseline, received baseline=${baselineTokens ?? "missing"}, optimized=${optimizedTokens ?? "missing"}.`,
  );

  const baselineCost = comparison?.baseline?.usage?.actualCost;
  const optimizedCost = comparison?.optimized?.usage?.actualCost;
  check(
    "Cortex cost reduced",
    Number.isFinite(baselineCost) && Number.isFinite(optimizedCost) && optimizedCost < baselineCost,
    `Expected optimized Cortex cost below baseline, received baseline=${baselineCost ?? "missing"}, optimized=${optimizedCost ?? "missing"}.`,
  );

  check(
    "Required facts preserved",
    comparison?.requiredFactsPreserved === true,
    `Expected required facts to be preserved, received ${String(comparison?.requiredFactsPreserved)}.`,
  );

  const counterfactualEvent = eventOfType(events, "counterfactual.completed");
  const counterfactuals = Array.isArray(counterfactualEvent?.data) ? counterfactualEvent.data : [];
  check(
    "Three counterfactuals returned",
    counterfactuals.length === 3,
    `Expected exactly 3 counterfactual ablations, received ${counterfactuals.length}.`,
  );

  const pinned = counterfactuals.find((item) => item.role === "pinned");
  check(
    "Pinned-policy ablation failed safety as expected",
    pinned?.policyPassed === false,
    pinned
      ? `Expected pinned-policy ablation to fail safety, received policyPassed=${String(pinned.policyPassed)}.`
      : "Expected a pinned-policy ablation, but none was returned.",
  );

  const control = counterfactuals.find((item) => item.role === "rejected_control");
  const controlIsImmaterial =
    control?.outcomeChanged === false &&
    control?.policyPassed === true &&
    control?.requiredFactsPreserved === true &&
    Math.abs(control?.qualityDelta ?? Number.POSITIVE_INFINITY) < 0.015;
  check(
    "Rejected-memory control caused no material change",
    controlIsImmaterial,
    control
      ? `Expected rejected-memory control to be immaterial, received outcomeChanged=${String(control.outcomeChanged)}, policyPassed=${String(control.policyPassed)}, requiredFactsPreserved=${String(control.requiredFactsPreserved)}, qualityDelta=${String(control.qualityDelta)}.`
      : "Expected a rejected-memory control ablation, but none was returned.",
  );

  const impossibleBudget = 1;
  const impossibleEvents = await runExperiment(baseUrl, {
    ...normalConstraints,
    maxMemoryTokens: impossibleBudget,
  });
  const impossibleError = eventOfType(impossibleEvents, "run.error");
  const minimumSafeTokens = impossibleError?.data?.compile?.minimumSafeMemoryTokens;
  const impossibleFailedSafely =
    impossibleError?.phase === "search" &&
    impossibleError?.data?.compile?.selected?.feasible === false &&
    Number.isFinite(minimumSafeTokens) &&
    minimumSafeTokens > impossibleBudget;
  check(
    "Impossible budget returned minimum safe budget",
    impossibleFailedSafely,
    impossibleError
      ? `Expected run.error with a minimum safe budget above ${impossibleBudget}, received minimumSafeMemoryTokens=${minimumSafeTokens ?? "missing"} and selected.feasible=${String(impossibleError?.data?.compile?.selected?.feasible)}.`
      : "Expected impossible budget to return run.error, but no run.error event was returned.",
  );

  console.log("\nPASS");
}

try {
  await main();
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  console.error("\nFAIL");
  process.exitCode = 1;
} finally {
  await stopDemoApi();
}
