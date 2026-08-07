import { modelCatalog } from "../shared/catalog.ts";
import type {
  CompileResult,
  CounterfactualPlan,
  MemoryCandidate,
  MemoryRelationship,
  ModelOption,
  PlanCandidate,
  RunConstraints,
  Scenario,
  ToolOption,
} from "../shared/contracts.ts";

const AI_CREDIT_USD = 2;
const PROMPT_OVERHEAD_TOKENS = 420;

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

function powerSet<T>(items: T[]): T[][] {
  const sets: T[][] = [];
  const combinations = 1 << items.length;

  for (let mask = 0; mask < combinations; mask += 1) {
    const selection: T[] = [];
    for (let index = 0; index < items.length; index += 1) {
      if (mask & (1 << index)) selection.push(items[index]);
    }
    sets.push(selection);
  }

  return sets;
}

function flattenRelationships(memories: MemoryCandidate[]): MemoryRelationship[] {
  return memories.flatMap((memory) =>
    (memory.relationships ?? []).map((relationship) => ({
      sourceId: memory.id,
      ...relationship,
    })),
  );
}

function candidateScore(
  successProbability: number,
  cost: number,
  memoryTokens: number,
  constraints: RunConstraints,
) {
  const costHeadroom = clamp(1 - cost / constraints.maxCost, 0, 1);
  const tokenHeadroom = clamp(1 - memoryTokens / constraints.maxMemoryTokens, 0, 1);

  if (constraints.strategy === "economy") {
    return successProbability * 0.42 + tokenHeadroom * 0.38 + costHeadroom * 0.2;
  }

  if (constraints.strategy === "quality") {
    return successProbability * 0.91 + tokenHeadroom * 0.06 + costHeadroom * 0.03;
  }

  return successProbability * 0.7 + tokenHeadroom * 0.2 + costHeadroom * 0.1;
}

function buildCandidate(
  model: ModelOption,
  memories: MemoryCandidate[],
  fixedTools: ToolOption[],
  relationships: MemoryRelationship[],
  objective: string,
  constraints: RunConstraints,
  requiredFacts: string[],
  criticalMemoryIds: Set<string>,
  id: string,
): PlanCandidate {
  const selectedIds = new Set(memories.map((memory) => memory.id));
  const memoryTokens = memories.reduce((sum, memory) => sum + memory.tokens, 0);
  const inputTokens =
    PROMPT_OVERHEAD_TOKENS + estimateTokens(objective) + memoryTokens + fixedTools.length * 34;
  const outputTokens = model.expectedOutputTokens;
  const estimatedCost =
    ((inputTokens * model.inputCreditsPerMillion +
      outputTokens * model.outputCreditsPerMillion) /
      1_000_000) *
    AI_CREDIT_USD;

  const coveredFacts = [
    ...new Set(memories.flatMap((memory) => memory.requiredFacts ?? [])),
  ];
  const weightedMemoryLift = memories.reduce(
    (sum, memory) =>
      sum +
      memory.successLift *
        memory.relevance *
        memory.confidence *
        (0.65 + (memory.recency ?? 0.7) * 0.35),
    0,
  );

  let redundancyPenalty = 0;
  let relationshipLift = 0;
  const missingDependencies: string[] = [];

  for (const edge of relationships) {
    const sourceSelected = selectedIds.has(edge.sourceId);
    const targetSelected = selectedIds.has(edge.targetId);
    if (!sourceSelected) continue;

    if (edge.type === "duplicate" && targetSelected) redundancyPenalty += 0.018 * edge.strength;
    if (edge.type === "contradicts" && targetSelected) redundancyPenalty += 0.055 * edge.strength;
    if (edge.type === "complements" && targetSelected) relationshipLift += 0.009 * edge.strength;
    if (edge.type === "depends_on" && !targetSelected) missingDependencies.push(edge.targetId);
  }

  const toolLift = fixedTools.reduce((sum, tool) => sum + tool.successLift, 0);
  const memoryGain = (1 - Math.exp(-weightedMemoryLift * 1.55)) * 0.13;
  const fixedToolGain = (1 - Math.exp(-toolLift * 4)) * 0.035;
  const successProbability = clamp(
    model.reliability + memoryGain + fixedToolGain + relationshipLift - redundancyPenalty,
    0.05,
    0.985,
  );
  const latencyMs =
    model.latencyMs +
    (fixedTools.length ? Math.max(...fixedTools.map((tool) => tool.latencyMs)) : 0) +
    memories.length * 6;

  const blockers: string[] = [];
  const missingCritical = [...criticalMemoryIds].filter((id) => !selectedIds.has(id));
  const missingFacts = requiredFacts.filter((fact) => !coveredFacts.includes(fact));

  if (estimatedCost > constraints.maxCost) blockers.push("cost ceiling");
  if (memoryTokens > constraints.maxMemoryTokens) blockers.push("memory token budget");
  if (latencyMs > constraints.maxLatencyMs) blockers.push("latency SLA");
  if (successProbability < constraints.minSuccess) blockers.push("quality floor");
  if (!model.regions.includes(constraints.region)) blockers.push("region policy");
  if (missingCritical.length) blockers.push("memory policy");
  if (missingFacts.length) blockers.push("required fact coverage");
  if (missingDependencies.length) blockers.push("memory dependency");

  return {
    id,
    modelId: model.id,
    modelName: model.shortName,
    memoryIds: memories.map((memory) => memory.id),
    toolIds: fixedTools.map((tool) => tool.id),
    estimatedCost,
    successProbability,
    latencyMs,
    inputTokens,
    outputTokens,
    memoryTokens,
    coveredFacts,
    redundancyPenalty,
    score: candidateScore(successProbability, estimatedCost, memoryTokens, constraints),
    feasible: blockers.length === 0,
    blockers,
  };
}

