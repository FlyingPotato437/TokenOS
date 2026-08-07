import assert from "node:assert/strict";
import test from "node:test";
import { scenarios } from "../shared/catalog.ts";
import type { RunConstraints, Scenario } from "../shared/contracts.ts";
import { compileExecutionPlan } from "./optimizer.ts";

const incident = scenarios.find((scenario) => scenario.id === "incident")!;
const constraints: RunConstraints = {
  maxCost: 0.003,
  maxLatencyMs: 1800,
  minSuccess: 0.9,
  maxMemoryTokens: 360,
  strategy: "balanced",
  region: "ANY_REGION",
};

test("exact search buys the minimum safe incident memory portfolio", () => {
  const result = compileExecutionPlan(incident, incident.objective, constraints, incident.memories);

  assert.equal(result.evaluatedCount, 2 ** incident.memories.length);
  assert.equal(result.selected.feasible, true);
  assert.deepEqual(result.selected.memoryIds, ["inc-policy-1", "inc-episode-1", "inc-case-1"]);
  assert.equal(result.selected.memoryTokens, 194);
  assert.equal(result.minimumSafeMemoryTokens, 194);
  assert.deepEqual(result.selected.coveredFacts.sort(), [...(incident.requiredFacts ?? [])].sort());
  assert.ok(result.frontier.some((plan) => plan.id === result.selected.id));
  assert.equal(result.relationshipEdges.some((edge) => edge.type === "depends_on"), true);
});

test("economic strategy changes the purchased context instead of changing the model", () => {
  const economy = compileExecutionPlan(
    incident,
    incident.objective,
    { ...constraints, strategy: "economy" },
    incident.memories,
  );
  const quality = compileExecutionPlan(
    incident,
    incident.objective,
    { ...constraints, strategy: "quality" },
    incident.memories,
  );

  assert.equal(economy.selected.modelId, quality.selected.modelId);
  assert.equal(economy.selected.memoryTokens, 194);
  assert.equal(quality.selected.memoryTokens, 245);
  assert.ok(quality.selected.successProbability > economy.selected.successProbability);
  assert.ok(quality.selected.memoryIds.includes("inc-event-2"));
});

test("memory decisions explain pinned, duplicate, contradictory, and irrelevant bids", () => {
  const result = compileExecutionPlan(incident, incident.objective, constraints, incident.memories);
  const decisions = new Map(result.memories.map((memory) => [memory.id, memory.decisionCode]));

  assert.equal(decisions.get("inc-policy-1"), "pinned");
  assert.equal(decisions.get("inc-episode-dup"), "redundant");
  assert.equal(decisions.get("inc-runbook-old"), "contradiction");
  assert.equal(decisions.get("inc-event-6"), "irrelevant");
  assert.ok((result.memories.find((memory) => memory.id === "inc-episode-1")?.utilityPer1k ?? 0) > 0);
});

test("counterfactual plans distinguish causal memories from a rejected control", () => {
  const result = compileExecutionPlan(incident, incident.objective, constraints, incident.memories);
  const byRole = new Map(result.counterfactualPlans.map((plan) => [plan.role, plan]));

  assert.deepEqual([...byRole.keys()], ["pinned", "selected", "rejected_control"]);
  assert.equal(byRole.get("pinned")?.expectedPolicyPassed, false);
  assert.equal(byRole.get("pinned")?.expectedRequiredFactsPreserved, false);
  assert.ok((byRole.get("selected")?.expectedQualityDelta ?? 0) > 0.015);
  assert.ok(Math.abs(byRole.get("rejected_control")?.expectedQualityDelta ?? 1) < 0.001);
});

test("an unsafe budget is refused and reports the true minimum safe context", () => {
  const result = compileExecutionPlan(
    incident,
    incident.objective,
    { ...constraints, maxMemoryTokens: 160 },
    incident.memories,
  );

  assert.equal(result.selected.feasible, false);
  assert.equal(result.feasibleCount, 0);
  assert.equal(result.minimumSafeMemoryTokens, 194);
  assert.ok(result.minimumSafeCost > 0);
});

test("a dependency can only be purchased with its target memory", () => {
  const dependencyScenario: Scenario = {
    id: "dependency-test",
    name: "Dependency test",
    tag: "TEST-1",
    objective: "Choose the safe diagnostic context.",
    valueAtRisk: 1,
    policy: "Use supported evidence.",
    requiredFacts: [],
    tools: [],
    demoAnswer: "A sufficiently complete deterministic answer for evaluation and testing purposes.",
    memories: [
      {
        id: "evidence",
        content: "A high-value conclusion that depends on its source event.",
        source: "test",
        type: "episode",
        tokens: 40,
        relevance: 0.99,
        confidence: 0.99,
        successLift: 0.3,
        relationships: [{ targetId: "source", type: "depends_on", strength: 1 }],
      },
      {
        id: "source",
        content: "The source event required to support the conclusion.",
        source: "test",
        type: "event",
        tokens: 30,
        relevance: 0.7,
        confidence: 0.95,
        successLift: 0.02,
      },
    ],
  };
  const result = compileExecutionPlan(
    dependencyScenario,
    dependencyScenario.objective,
    { ...constraints, minSuccess: 0.8, strategy: "quality" },
    dependencyScenario.memories,
  );

  assert.ok(result.selected.memoryIds.includes("evidence"));
  assert.ok(result.selected.memoryIds.includes("source"));
  assert.equal(result.selected.blockers.includes("memory dependency"), false);
});
