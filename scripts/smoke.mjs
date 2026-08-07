import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const passes = [];

function check(condition, label, failure) {
  if (!condition) throw new Error(failure);
  passes.push(label);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child, output) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`API exited with ${child.exitCode}: ${output.join("").trim()}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`API did not become healthy: ${output.join("").trim()}`);
}

async function streamRun(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const events = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { response, events };
}

async function activeFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if ([".git", "node_modules", "dist", ".tokenos"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await activeFiles(target));
    else if (/\.(?:md|mjs|ts|tsx|json|html|svg|example)$/.test(entry.name) || entry.name === ".env.example") files.push(target);
  }
  return files;
}

async function verifyVocabulary() {
  const forbidden = [`Snow${"flake"}`, `Cor${"tex"}`];
  const offenders = [];
  for (const file of await activeFiles(root)) {
    const content = await readFile(file, "utf8");
    if (forbidden.some((term) => content.toLowerCase().includes(term.toLowerCase()))) {
      offenders.push(path.relative(root, file));
    }
  }
  check(offenders.length === 0, "No retired product references", `Retired product references remain in: ${offenders.join(", ")}`);
}

const eventOrder = [
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
];

const requests = {
  incident: {
    scenarioId: "incident",
    objective: "Production checkout latency is back. Investigate it, but do not restart anything during business hours.",
    constraints: { minSuccess: 0.9, maxMemoryTokens: 360, strategy: "balanced" },
  },
  support: {
    scenarioId: "support",
    objective: "Draft the next action for Northstar Health. Respect data residency and avoid repeating the failed migration step.",
    constraints: { minSuccess: 0.88, maxMemoryTokens: 500, strategy: "balanced" },
  },
  fraud: {
    scenarioId: "fraud",
    objective: "Investigate the anomalous payout cluster and match this analyst's prior escalation policy.",
    constraints: { minSuccess: 0.88, maxMemoryTokens: 500, strategy: "balanced" },
  },
};

async function main() {
  await verifyVocabulary();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(path.join(root, "node_modules", ".bin", "tsx"), ["server/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      EVEROS_MODE: "replay",
      EVEROS_API_KEY: "",
      RAVEN_MODE: "replay",
      TOKENOS_LEDGER_PATH: ":memory:",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    const health = await waitForHealth(baseUrl, child, output);
    check(health.ok === true, "Health endpoint", `Expected healthy API, received ${JSON.stringify(health)}`);
    check(
      health.providers?.everos === "replay" && health.providers?.raven === "replay",
      "Replay labels are explicit",
      `Expected replay/replay provider labels, received ${JSON.stringify(health.providers)}`,
    );

    const scenariosResponse = await fetch(`${baseUrl}/api/scenarios`);
    const scenarios = await scenariosResponse.json();
    check(
      scenarios.map((scenario) => scenario.id).join(",") === "incident,support,fraud",
      "All three scenarios exposed",
      `Expected incident,support,fraud, received ${scenarios.map((scenario) => scenario.id).join(",")}`,
    );

    const first = await streamRun(baseUrl, requests.incident);
    const firstTypes = first.events.map((event) => event.type);
    check(first.response.status === 200, "Run API", `Expected HTTP 200, received ${first.response.status}`);
    check(
      JSON.stringify(firstTypes) === JSON.stringify(eventOrder),
      "Streaming event order",
      `Expected ${eventOrder.join(" → ")}, received ${firstTypes.join(" → ")}`,
    );
    const result = first.events.at(-1)?.data;
    check(result?.compile?.evaluatedCount === 32_768, "Evaluated 32,768 portfolios", `Expected 32,768 portfolios, received ${result?.compile?.evaluatedCount}`);
    check(result?.comparison?.uncontrolled?.memoriesLoaded === 15, "Uncontrolled Raven received all 15 memories", `Expected 15 uncontrolled memories, received ${result?.comparison?.uncontrolled?.memoriesLoaded}`);
    check(result?.comparison?.governed?.memoriesLoaded === 4, "Governed Raven purchased four memories", `Expected 4 governed memories, received ${result?.comparison?.governed?.memoriesLoaded}`);
    const comparison = result?.comparison;
    check(
      comparison?.sameRuntime && comparison?.sameModel && comparison?.sameTask && comparison?.sameTools && comparison?.sameSettings,
      "Same Raven runtime, model, task, tools, and settings",
      `Expected all A/B invariants true, received ${JSON.stringify({ runtime: comparison?.sameRuntime, model: comparison?.sameModel, task: comparison?.sameTask, tools: comparison?.sameTools, settings: comparison?.sameSettings })}`,
    );
    const uncontrolledUsage = comparison?.uncontrolled?.usage;
    const governedUsage = comparison?.governed?.usage;
    check(
      uncontrolledUsage?.inputTokens > governedUsage?.inputTokens &&
        uncontrolledUsage?.outputTokens > 0 && governedUsage?.outputTokens > 0 &&
        uncontrolledUsage?.totalTokens === uncontrolledUsage?.inputTokens + uncontrolledUsage?.outputTokens &&
        governedUsage?.totalTokens === governedUsage?.inputTokens + governedUsage?.outputTokens,
      "Raven input, output, and total tokens recorded",
      `Invalid A/B usage: ${JSON.stringify({ uncontrolledUsage, governedUsage })}`,
    );
    check(comparison?.requiredFactsPreserved === true, "Required facts preserved", "Governed run did not preserve required facts");
    check(result?.counterfactuals?.length === 3, "Three counterfactuals returned", `Expected 3 counterfactuals, received ${result?.counterfactuals?.length}`);
    const pinned = result.counterfactuals.find((item) => item.role === "pinned");
    const control = result.counterfactuals.find((item) => item.role === "rejected_control");
    check(pinned?.policyPassed === false, "Pinned-policy ablation fails safety", `Pinned ablation unexpectedly passed: ${JSON.stringify(pinned)}`);
    check(control?.outcomeChanged === false, "Rejected-memory control is immaterial", `Rejected control changed outcome: ${JSON.stringify(control)}`);
    check(result?.learning?.written === true && result?.learning?.agentCaseId, "Learning receipt recorded", `Expected learning receipt, received ${JSON.stringify(result?.learning)}`);
    check(result?.ledger?.entryId && ["memory", "disk"].includes(result.ledger.mode), "Local A/B ledger persisted", `Expected local ledger receipt, received ${JSON.stringify(result?.ledger)}`);

    const related = await streamRun(baseUrl, requests.incident);
    const relatedRecall = related.events.find((event) => event.type === "recall.completed")?.data;
    check(
      relatedRecall?.historicalLiftApplied === true && relatedRecall.memories.some((memory) => (memory.historicalOutcomeLift ?? 0) > 0),
      "Historical outcome lift applied on related run",
      `Expected learned lift on the next related run, received ${JSON.stringify(relatedRecall?.historicalLiftApplied)}`,
    );

    const unsafe = await streamRun(baseUrl, {
      ...requests.incident,
      constraints: { ...requests.incident.constraints, maxMemoryTokens: 1 },
    });
    const refusalEvent = unsafe.events.at(-1);
    const refusal = refusalEvent?.data?.refusal;
    check(
      refusalEvent?.type === "compile.refused" && !unsafe.events.some((event) => event.type === "raven.started"),
      "Unsafe budget refused before Raven",
      `Expected pre-Raven compile.refused, received ${unsafe.events.map((event) => event.type).join(",")}`,
    );
    check(
      Number.isInteger(refusal?.minimumSafeBudget) && refusal.minimumSafeBudget > 1 && refusal.minimumSafeMemoryIds?.length > 0,
      "Computed minimum-safe budget",
      `Expected reusable safe floor, received ${JSON.stringify(refusal)}`,
    );
    const recovered = await streamRun(baseUrl, {
      ...requests.incident,
      constraints: { ...requests.incident.constraints, maxMemoryTokens: refusal.minimumSafeBudget },
    });
    check(recovered.events.at(-1)?.type === "run.completed", "Safe-budget recovery succeeds", `Expected recovery completion, received ${recovered.events.at(-1)?.type}`);

    for (const scenarioId of ["support", "fraud"]) {
      const scenarioRun = await streamRun(baseUrl, requests[scenarioId]);
      check(scenarioRun.events.at(-1)?.type === "run.completed", `${scenarioId} scenario completes`, `Expected ${scenarioId} completion, received ${scenarioRun.events.at(-1)?.type}`);
    }

    const invalidResponse = await fetch(`${baseUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...requests.incident, objective: 42 }),
    });
    const invalid = await invalidResponse.json();
    check(invalidResponse.status === 400 && typeof invalid.error === "string", "API validation", `Expected JSON 400, received ${invalidResponse.status} ${JSON.stringify(invalid)}`);

    for (const label of passes) console.log(`✓ ${label}`);
    console.log("\nPASS");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
  }
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}\n\nFAIL`);
  process.exitCode = 1;
});