function paretoFrontier(candidates: PlanCandidate[]) {
  const sorted = [...candidates].sort(
    (a, b) => a.estimatedCost - b.estimatedCost || b.successProbability - a.successProbability,
  );
  const frontier: PlanCandidate[] = [];

  for (const candidate of sorted) {
    const dominated = frontier.some(
      (other) =>
        other.successProbability >= candidate.successProbability &&
        other.latencyMs <= candidate.latencyMs &&
        other.memoryTokens <= candidate.memoryTokens,
    );
    if (dominated) continue;

    for (let index = frontier.length - 1; index >= 0; index -= 1) {
      const other = frontier[index];
      if (
        candidate.successProbability >= other.successProbability &&
        candidate.latencyMs <= other.latencyMs &&
        candidate.memoryTokens <= other.memoryTokens
      ) {
        frontier.splice(index, 1);
      }
    }
    frontier.push(candidate);
  }

  return frontier.sort((a, b) => a.memoryTokens - b.memoryTokens);
}

function thinFrontier(frontier: PlanCandidate[], selectedId: string) {
  if (frontier.length <= 22) return frontier;
  const stride = Math.ceil(frontier.length / 20);
  const thinned = frontier.filter((_, index) => index % stride === 0).slice(0, 20);
  const selected = frontier.find((candidate) => candidate.id === selectedId);
  if (selected && !thinned.some((candidate) => candidate.id === selected.id)) thinned.push(selected);
  return thinned.sort((a, b) => a.memoryTokens - b.memoryTokens);
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
  const chosen: Array<{ memory: MemoryCandidate; role: CounterfactualPlan["role"]; source: PlanCandidate }> = [];
  const pinned = selectedMemories.find((memory) => memory.policyCritical);
  const causal = selectedMemories
    .filter((memory) => !memory.policyCritical)
    .sort((a, b) => b.successLift * b.relevance - a.successLift * a.relevance)[0];
  const rejected = rejectedMemories
    .filter((memory) => memory.relevance < 0.4)
    .sort((a, b) => a.relevance - b.relevance)[0] ?? rejectedMemories.at(-1);

  if (pinned) chosen.push({ memory: pinned, role: "pinned", source: selected });
  if (causal) chosen.push({ memory: causal, role: "selected", source: selected });
  if (rejected) chosen.push({ memory: rejected, role: "rejected_control", source: baseline });

  return chosen.flatMap(({ memory, role, source }, index) => {
    const ablatedIds = source.memoryIds.filter((id) => id !== memory.id);
    const plan = candidatesByMemorySet.get(memorySetKey(ablatedIds));
    if (!plan) return [];
    const expectedQualityDelta = source.successProbability - plan.successProbability;
    return [{
      id: `ablation-${index + 1}`,
      memoryId: memory.id,
      memoryContent: memory.content,
      role,
      plan,
      expectedQualityDelta,
      expectedPolicyPassed: !plan.blockers.includes("memory policy"),
      expectedRequiredFactsPreserved: !plan.blockers.includes("required fact coverage"),
    }];
  });
}

