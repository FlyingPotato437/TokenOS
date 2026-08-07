import "dotenv/config";
import express from "express";
import { pathToFileURL } from "node:url";
import { scenarios } from "../shared/catalog.ts";
import type { CounterfactualResult, Evaluation, Scenario } from "../shared/contracts.ts";
import type {
  LearningReceipt,
  RavenComparison,
  RavenExecutionVariant,
  RavenRunEvent,
  RavenRunRequest,
  RavenRunResult,
  SafeBudgetRefusal,
} from "../shared/raven-contract.ts";
import { evaluateRavenRun } from "./evaluator.ts";
import { retrieveEverOSMemories, writeRavenCaseToEverOS } from "./everos.ts";
import { persistLocalRun, readLearnedMemorySignals } from "./ledger.ts";
import { compileMemoryPortfolio, connectMemoryGraph } from "./optimizer.ts";
import {
  buildExecutionContract,
  executeRaven,
  getRavenProviderStatus,
} from "./raven.ts";

export const app = express();
const port = Number(process.env.PORT ?? 8787);
export const recentRuns: RavenRunResult[] = [];

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", async (_request, response) => {
  response.json({
    ok: true,
    service: "tokenos-raven-memory-governor",
    providers: await getRavenProviderStatus(),
  });
});

app.get("/api/scenarios", (_request, response) => {
  response.json(
    scenarios.map(({ id, name, tag, objective, policy, tools }) => ({
      id,
      name,
      tag,
      objective,
      policy,
      tools,
    })),
  );
});

app.get("/api/runs", (_request, response) => {
  response.json(recentRuns);
});

function validRunRequest(body: unknown): body is RavenRunRequest {
  if (!body || typeof body !== "object") return false;
  const candidate = body as Partial<RavenRunRequest>;
  const constraints = candidate.constraints;
  return Boolean(
    typeof candidate.scenarioId === "string" && candidate.scenarioId.trim() &&
    typeof candidate.objective === "string" && candidate.objective.trim() &&
    constraints &&
    Number.isFinite(constraints.maxMemoryTokens) &&
    constraints.maxMemoryTokens > 0 &&
    Number.isFinite(constraints.minSuccess) &&
    constraints.minSuccess >= 0 &&
    constraints.minSuccess <= 1 &&
    ["economy", "balanced", "quality"].includes(String(constraints.strategy)),
  );
}

function reduction(governed: number, uncontrolled: number) {
  return uncontrolled > 0 ? Math.max(0, 1 - governed / uncontrolled) : 0;
}

function requiredFactsPreserved(evaluation: Evaluation) {
  return evaluation.checks
    .filter((check) => check.label === "Required facts" || check.label === "Pinned policies")
    .every((check) => check.passed);
}

function executionVariant(
  kind: RavenExecutionVariant["kind"],
  answer: string,
  memoryIds: string[],
  memoryTokens: number,
  usage: RavenExecutionVariant["usage"],
  evaluation: Evaluation,
  executionContract: RavenExecutionVariant["executionContract"],
): RavenExecutionVariant {
  return {
    kind,
    answer,
    memoryIds,
    memoriesLoaded: memoryIds.length,
    memoryTokens,
    usage,
    evaluation,
    executionContract,
  };
}

function counterfactualEvidence(
  scenario: Scenario,
  compile: ReturnType<typeof compileMemoryPortfolio>,
  mode: RavenComparison["measurementMode"],
): CounterfactualResult[] {
  return compile.counterfactualPlans.map((counterfactual) => {
    const evaluation = evaluateRavenRun(
      scenario,
      scenario.demoAnswer,
      compile,
      counterfactual.plan,
    );
    const policyPassed = evaluation.checks
      .filter((check) => check.label === "Pinned policies" || check.label === "Policy result")
      .every((check) => check.passed);
    const factsPreserved = requiredFactsPreserved(evaluation);
    return {
      memoryId: counterfactual.memoryId,
      memoryContent: counterfactual.memoryContent,
      role: counterfactual.role,
      inputTokens: counterfactual.plan.inputTokens,
      qualityDelta: counterfactual.expectedQualityDelta,
      policyPassed,
      requiredFactsPreserved: factsPreserved,
      outcomeChanged:
        !policyPassed ||
        !factsPreserved ||
        Math.abs(counterfactual.expectedQualityDelta) >= 0.015,
      mode,
      detail: counterfactual.role === "pinned"
        ? "Ablation fails the pinned-policy or required-fact gate before Raven executes."
        : counterfactual.role === "selected"
          ? `Removing this memory lowers expected outcome quality by ${(counterfactual.expectedQualityDelta * 100).toFixed(1)} points.`
          : "This rejected control does not materially change the compiled outcome.",
    };
  });
}

