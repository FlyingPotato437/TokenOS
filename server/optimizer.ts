import type {
  CompileResult,
  CounterfactualPlan,
  MemoryCandidate,
  MemoryRelationship,
  PlanCandidate,
  Scenario,
} from "../shared/contracts.ts";
import type { MemoryGovernorConstraints } from "../shared/raven-contract.ts";

const PROMPT_OVERHEAD_TOKENS = 320;
const RAVEN_MODEL_ID = "raven-configured-model";
const RAVEN_MODEL_NAME = "Raven Agent";

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

function powerSet<T>(items: T[]): T[][] {
  if (items.length > 20) {
    throw new Error("Exact memory compilation is limited to 20 candidates per run.");
  }
  const sets: T[][] = [];
  const combinations = 2 ** items.length;
  for (let mask = 0; mask < combinations; mask += 1) {
    const selection: T[] = [];
    for (let index = 0; index < items.length; index += 1) {
      if (mask & (2 ** index)) selection.push(items[index]);
    }
    sets.push(selection);
  }
  return sets;
}

function terms(text: string) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 4),
  );
}

function overlap(left: Set<string>, right: Set<string>) {
  const shared = [...left].filter((term) => right.has(term)).length;
  const union = new Set([...left, ...right]).size;
  return union ? shared / union : 0;
}

function hasNegativePolicy(text: string) {
  return /\b(no|never|avoid|must not|do not|without (?:explicit )?approval)\b/i.test(text);
}

function sharesControlledAction(left: string, right: string) {
  const actions = ["restart", "freeze", "delete", "migrate", "replay", "deploy", "rollback"];
  return actions.some((action) => left.toLowerCase().includes(action) && right.toLowerCase().includes(action));
}

function edgeKey(edge: MemoryRelationship) {
  return `${edge.sourceId}|${edge.targetId}|${edge.type}`;
}

export function connectMemoryGraph(memories: MemoryCandidate[]): MemoryRelationship[] {
  const edges = memories.flatMap((memory) =>
    (memory.relationships ?? []).map((relationship) => ({ sourceId: memory.id, ...relationship })),
  );
  const known = new Set(edges.map(edgeKey));
  const termSets = new Map(memories.map((memory) => [memory.id, terms(memory.content)]));

  for (let leftIndex = 0; leftIndex < memories.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < memories.length; rightIndex += 1) {
      const left = memories[leftIndex];
      const right = memories[rightIndex];
      const similarity = overlap(termSets.get(left.id)!, termSets.get(right.id)!);
      let inferred: MemoryRelationship | undefined;
      if (
        sharesControlledAction(left.content, right.content) &&
        hasNegativePolicy(left.content) !== hasNegativePolicy(right.content) &&
        similarity >= 0.08
      ) {
        inferred = {
          sourceId: left.id,
          targetId: right.id,
          type: "contradicts",
          strength: clamp(0.72 + similarity, 0.72, 0.98),
        };
      } else if (similarity >= 0.47) {
        inferred = {
          sourceId: left.id,
          targetId: right.id,
          type: "duplicate",
          strength: clamp(similarity + 0.28, 0.7, 0.98),
        };
      } else if (similarity >= 0.24 && left.type !== right.type) {
        inferred = {
          sourceId: left.id,
          targetId: right.id,
          type: "complements",
          strength: clamp(similarity + 0.35, 0.58, 0.9),
        };
      }
      if (inferred && !known.has(edgeKey(inferred))) {
        known.add(edgeKey(inferred));
        edges.push(inferred);
      }
    }
  }
  return edges;
}

function portfolioScore(
  successProbability: number,
  memoryTokens: number,
  selectedCount: number,
  historicalLift: number,
  constraints: MemoryGovernorConstraints,
) {
  const tokenShare = memoryTokens / Math.max(1, constraints.maxMemoryTokens);
  if (constraints.strategy === "economy") {
    return successProbability * 0.56 - tokenShare * 0.34 - selectedCount * 0.003 + historicalLift * 0.08;
  }
  if (constraints.strategy === "quality") {
    return successProbability * 0.98 - tokenShare * 0.012 - selectedCount * 0.0003 + historicalLift * 0.12;
  }
  return successProbability * 0.82 - tokenShare * 0.1 - selectedCount * 0.0008 + historicalLift * 0.1;
}