export function compileExecutionPlan(
  scenario: Scenario,
  objective: string,
  constraints: RunConstraints,
  retrievedMemories: MemoryCandidate[],
): CompileResult {
  const model = modelCatalog[1];
  const fixedTools = scenario.tools.filter((tool) => tool.required);
  const relationships = flattenRelationships(retrievedMemories);
  const requiredFacts = scenario.requiredFacts ?? [];
  const criticalMemoryIds = new Set(
    retrievedMemories.filter((memory) => memory.policyCritical).map((memory) => memory.id),
  );
  const memorySets = powerSet(retrievedMemories);
  const candidates = memorySets.map((memories, index) =>
    buildCandidate(
      model,
      memories,
      fixedTools,
      relationships,
      objective,
      constraints,
      requiredFacts,
      criticalMemoryIds,
      `portfolio-${index + 1}`,
    ),
  );
  const candidatesByMemorySet = new Map(
    candidates.map((candidate) => [memorySetKey(candidate.memoryIds), candidate]),
  );

  const feasible = candidates.filter((candidate) => candidate.feasible);
  const rankedPool = feasible.length
    ? feasible
    : [...candidates].sort(
        (a, b) => a.blockers.length - b.blockers.length || b.score - a.score,
      );
  const selected = [...rankedPool].sort(
    (a, b) => b.score - a.score || a.memoryTokens - b.memoryTokens,
  )[0];
  const baseline = buildCandidate(
    model,
    retrievedMemories,
    fixedTools,
    relationships,
    objective,
    {
      ...constraints,
      maxCost: Number.POSITIVE_INFINITY,
      maxMemoryTokens: Number.POSITIVE_INFINITY,
      maxLatencyMs: Number.POSITIVE_INFINITY,
      minSuccess: 0,
    },
    requiredFacts,
    criticalMemoryIds,
    "baseline-full-memory",
  );
  const rawFrontier = paretoFrontier(feasible);
  const frontier = thinFrontier(rawFrontier, selected.id);
  const safetyEligible = candidates.filter((candidate) =>
    candidate.blockers.every((blocker) => blocker === "cost ceiling" || blocker === "memory token budget"),
  );
  const minimumSafe = [...safetyEligible].sort(
    (a, b) => a.memoryTokens - b.memoryTokens || a.estimatedCost - b.estimatedCost,
  )[0] ?? selected;

  const alternatives = [
    [...feasible].sort((a, b) => a.memoryTokens - b.memoryTokens)[0],
    [...feasible].sort((a, b) => b.successProbability - a.successProbability)[0],
    baseline,
  ].filter((candidate, index, list): candidate is PlanCandidate =>
    Boolean(candidate) && list.findIndex((item) => item?.id === candidate.id) === index,
  );

  const selectedIds = new Set(selected.memoryIds);
  const memories = retrievedMemories.map((memory) => {
    const isSelected = selectedIds.has(memory.id);
    const comparisonIds = isSelected
      ? selected.memoryIds.filter((id) => id !== memory.id)
      : [...selected.memoryIds, memory.id];
    const comparisonPlan = candidatesByMemorySet.get(memorySetKey(comparisonIds));
    const marginalQuality = comparisonPlan
      ? isSelected
        ? selected.successProbability - comparisonPlan.successProbability
        : comparisonPlan.successProbability - selected.successProbability
      : 0;
    const utilityPer1k = (marginalQuality * 1000) / memory.tokens;
    const selectedDuplicate = relationships.find(
      (edge) =>
        edge.sourceId === memory.id && edge.type === "duplicate" && selectedIds.has(edge.targetId),
    );
    const selectedContradiction = relationships.find(
      (edge) =>
        edge.sourceId === memory.id && edge.type === "contradicts" && selectedIds.has(edge.targetId),
    );

    let decision = "Rejected: lower marginal value than the purchased context.";
    let decisionCode: MemoryCandidate["decisionCode"] = "low_value";
    if (isSelected && memory.policyCritical) {
      decision = "Pinned: required safety policy and cannot be auctioned away.";
      decisionCode = "pinned";
    } else if (isSelected) {
      decision = `Purchased: ${utilityPer1k.toFixed(2)} utility points per 1K tokens.`;
      decisionCode = "selected";
    } else if (selectedContradiction) {
      decision = "Rejected: contradicts a pinned policy in the selected context.";
      decisionCode = "contradiction";
    } else if (selectedDuplicate) {
      decision = "Rejected: duplicates a higher-confidence selected memory.";
      decisionCode = "redundant";
    } else if (memory.relevance < 0.4) {
      decision = "Rejected: irrelevant to the current task.";
      decisionCode = "irrelevant";
    }

    return { ...memory, selected: isSelected, utilityPer1k, decision, decisionCode };
  });

  return {
    selected,
    baseline,
    alternatives,
    frontier,
    memories,
    evaluatedCount: candidates.length,
    feasibleCount: feasible.length,
    dominatedCount: Math.max(0, feasible.length - rawFrontier.length),
    objectiveFunction:
      "maximize marginal outcome utility per memory token, subject to policy, fact coverage, dependency, quality, region, latency, and budget constraints",
    relationshipEdges: relationships,
    minimumSafeCost: minimumSafe.estimatedCost,
    minimumSafeMemoryTokens: minimumSafe.memoryTokens,
    counterfactualPlans: buildCounterfactualPlans(
      candidatesByMemorySet,
      selected,
      baseline,
      retrievedMemories,
    ),
  };
}