function buildLesson(scenario: Scenario, selectedMemoryIds: string[]) {
  if (scenario.id === "incident") {
    return "For checkout-latency incidents, the restart policy, connection-pool history, diagnostic query, and operator communication preference were sufficient.";
  }
  return `For ${scenario.name.toLowerCase()}, the memory portfolio ${selectedMemoryIds.join(", ")} was sufficient while preserving every required fact and policy.`;
}

app.post("/api/run", async (request, response) => {
  if (!validRunRequest(request.body)) {
    response.status(400).json({
      error: "A scenario, objective, token budget, quality floor, and strategy are required.",
    });
    return;
  }

  const input = request.body;
  const scenario = scenarios.find((item) => item.id === input.scenarioId);
  if (!scenario) {
    response.status(404).json({ error: "Scenario not found." });
    return;
  }

  response.status(200);
  response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();

  const runId = `tok_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const createdAt = new Date().toISOString();
  const initialProviders = await getRavenProviderStatus();
  const demoPace = initialProviders.everos === "replay" && initialProviders.raven === "replay";
  const pause = (milliseconds = 110) =>
    new Promise((resolve) => setTimeout(resolve, demoPace ? milliseconds : 15));
  const send = (event: RavenRunEvent) => {
    if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`);
  };

  try {
    const contract = buildExecutionContract(scenario, input.objective);
    send({
      type: "run.started",
      phase: "init",
      progress: 0.03,
      message: `Run ${runId} accepted. Raven's model, task, tools, and generation settings are locked.`,
      data: { runId, providers: initialProviders, executionContract: contract },
    });
    await pause();

    send({
      type: "recall.started",
      phase: "recall",
      progress: 0.09,
      message: "Recalling user profiles and episodes plus Raven agent cases and skills from EverOS.",
    });
    const learnedSignals = await readLearnedMemorySignals(scenario.id);
    const retrieval = await retrieveEverOSMemories(scenario, input.objective, learnedSignals);
    send({
      type: "recall.completed",
      phase: "recall",
      progress: 0.2,
      message: `${retrieval.memories.length} EverOS candidates recalled. ${retrieval.detail}`,
      data: {
        memories: retrieval.memories,
        mode: retrieval.mode,
        historicalLiftApplied: retrieval.historicalLiftApplied,
      },
    });
    await pause();

    const totalCandidateTokens = retrieval.memories.reduce((sum, memory) => sum + memory.tokens, 0);
    send({
      type: "price.completed",
      phase: "price",
      progress: 0.29,
      message: `${totalCandidateTokens.toLocaleString()} total memory tokens priced against a ${input.constraints.maxMemoryTokens.toLocaleString()}-token budget.`,
      data: {
        totalCandidateTokens,
        budget: input.constraints.maxMemoryTokens,
        candidates: retrieval.memories.map(({ id, tokens, successLift, historicalOutcomeLift }) => ({
          id,
          tokens,
          successLift,
          historicalOutcomeLift: historicalOutcomeLift ?? 0,
        })),
      },
    });
    await pause();

    const relationshipGraph = connectMemoryGraph(retrieval.memories);
    send({
      type: "connect.completed",
      phase: "connect",
      progress: 0.38,
      message: `${relationshipGraph.length} duplicate, contradiction, dependency, and complement edges connected.`,
      data: { relationshipEdges: relationshipGraph },
    });
    await pause();

    send({
      type: "compile.started",
      phase: "compile",
      progress: 0.44,
      message: "Running an exact constrained search across every candidate memory portfolio.",
    });
    const compile = compileMemoryPortfolio(
      scenario,
      input.objective,
      input.constraints,
      retrieval.memories,
    );
    if (!compile.selected.feasible) {
      const refusal: SafeBudgetRefusal = {
        kind: "safe_budget_refusal",
        runId,
        scenarioId: scenario.id,
        objective: input.objective,
        requestedBudget: input.constraints.maxMemoryTokens,
        minimumSafeBudget: compile.minimumSafeMemoryTokens,
        minimumSafeMemoryIds: compile.minimumSafeMemoryIds,
        missingPolicyMemoryIds: compile.memories
          .filter((memory) => memory.policyCritical && !compile.selected.memoryIds.includes(memory.id))
          .map((memory) => memory.id),
        missingRequiredFacts: (scenario.requiredFacts ?? []).filter(
          (fact) => !compile.selected.coveredFacts.includes(fact),
        ),
        message: `No safe context can be compiled under this budget. Minimum safe budget: ${compile.minimumSafeMemoryTokens} tokens.`,
        createdAt,
      };
      send({
        type: "compile.refused",
        phase: "compile",
        progress: 1,
        message: refusal.message,
        data: { refusal, compile },
      });
      response.end();
      return;
    }

    send({
      type: "compile.completed",
      phase: "compile",
      progress: 0.56,
      message: `${compile.evaluatedCount.toLocaleString()} portfolios evaluated; ${compile.selected.memoryIds.length} memories purchased for Raven.`,
      data: compile,
    });
    await pause();

    send({
      type: "raven.started",
      phase: "execute",
      progress: 0.62,
      message: "Running uncontrolled and governed Raven turns with the same task, model, tools, and generation settings.",
      data: { executionContract: contract },
    });
    const uncontrolled = await executeRaven({
      runId,
      kind: "uncontrolled",
      scenario,
      objective: input.objective,
      plan: compile.baseline,
      memories: retrieval.memories,
      contract,
    });
    const governed = await executeRaven({
      runId,
      kind: "governed",
      scenario,
      objective: input.objective,
      plan: compile.selected,
      memories: retrieval.memories,
      contract,
    });
    if (uncontrolled.mode !== governed.mode || uncontrolled.model !== governed.model) {
      throw new Error("Controlled Raven A/B execution did not preserve one runtime and model.");
    }

    const uncontrolledEvaluation = evaluateRavenRun(
      scenario,
      uncontrolled.answer,
      compile,
      compile.baseline,
    );
    const governedEvaluation = evaluateRavenRun(
      scenario,
      governed.answer,
      compile,
      compile.selected,
    );
    const uncontrolledVariant = executionVariant(
      "uncontrolled",
      uncontrolled.answer,
      compile.baseline.memoryIds,
      compile.baseline.memoryTokens,
      uncontrolled.usage,
      uncontrolledEvaluation,
      contract,
    );
    const governedVariant = executionVariant(
      "governed",
      governed.answer,
      compile.selected.memoryIds,
      compile.selected.memoryTokens,
      governed.usage,
      governedEvaluation,
      contract,
    );
    send({
      type: "uncontrolled.completed",
      phase: "execute",
      progress: 0.7,
      message: `Uncontrolled Raven loaded ${uncontrolledVariant.memoriesLoaded} memories and used ${uncontrolled.usage.inputTokens.toLocaleString()} input tokens.`,
      data: uncontrolledVariant,
    });
    send({
      type: "governed.completed",
      phase: "execute",
      progress: 0.79,
      message: `TokenOS governed Raven loaded ${governedVariant.memoriesLoaded} memories and used ${governed.usage.inputTokens.toLocaleString()} input tokens.`,
      data: governedVariant,
    });

    const measurementMode = uncontrolled.mode === "live" && governed.mode === "live"
      ? "live" as const
      : "replay" as const;
    const comparison: RavenComparison = {
      uncontrolled: uncontrolledVariant,
      governed: governedVariant,
      tokenReduction: reduction(governed.usage.inputTokens, uncontrolled.usage.inputTokens),
      memoryTokenReduction: reduction(compile.selected.memoryTokens, compile.baseline.memoryTokens),
      requiredFactsPreserved: requiredFactsPreserved(governedEvaluation),
      sameRuntime:
        uncontrolledVariant.executionContract.runtime === governedVariant.executionContract.runtime,
      sameModel: uncontrolled.model === governed.model,
      sameTask:
        uncontrolledVariant.executionContract.taskFingerprint ===
        governedVariant.executionContract.taskFingerprint,
      sameTools: JSON.stringify(uncontrolled.tools) === JSON.stringify(governed.tools),
      sameSettings:
        JSON.stringify(uncontrolledVariant.executionContract.generationConfig) ===
        JSON.stringify(governedVariant.executionContract.generationConfig),
      executionContract: contract,
      measurementMode,
    };
    send({
      type: "comparison.completed",
      phase: "execute",
      progress: 0.86,
      message: `${(comparison.tokenReduction * 100).toFixed(1)}% fewer Raven input tokens with required facts and runtime controls preserved.`,
      data: comparison,
    });
    await pause();

    const counterfactuals = counterfactualEvidence(scenario, compile, measurementMode);
    const lesson = buildLesson(scenario, compile.selected.memoryIds);
    send({
      type: "learn.started",
      phase: "learn",
      progress: 0.91,
      message: "Recording the successful memory portfolio as a reusable Raven agent case.",
      data: { lesson, counterfactuals },
    });
    const ledger = await persistLocalRun({
      runId,
      createdAt,
      scenarioId: scenario.id,
      objective: input.objective,
      selectedMemoryIds: compile.selected.memoryIds,
      allMemoryIds: compile.baseline.memoryIds,
      selectedMemoryTokens: compile.selected.memoryTokens,
      uncontrolledMemoryTokens: compile.baseline.memoryTokens,
      uncontrolledInputTokens: uncontrolled.usage.inputTokens,
      governedInputTokens: governed.usage.inputTokens,
      tokenReduction: comparison.tokenReduction,
      policyPassed: governedEvaluation.policyPassed,
      requiredFactsPreserved: comparison.requiredFactsPreserved,
      measurementEstimated: uncontrolled.usage.estimated || governed.usage.estimated,
      lesson,
    });
    let learning: LearningReceipt;
    if (governedEvaluation.policyPassed && comparison.requiredFactsPreserved) {
      learning = await writeRavenCaseToEverOS({
        runId,
        objective: input.objective,
        answer: governed.answer,
        lesson,
        selectedMemoryIds: compile.selected.memoryIds,
        historicalLiftApplied: retrieval.historicalLiftApplied,
      });
    } else {
      learning = {
        mode: "local",
        written: false,
        agentCaseId: runId,
        lesson,
        historicalLiftApplied: retrieval.historicalLiftApplied,
        detail: "The run failed its policy or required-fact gate, so it was not promoted into EverOS learning.",
      };
    }
    send({
      type: "learn.completed",
      phase: "learn",
      progress: 0.97,
      message: `${learning.detail} ${ledger.detail}`,
      data: { learning, ledger },
    });

    const result: RavenRunResult = {
      kind: "completed",
      runId,
      scenarioId: scenario.id,
      objective: input.objective,
      answer: governed.answer,
      compile,
      comparison,
      counterfactuals,
      providers: {
        everos: retrieval.mode,
        raven: measurementMode,
        message: `${retrieval.detail} ${governed.detail}`,
      },
      ledger,
      learning,
      createdAt,
    };
    recentRuns.unshift(result);
    recentRuns.splice(10);
    send({
      type: "run.completed",
      phase: "learn",
      progress: 1,
      message: `TokenOS compiled a safe Raven context and learned from run ${runId}.`,
      data: result,
    });
    response.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : "The Raven memory-governor run failed.";
    send({
      type: "run.error",
      phase: "learn",
      progress: 1,
      message,
      data: { runId, error: { message } },
    });
    response.end();
  }
});

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  app.listen(port, "127.0.0.1", () => {
    console.log(`TokenOS Raven memory governor listening on http://127.0.0.1:${port}`);
  });
}
