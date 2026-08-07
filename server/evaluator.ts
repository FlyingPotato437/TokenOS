import type { CompileResult, Evaluation, PlanCandidate, Scenario } from "../shared/contracts.ts";

export function evaluateRun(
  scenario: Scenario,
  answer: string,
  compile: CompileResult,
  region: string,
  plan: PlanCandidate = compile.selected,
): Evaluation {
  const criticalMemoryIds = scenario.memories
    .filter((memory) => memory.policyCritical)
    .map((memory) => memory.id);
  const requiredToolIds = scenario.tools.filter((tool) => tool.required).map((tool) => tool.id);
  const criticalMemoryPassed = criticalMemoryIds.every((id) =>
    plan.memoryIds.includes(id),
  );
  const requiredToolsPassed = requiredToolIds.every((id) =>
    plan.toolIds.includes(id),
  );
  const requiredFactsPassed = (scenario.requiredFacts ?? []).every((fact) =>
    plan.coveredFacts.includes(fact),
  );
  const regionPassed = region === "ANY_REGION" || plan.blockers.includes("region policy") === false;
  const answerPassed = answer.trim().length >= 120;
  const checks = [
    {
      label: "Required facts",
      passed: requiredFactsPassed,
      detail: requiredFactsPassed
        ? `${plan.coveredFacts.length} required facts survived compilation.`
        : "A fact required for the decision was removed.",
    },
    {
      label: "Memory policy",
      passed: criticalMemoryPassed,
      detail: criticalMemoryPassed
        ? `${criticalMemoryIds.length} critical memories survived compilation.`
        : "A critical memory was removed from context.",
    },
    {
      label: "Required tools",
      passed: requiredToolsPassed,
      detail: requiredToolsPassed
        ? `${requiredToolIds.length} required tools were allocated.`
        : "The plan omitted a required tool.",
    },
    {
      label: "Region boundary",
      passed: regionPassed,
      detail: regionPassed ? `Execution is compatible with ${region}.` : "The selected route violates region policy.",
    },
    {
      label: "Answer completeness",
      passed: answerPassed,
      detail: answerPassed ? "The agent returned an actionable response." : "The agent response is incomplete.",
    },
  ];
  const passRatio = checks.filter((check) => check.passed).length / checks.length;

  return {
    score: Math.min(0.99, plan.successProbability * 0.62 + passRatio * 0.38),
    policyPassed: checks.every((check) => check.passed),
    checks,
  };
}