function buildCandidate(
  memories: MemoryCandidate[],
  allMemories: MemoryCandidate[],
  relationships: MemoryRelationship[],
  scenario: Scenario,
  objective: string,
  constraints: MemoryGovernorConstraints,
  id: string,
): PlanCandidate {
  const selectedIds = new Set(memories.map((memory) => memory.id));
  const criticalIds = new Set(allMemories.filter((memory) => memory.policyCritical).map((memory) => memory.id));
  const memoryTokens = memories.reduce((sum, memory) => sum + memory.tokens, 0);
  const coveredFacts = [...new Set(memories.flatMap((memory) => memory.requiredFacts ?? []))];
  const historicalLift = memories.reduce((sum, memory) => sum + (memory.historicalOutcomeLift ?? 0), 0);
  const weightedLift = memories.reduce((sum, memory) => {
    const recencyWeight = 0.62 + (memory.recency ?? 0.72) * 0.38;
    return sum +
      (memory.successLift + (memory.historicalOutcomeLift ?? 0)) *
        memory.relevance *
        memory.confidence *
        recencyWeight;
  }, 0);
  const distractionPenalty = memories.reduce((sum, memory) => {
    const irrelevance = Math.max(0, 0.42 - memory.relevance) * 0.014;
    const staleness = Math.max(0, 0.3 - (memory.recency ?? 0.7)) * 0.012;
    return sum + irrelevance + staleness;
  }, 0);
  let redundancyPenalty = 0;
  let relationshipLift = 0;
  const missingDependencies: string[] = [];
  const criticalContradictions: string[] = [];

  for (const edge of relationships) {
    const sourceSelected = selectedIds.has(edge.sourceId);
    const targetSelected = selectedIds.has(edge.targetId);
    if (sourceSelected && targetSelected && edge.type === "duplicate") {
      redundancyPenalty += 0.022 * edge.strength;
    }
    if (sourceSelected && targetSelected && edge.type === "contradicts") {
      redundancyPenalty += 0.075 * edge.strength;
      if (criticalIds.has(edge.sourceId) || criticalIds.has(edge.targetId)) {
        criticalContradictions.push(`${edge.sourceId}:${edge.targetId}`);
      }
    }
    if (sourceSelected && targetSelected && edge.type === "complements") {
      relationshipLift += 0.012 * edge.strength;
    }
    if (sourceSelected && !targetSelected && edge.type === "depends_on") {
      missingDependencies.push(edge.targetId);
    }
  }

  const successProbability = clamp(
    0.78 +
      (1 - Math.exp(-weightedLift * 1.7)) * 0.19 +
      relationshipLift -
      redundancyPenalty -
      distractionPenalty,
    0.05,
    0.99,
  );
  const blockers: string[] = [];
  const missingCritical = [...criticalIds].filter((memoryId) => !selectedIds.has(memoryId));
  const missingFacts = (scenario.requiredFacts ?? []).filter((fact) => !coveredFacts.includes(fact));
  if (memoryTokens > constraints.maxMemoryTokens) blockers.push("memory token budget");
  if (successProbability < constraints.minSuccess) blockers.push("quality floor");
  if (missingCritical.length) blockers.push("memory policy");
  if (missingFacts.length) blockers.push("required fact coverage");
  if (missingDependencies.length) blockers.push("memory dependency");
  if (criticalContradictions.length) blockers.push("policy contradiction");

  return {
    id,
    modelId: RAVEN_MODEL_ID,
    modelName: RAVEN_MODEL_NAME,
    memoryIds: memories.map((memory) => memory.id),
    toolIds: scenario.tools.map((tool) => tool.id),
    estimatedCost: 0,
    successProbability,
    latencyMs: 0,
    inputTokens: PROMPT_OVERHEAD_TOKENS + estimateTokens(objective) + memoryTokens,
    outputTokens: 0,
    memoryTokens,
    coveredFacts,
    redundancyPenalty,
    score: portfolioScore(successProbability, memoryTokens, memories.length, historicalLift, constraints),
    feasible: blockers.length === 0,
    blockers,
  };
}

