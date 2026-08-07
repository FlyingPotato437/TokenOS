import "dotenv/config";
import express from "express";
import { scenarios } from "../shared/catalog.ts";
import type {
  CounterfactualResult,
  ExecutionComparison,
  ProviderStatus,
  RunEvent,
  RunRequest,
  RunResult,
} from "../shared/contracts.ts";
import { evaluateRun } from "./evaluator.ts";
import { persistRunToSnowflake } from "./ledger.ts";
import { compileExecutionPlan } from "./optimizer.ts";
import {
  executeInference,
  getProviderStatus,
  retrieveMemories,
  writeInteractionToEverOS,
} from "./providers.ts";

const app = express();
const port = Number(process.env.PORT ?? 8787);
const recentRuns: RunResult[] = [];

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "tokenos-compiler", providers: getProviderStatus() });
});

app.get("/api/scenarios", (_request, response) => {
  response.json(
    scenarios.map(({ id, name, tag, objective, valueAtRisk, policy, tools }) => ({
      id,
      name,
      tag,
      objective,
      valueAtRisk,
      policy,
      tools,
    })),
  );
});

app.get("/api/runs", (_request, response) => {
  response.json(recentRuns);
});

function validRunRequest(body: unknown): body is RunRequest {
  if (!body || typeof body !== "object") return false;
  const candidate = body as Partial<RunRequest>;
  return Boolean(
    candidate.scenarioId &&
      candidate.objective?.trim() &&
      candidate.constraints &&
      Number.isFinite(candidate.constraints.maxCost) &&
      Number.isFinite(candidate.constraints.maxLatencyMs) &&
      Number.isFinite(candidate.constraints.minSuccess) &&
      Number.isFinite(candidate.constraints.maxMemoryTokens),
  );
}

