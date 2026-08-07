import assert from "node:assert/strict";
import test from "node:test";
import { scenarios } from "../shared/catalog.ts";
import { buildExecutionContract, buildRavenPrompt } from "../server/raven.ts";
import { compileMemoryPortfolio } from "../server/optimizer.ts";

const incident = scenarios.find((scenario) => scenario.id === "incident")!;
const normal = { minSuccess: 0.9, maxMemoryTokens: 360, strategy: "balanced" as const };

test("incident exact search produces the normal four-memory governed portfolio", () => {
  const compile = compileMemoryPortfolio(incident, incident.objective, normal, incident.memories);
  assert.equal(compile.evaluatedCount, 32_768);
  assert.equal(compile.baseline.memoryIds.length, 15);
  assert.equal(compile.selected.memoryIds.length, 4);
  assert.equal(compile.selected.feasible, true);
  assert.ok(compile.selected.memoryTokens < compile.baseline.memoryTokens);
});

test("economy, balanced, and quality change memory only", () => {
  const results = (["economy", "balanced", "quality"] as const).map((strategy) =>
    compileMemoryPortfolio(
      incident,
      incident.objective,
      { minSuccess: 0.9, maxMemoryTokens: 500, strategy },
      incident.memories,
    ),
  );
  assert.ok(results[0].selected.memoryTokens < results[1].selected.memoryTokens);
  assert.ok(results[1].selected.memoryTokens < results[2].selected.memoryTokens);
  assert.deepEqual(new Set(results.map((result) => result.selected.modelId)).size, 1);
  assert.deepEqual(results.map((result) => result.selected.toolIds), [
    results[0].selected.toolIds,
    results[0].selected.toolIds,
    results[0].selected.toolIds,
  ]);
});

test("auction decisions expose every governed relationship and rejection reason", () => {
  const compile = compileMemoryPortfolio(incident, incident.objective, normal, incident.memories);
  const codes = new Set(compile.memories.map((memory) => memory.decisionCode));
  for (const code of [
    "pinned",
    "complement",
    "dependency",
    "redundant",
    "contradiction",
    "stale",
    "irrelevant",
    "low_value",
  ]) {
    assert.ok(codes.has(code as never), `missing decision code ${code}`);
  }
  assert.deepEqual(
    new Set(compile.relationshipEdges.map((edge) => edge.type)),
    new Set(["duplicate", "contradicts", "depends_on", "complements"]),
  );
});

test("uncontrolled and governed prompts preserve one Raven execution contract", () => {
  const compile = compileMemoryPortfolio(incident, incident.objective, normal, incident.memories);
  const contract = buildExecutionContract(incident, incident.objective);
  const uncontrolled = buildRavenPrompt(
    incident,
    incident.objective,
    compile.baseline,
    incident.memories,
    contract,
  );
  const governed = buildRavenPrompt(
    incident,
    incident.objective,
    compile.selected,
    incident.memories,
    contract,
  );
  assert.match(uncontrolled, new RegExp(contract.taskFingerprint));
  assert.match(governed, new RegExp(contract.taskFingerprint));
  assert.ok(uncontrolled.includes("documentation search index"));
  assert.ok(!governed.includes("documentation search index"));
  assert.deepEqual(contract.tools, incident.tools.map((tool) => tool.id).sort());
});

test("unsafe budget exposes a directly reusable computed floor", () => {
  const refused = compileMemoryPortfolio(
    incident,
    incident.objective,
    { ...normal, maxMemoryTokens: 1 },
    incident.memories,
  );
  assert.equal(refused.selected.feasible, false);
  assert.ok(refused.minimumSafeMemoryTokens > 1);
  assert.ok(refused.minimumSafeMemoryIds.length > 0);
  const recovered = compileMemoryPortfolio(
    incident,
    incident.objective,
    { ...normal, maxMemoryTokens: refused.minimumSafeMemoryTokens },
    incident.memories,
  );
  assert.equal(recovered.selected.feasible, true);
});

test("all three scenarios have a safe deterministic portfolio", () => {
  for (const scenario of scenarios) {
    const minSuccess = scenario.id === "incident" ? 0.9 : 0.88;
    const compile = compileMemoryPortfolio(
      scenario,
      scenario.objective,
      { minSuccess, maxMemoryTokens: 500, strategy: "balanced" },
      scenario.memories,
    );
    assert.equal(compile.selected.feasible, true, scenario.id);
    assert.equal(compile.evaluatedCount, 2 ** scenario.memories.length, scenario.id);
  }
});
