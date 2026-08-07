import assert from "node:assert/strict";
import test from "node:test";
import { scenarios } from "../shared/catalog.ts";
import type { Scenario } from "../shared/contracts.ts";
import type { MemoryGovernorConstraints } from "../shared/raven-contract.ts";
import { compileMemoryPortfolio, connectMemoryGraph } from "./optimizer.ts";

const incident = scenarios.find((scenario) => scenario.id === "incident")!;
const constraints: MemoryGovernorConstraints = {
  minSuccess: 0.9,
  maxMemoryTokens: 360,
  strategy: "balanced",
};

test("exact search buys the four-memory Raven incident portfolio", () => {
  const result = compileMemoryPortfolio(incident, incident.objective, constraints, incident.memories);

  assert.equal(result.evaluatedCount, 2 ** incident.memories.length);
  assert.equal(result.selected.feasible, true);
  assert.deepEqual(result.selected.memoryIds, [
    "inc-policy-1",
    "inc-episode-1",
    "inc-case-1",
    "inc-profile-2",
  ]);
  assert.equal(result.selected.memoryTokens, 233);
  assert.equal(result.minimumSafeMemoryTokens, 233);
  assert.deepEqual(result.selected.coveredFacts.sort(), [...(incident.requiredFacts ?? [])].sort());
  assert.ok(result.frontier.some((plan) => plan.id === result.selected.id));
  assert.match(result.objectiveFunction, /learned-case lift/);
});

test("strategy changes only memory, never Raven's model or tools", () => {
  const economy = compileMemoryPortfolio(
    incident,
    incident.objective,
    { ...constraints, strategy: "economy" },
    incident.memories,
  );
  const quality = compileMemoryPortfolio(
    incident,
    incident.objective,
    { ...constraints, strategy: "quality" },
    incident.memories,
  );

  assert.equal(economy.selected.modelId, quality.selected.modelId);
  assert.deepEqual(economy.selected.toolIds, quality.selected.toolIds);
  assert.equal(economy.selected.memoryTokens, 233);
  assert.ok(quality.selected.memoryTokens > economy.selected.memoryTokens);
  assert.ok(quality.selected.successProbability > economy.selected.successProbability);
  assert.ok(quality.selected.memoryIds.includes("inc-event-2"));
});

test("the relationship graph exposes duplicates, contradictions, dependencies, and complements", () => {
  const relationships = connectMemoryGraph(incident.memories);
  const types = new Set(relationships.map((relationship) => relationship.type));

  assert.deepEqual([...types].sort(), ["complements", "contradicts", "depends_on", "duplicate"]);
  assert.ok(relationships.some((edge) =>
    edge.type === "contradicts" &&
    [edge.sourceId, edge.targetId].includes("inc-runbook-old"),
  ));
});

test("memory decisions explain pinned, duplicate, contradictory, and irrelevant bids", () => {
  const result = compileMemoryPortfolio(incident, incident.objective, constraints, incident.memories);
  const decisions = new Map(result.memories.map((memory) => [memory.id, memory.decisionCode]));

  assert.equal(decisions.get("inc-policy-1"), "pinned");
  assert.equal(decisions.get("inc-episode-dup"), "redundant");
  assert.equal(decisions.get("inc-runbook-old"), "contradiction");
  assert.equal(decisions.get("inc-event-6"), "irrelevant");
  assert.ok((result.memories.find((memory) => memory.id === "inc-case-1")?.utilityPer1k ?? 0) > 0);
});

test("successful historical cases raise the bid for memories that worked", () => {
  const learnedMemories = incident.memories.map((memory) =>
    memory.id === "inc-case-1"
      ? { ...memory, historicalOutcomeLift: 0.08, learnedCaseId: "prior-run-1" }
      : memory,
  );
  const result = compileMemoryPortfolio(incident, incident.objective, constraints, learnedMemories);
  const learned = result.memories.find((memory) => memory.id === "inc-case-1")!;

  assert.equal(learned.selected, true);
  assert.equal(learned.decisionCode, "learned_case");
  assert.equal(learned.learnedCaseId, "prior-run-1");
});

test("an unsafe budget is refused with a computed minimum safe budget", () => {
  const result = compileMemoryPortfolio(
    incident,
    incident.objective,
    { ...constraints, maxMemoryTokens: 200 },
    incident.memories,
  );

  assert.equal(result.selected.feasible, false);
  assert.equal(result.feasibleCount, 0);
  assert.equal(result.minimumSafeMemoryTokens, 233);
  assert.ok(result.minimumSafeMemoryTokens > 200);
});

test("a dependency can only be selected with its target memory", () => {
  const dependencyScenario: Scenario = {
    id: "dependency-test",
    name: "Dependency test",
    tag: "TEST-1",
    objective: "Choose the safe diagnostic context.",
    valueAtRisk: 1,
    policy: "Use supported evidence.",
    requiredFacts: [],
    tools: [],
    demoAnswer: "A sufficiently complete deterministic answer for evaluation and testing purposes that obeys policy.",
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
  const result = compileMemoryPortfolio(
    dependencyScenario,
    dependencyScenario.objective,
    { ...constraints, minSuccess: 0.8, strategy: "quality" },
    dependencyScenario.memories,
  );

  assert.ok(result.selected.memoryIds.includes("evidence"));
  assert.ok(result.selected.memoryIds.includes("source"));
  assert.equal(result.selected.blockers.includes("memory dependency"), false);
});