function paretoFrontier(candidates: PlanCandidate[]) {
  const feasible = candidates.filter((candidate) => candidate.feasible);
  return feasible
    .filter((candidate) => !feasible.some((other) =>
      other.id !== candidate.id &&
      other.memoryTokens <= candidate.memoryTokens &&
      other.successProbability >= candidate.successProbability &&
      (other.memoryTokens < candidate.memoryTokens || other.successProbability > candidate.successProbability),
    ))
    .sort((left, right) => left.memoryTokens - right.memoryTokens)
    .slice(0, 24);
}

const memorySetKey = (memoryIds: string[]) => [...memoryIds].sort().join("|");

function buildCounterfactualPlans(
  candidatesByMemorySet: Map<string, PlanCandidate>,
  selected: PlanCandidate,
  baseline: PlanCandidate,
  memories: MemoryCandidate[],
): CounterfactualPlan[] {
  const selectedMemories = memories.filter((memory) => selected.memoryIds.includes(memory.id));
  const rejectedMemories = memories.filter((memory) => !selected.memoryIds.includes(memory.id));
  const pinned = selectedMemories.find((memory) => memory.policyCritical);
  const causal = selectedMemories
    .filter((memory) => !memory.policyCritical)
    .sort((left, right) =>
      (right.successLift + (right.historicalOutcomeLift ?? 0)) * right.relevance -
      (left.successLift + (left.historicalOutcomeLift ?? 0)) * left.relevance,
    )[0];
  const rejected = rejectedMemories
    .filter((memory) => memory.relevance < 0.35)
    .sort((left, right) => left.relevance - right.relevance)[0] ?? rejectedMemories.at(-1);
  const chosen = [
    pinned && { memory: pinned, role: "pinned" as const, source: selected },
    causal && { memory: causal, role: "selected" as const, source: selected },
    rejected && { memory: rejected, role: "rejected_control" as const, source: baseline },
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));

  return chosen.flatMap(({ memory, role, source }, index) => {
    const ablatedIds = source.memoryIds.filter((memoryId) => memoryId !== memory.id);
    const plan = candidatesByMemorySet.get(memorySetKey(ablatedIds));
    if (!plan) return [];
    return [{
      id: `ablation-${index + 1}`,
      memoryId: memory.id,
      memoryContent: memory.content,
      role,
      plan,
      expectedQualityDelta: source.successProbability - plan.successProbability,
      expectedPolicyPassed: !plan.blockers.includes("memory policy") && !plan.blockers.includes("policy contradiction"),
      expectedRequiredFactsPreserved: !plan.blockers.includes("required fact coverage"),
    }];
  });
}

function relationshipWithSelected(
  memoryId: string,
  selectedIds: Set<string>,
  relationships: MemoryRelationship[],
) {
  const connected = relationships.filter((edge) =>
    (edge.sourceId === memoryId && selectedIds.has(edge.targetId)) ||
    (edge.targetId === memoryId && selectedIds.has(edge.sourceId)),
  );
  return connected.find((edge) => edge.sourceId === memoryId && edge.type === "depends_on") ??
    connected.find((edge) => edge.type === "complements") ??
    connected[0];
}