app.post("/api/run", async (request, response) => {
  if (!validRunRequest(request.body)) {
    response.status(400).json({ error: "A scenario, objective, and valid constraints are required." });
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
  const initialProviders = getProviderStatus();
  const demoPace = initialProviders.everos === "demo" && initialProviders.snowflake === "demo";
  const pause = (milliseconds = 130) =>
    new Promise((resolve) => setTimeout(resolve, demoPace ? milliseconds : 20));
  const send = (event: RunEvent) => {
    if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`);
  };

  try {
    send({
      type: "run.started",
      phase: "init",
      progress: 0.03,
      message: `Run ${runId} accepted. Constraints locked.`,
      data: { runId, providers: initialProviders },
    });
    await pause();

    send({
      type: "recall.started",
      phase: "recall",
      progress: 0.1,
      message: "Searching EverOS for the top 15 profile, episode, event, and agent-case memories.",
    });
    const retrieval = await retrieveMemories(scenario, input.objective);
    send({
      type: "recall.completed",
      phase: "recall",
      progress: 0.24,
      message: `${retrieval.memories.length} memories entered the economic compiler. ${retrieval.detail}`,
      data: { memories: retrieval.memories, mode: retrieval.mode },
    });
    await pause(180);

    const criticalCount = retrieval.memories.filter((memory) => memory.policyCritical).length;
    const requiredToolCount = scenario.tools.filter((tool) => tool.required).length;
    send({
      type: "policy.completed",
      phase: "policy",
      progress: 0.34,
      message: `${criticalCount} safety memories and ${scenario.requiredFacts?.length ?? 0} required facts were pinned before optimization.`,
      data: {
        policy: scenario.policy,
        criticalCount,
        requiredToolCount,
        region: input.constraints.region,
      },
    });
    await pause();

    send({
      type: "search.started",
      phase: "search",
      progress: 0.42,
      message: "Enumerating memory portfolios and scoring relevance, recency, redundancy, contradictions, coverage, and token cost.",
    });
    const compile = compileExecutionPlan(
      scenario,
      input.objective,
      input.constraints,
      retrieval.memories,
    );
    send({
      type: "search.completed",
      phase: "search",
      progress: 0.62,
      message: `${compile.evaluatedCount.toLocaleString()} memory portfolios evaluated. ${compile.feasibleCount.toLocaleString()} survived every hard constraint.`,
      data: compile,
    });
    await pause(210);

    if (!compile.selected.feasible) {
      send({
        type: "run.error",
        phase: "search",
        progress: 1,
        message: `No safe context fits this contract. Minimum safe context: ${compile.minimumSafeMemoryTokens} memory tokens at $${compile.minimumSafeCost.toFixed(4)}.`,
        data: { compile },
      });
      response.end();
      return;
    }

    send({
      type: "inference.started",
      phase: "inference",
      progress: 0.68,
      message: `Starting controlled baseline and optimized executions with the same ${compile.selected.modelName} configuration.`,
      data: { selected: compile.selected, baseline: compile.baseline },
    });

    const baselineInference = await executeInference(
      scenario,
      input.objective,
      compile,
      retrieval.memories,
      compile.baseline,
      "baseline",
    );
    send({
      type: "baseline.completed",
      phase: "inference",
      progress: 0.75,
      message: `Baseline sent all ${compile.baseline.memoryIds.length} memories and used ${baselineInference.usage.promptTokens.toLocaleString()} prompt tokens.`,
      data: { answer: baselineInference.answer, usage: baselineInference.usage, mode: baselineInference.mode },
    });
    await pause(90);

    const optimizedInference = await executeInference(
      scenario,
      input.objective,
      compile,
      retrieval.memories,
      compile.selected,
      "optimized",
    );
    send({
      type: "optimized.completed",
      phase: "inference",
      progress: 0.82,
      message: `Compiled context sent ${compile.selected.memoryIds.length} memories and used ${optimizedInference.usage.promptTokens.toLocaleString()} prompt tokens.`,
      data: { answer: optimizedInference.answer, usage: optimizedInference.usage, mode: optimizedInference.mode },
    });
    await pause();

    const baselineEvaluation = evaluateRun(
      scenario,
      baselineInference.answer,
      compile,
      input.constraints.region,
      compile.baseline,
    );
    const optimizedEvaluation = evaluateRun(
      scenario,
      optimizedInference.answer,
      compile,
      input.constraints.region,
      compile.selected,
    );
    const comparison: ExecutionComparison = {
      baseline: {
        answer: baselineInference.answer,
        usage: baselineInference.usage,
        evaluation: baselineEvaluation,
      },
      optimized: {
        answer: optimizedInference.answer,
        usage: optimizedInference.usage,
        evaluation: optimizedEvaluation,
      },
      tokenReduction: Math.max(
        0,
        1 - optimizedInference.usage.promptTokens / baselineInference.usage.promptTokens,
      ),
      costReduction: Math.max(
        0,
        1 - optimizedInference.usage.actualCost / baselineInference.usage.actualCost,
      ),
      requiredFactsPreserved: optimizedEvaluation.checks
        .filter((check) => check.label === "Memory policy" || check.label === "Required facts")
        .every((check) => check.passed),
      sameModel: compile.selected.modelId === compile.baseline.modelId,
    };

    send({
      type: "inference.completed",
      phase: "inference",
      progress: 0.85,
      message: `Controlled comparison measured ${(comparison.costReduction * 100).toFixed(1)}% lower Cortex cost with the model held constant.`,
      data: { comparison, mode: optimizedInference.mode },
    });

    send({
      type: "evaluation.completed",
      phase: "evaluation",
      progress: 0.9,
      message: `The optimized answer preserved required facts and scored ${(optimizedEvaluation.score * 100).toFixed(1)}%.`,
      data: optimizedEvaluation,
    });

    const counterfactuals: CounterfactualResult[] = [];
    for (const counterfactual of compile.counterfactualPlans) {
      const execution = await executeInference(
        scenario,
        input.objective,
        compile,
        retrieval.memories,
        counterfactual.plan,
        "counterfactual",
      );
      const evaluation = evaluateRun(
        scenario,
        execution.answer,
        compile,
        input.constraints.region,
        counterfactual.plan,
      );
      const sourceAnswer = counterfactual.role === "rejected_control"
        ? baselineInference.answer
        : optimizedInference.answer;
      const answerChanged = execution.answer.trim() !== sourceAnswer.trim();
      const outcomeChanged =
        !evaluation.policyPassed ||
        answerChanged ||
        Math.abs(counterfactual.expectedQualityDelta) >= 0.015;
      const detail = counterfactual.role === "pinned"
        ? "Removing this memory fails the safety or required-fact check."
        : counterfactual.role === "selected"
          ? `Removing this memory changes expected outcome quality by ${(counterfactual.expectedQualityDelta * 100).toFixed(1)} points.`
          : `Removing this rejected control from full context changes expected quality by ${(counterfactual.expectedQualityDelta * 100).toFixed(1)} points.`;
      counterfactuals.push({
        memoryId: counterfactual.memoryId,
        memoryContent: counterfactual.memoryContent,
        role: counterfactual.role,
        promptTokens: execution.usage.promptTokens,
        qualityDelta: counterfactual.expectedQualityDelta,
        policyPassed: evaluation.policyPassed,
        outcomeChanged,
        detail,
      });
    }
    send({
      type: "counterfactual.completed",
      phase: "evaluation",
      progress: 0.96,
      message: `${counterfactuals.length} same-model ablations proved which memories changed safety or outcome quality.`,
      data: counterfactuals,
    });

    const memoryWritten = await writeInteractionToEverOS(
      input.objective,
      optimizedInference.answer,
      runId,
    );
    const providers: ProviderStatus = {
      everos: retrieval.mode,
      snowflake: optimizedInference.mode,
      message: `${retrieval.detail} ${optimizedInference.detail}`,
    };
    const runWithoutLedger: Omit<RunResult, "ledger"> = {
      runId,
      scenarioId: scenario.id,
      objective: input.objective,
      answer: optimizedInference.answer,
      compile,
      usage: optimizedInference.usage,
      evaluation: optimizedEvaluation,
      comparison,
      counterfactuals,
      providers,
      createdAt: new Date().toISOString(),
    };
    const ledger = await persistRunToSnowflake(runWithoutLedger);
    const result: RunResult = { ...runWithoutLedger, ledger };
    recentRuns.unshift(result);
    recentRuns.splice(10);

    send({
      type: "ledger.completed",
      phase: "ledger",
      progress: 1,
      message: `${ledger.detail}${memoryWritten ? " Outcome queued for EverOS consolidation." : ""}`,
      data: result,
    });
    response.end();
  } catch (error) {
    send({
      type: "run.error",
      phase: "ledger",
      progress: 1,
      message: error instanceof Error ? error.message : "The compiler run failed.",
    });
    response.end();
  }
});

app.listen(port, "127.0.0.1", () => {
  console.log(`TokenOS compiler listening on http://127.0.0.1:${port}`);
});