function annotateMemories(
  memories: MemoryCandidate[],
  selected: PlanCandidate,
  relationships: MemoryRelationship[],
) {
  const selectedIds = new Set(selected.memoryIds);
  return memories.map((memory) => {
    const selectedMemory = selectedIds.has(memory.id);
    const relation = relationshipWithSelected(memory.id, selectedIds, relationships);
    const missingDependency = relationships.find((edge) =>
      edge.sourceId === memory.id &&
      edge.type === "depends_on" &&
      !selectedIds.has(edge.targetId),
    );
    const utility =
      ((memory.successLift + (memory.historicalOutcomeLift ?? 0)) *
        memory.relevance *
        memory.confidence *
        1000) /
      Math.max(1, memory.tokens);
    if (selectedMemory) {
      const decisionCode = memory.policyCritical
        ? "pinned" as const
        : (memory.historicalOutcomeLift ?? 0) > 0.04
          ? "learned_case" as const
          : relation?.type === "depends_on"
            ? "dependency" as const
            : relation?.type === "complements"
              ? "complement" as const
              : "selected" as const;
      return {
        ...memory,
        selected: true,
        utilityPer1k: utility,
        decisionCode,
        decision: memory.policyCritical
          ? "Pinned: required safety policy."
          : decisionCode === "learned_case"
            ? "Selected: a successful prior Raven case increased expected outcome value."
            : decisionCode === "dependency"
              ? `Selected with required dependency ${relation?.targetId ?? relation?.sourceId} present.`
              : decisionCode === "complement"
                ? "Selected: complementary memory increases joint outcome value."
            : "Selected: high marginal outcome value per token.",
      };
    }
    const decisionCode = relation?.type === "contradicts"
      ? "contradiction" as const
      : relation?.type === "duplicate"
        ? "redundant" as const
        : missingDependency
          ? "dependency" as const
        : (memory.recency ?? 0.7) < 0.3
          ? "stale" as const
          : memory.relevance < 0.3
            ? "irrelevant" as const
            : "low_value" as const;
    return {
      ...memory,
      selected: false,
      utilityPer1k: utility,
      decisionCode,
      decision: decisionCode === "contradiction"
        ? "Rejected: conflicts with selected safety context."
        : decisionCode === "redundant"
          ? "Rejected: duplicates a higher-value selected memory."
          : decisionCode === "dependency"
            ? `Rejected: depends on ${missingDependency?.targetId}, which was not purchased.`
          : decisionCode === "stale"
            ? "Rejected: stale evidence is dominated by newer context."
            : decisionCode === "irrelevant"
              ? "Rejected: insufficient relevance to this task."
              : "Rejected: marginal value did not justify its token price.",
    };
  });
}

export function compileMemoryPortfolio(
  scenario: Scenario,
  objective: string,
  constraints: MemoryGovernorConstraints,
  retrievedMemories: MemoryCandidate[],
): CompileResult {
  const relationships = connectMemoryGraph(retrievedMemories);
  const memorySets = powerSet(retrievedMemories);
  const candidates = memorySets.map((memories, index) =>
    buildCandidate(
      memories,
      retrievedMemories,
      relationships,
      scenario,
      objective,
      constraints,
      `portfolio-${index + 1}`,
    ),
  );
  const candidatesByMemorySet = new Map(
    candidates.map((candidate) => [memorySetKey(candidate.memoryIds), candidate]),
  );
  const feasible = candidates
    .filter((candidate) => candidate.feasible)
    .sort((left, right) => right.score - left.score || left.memoryTokens - right.memoryTokens);
  const safeIgnoringBudget = candidates
    .filter((candidate) => candidate.blockers.every((blocker) => blocker === "memory token budget"))
    .sort((left, right) => left.memoryTokens - right.memoryTokens || right.successProbability - left.successProbability);
  const minimumSafe = safeIgnoringBudget[0];
  const selected = feasible[0] ?? minimumSafe ?? candidates
    .slice()
    .sort((left, right) => right.successProbability - left.successProbability)[0];
  const baseline = buildCandidate(
    retrievedMemories,
    retrievedMemories,
    relationships,
    scenario,
    objective,
    constraints,
    "uncontrolled-all-memory",
  );
  const frontier = paretoFrontier(candidates);
  const memories = annotateMemories(retrievedMemories, selected, relationships);

  return {
    selected,
    baseline,
    alternatives: feasible.slice(1, 9),
    frontier: frontier.some((candidate) => candidate.id === selected.id)
      ? frontier
      : [...frontier, selected].sort((left, right) => left.memoryTokens - right.memoryTokens),
    memories,
    evaluatedCount: candidates.length,
    feasibleCount: feasible.length,
    dominatedCount: Math.max(0, candidates.length - frontier.length),
    objectiveFunction:
      "Exact constrained memory auction: maximize expected Raven outcome plus learned-case lift minus token price, redundancy, contradiction, staleness, and distraction.",
    relationshipEdges: relationships,
    minimumSafeCost: 0,
    minimumSafeMemoryTokens: minimumSafe?.memoryTokens ?? 0,
    minimumSafeMemoryIds: minimumSafe?.memoryIds ?? [],
    counterfactualPlans: buildCounterfactualPlans(
      candidatesByMemorySet,
      selected,
      baseline,
      retrievedMemories,
    ),
  };
}

// Kept as a compatibility alias while Agent B migrates from the prerequisite contract.
export const compileExecutionPlan = compileMemoryPortfolio;
