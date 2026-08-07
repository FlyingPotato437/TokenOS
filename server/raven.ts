import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { MemoryCandidate, PlanCandidate, Scenario } from "../shared/contracts.ts";
import type {
  RavenExecutionContract,
  RavenProviderStatus,
  RavenUsage,
} from "../shared/raven-contract.ts";

const execFileAsync = promisify(execFile);
const ANSI_PATTERN = new RegExp(String.raw`\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`, "g");

export const RAVEN_GENERATION_CONFIG = {
  temperature: 0,
  maxOutputTokens: 600,
} as const;

export type RavenExecutionResult = {
  answer: string;
  usage: RavenUsage;
  mode: "live" | "replay";
  model: string;
  tools: string[];
  detail: string;
};

function configured(value: string | undefined) {
  return Boolean(value?.trim());
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

async function executableAvailable(command: string) {
  const candidates = isAbsolute(command) || command.includes("/")
    ? [command]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

export async function getRavenProviderStatus(): Promise<RavenProviderStatus> {
  const command = process.env.RAVEN_COMMAND?.trim() || "raven";
  const ravenRequestedLive = process.env.RAVEN_MODE?.trim().toLowerCase() === "live";
  const ravenAvailable = ravenRequestedLive && await executableAvailable(command);
  const everosRequestedLive = process.env.EVEROS_MODE?.trim().toLowerCase() === "live";
  const everosLive = everosRequestedLive && configured(process.env.EVEROS_API_KEY);
  return {
    everos: everosLive ? "live" : "replay",
    raven: ravenAvailable ? "live" : "replay",
    message: ravenAvailable
      ? `Raven live execution is available; EverOS is ${everosLive ? "live" : "in deterministic replay mode"}.`
      : ravenRequestedLive
        ? `Raven live mode was requested, but ${command} is unavailable; executions will fail rather than masquerade as live.`
        : "Deterministic Raven replay is active. Set RAVEN_MODE=live only after Raven is installed and onboarded.",
  };
}

export function buildExecutionContract(scenario: Scenario, objective: string): RavenExecutionContract {
  const model = process.env.RAVEN_MODEL?.trim() || "configured-default";
  const tools = scenario.tools.map((tool) => tool.id).sort();
  const taskFingerprint = createHash("sha256")
    .update(JSON.stringify({ objective, model, tools, generationConfig: RAVEN_GENERATION_CONFIG }))
    .digest("hex")
    .slice(0, 16);
  return {
    runtime: "raven",
    model,
    tools,
    taskFingerprint,
    generationConfig: RAVEN_GENERATION_CONFIG,
  };
}

export function buildRavenPrompt(
  scenario: Scenario,
  objective: string,
  plan: PlanCandidate,
  memories: MemoryCandidate[],
  contract: RavenExecutionContract,
) {
  const selectedIds = new Set(plan.memoryIds);
  const context = memories
    .filter((memory) => selectedIds.has(memory.id))
    .map((memory, index) => `[${index + 1}] ${memory.type.toUpperCase()} · ${memory.content}`)
    .join("\n");
  const toolContract = scenario.tools
    .map((tool) => `- ${tool.id}: ${tool.description}`)
    .join("\n");

  return `You are Raven executing one controlled TokenOS evaluation turn.

Execution contract (held constant across both runs)
- Runtime: Raven
- Model: ${contract.model}
- Task fingerprint: ${contract.taskFingerprint}
- Temperature: ${contract.generationConfig.temperature}
- Maximum output tokens: ${contract.generationConfig.maxOutputTokens}

Available tools (held constant; use only when needed)
${toolContract || "- No external tools are configured."}

EverOS memory supplied for this run
${context || "No long-term memory was supplied."}

Task
${objective}

Return a concise, operational answer. Do not discuss TokenOS internals. Use only facts supported by the task, supplied memory, or tool results.`;
}

function cleanRavenOutput(stdout: string) {
  const cleaned = stdout.replace(ANSI_PATTERN, "").replace(/\r/g, "").trim();
  if (!cleaned) return "";
  const lines = cleaned.split("\n");
  const ravenHeader = lines.findIndex((line) => /\bRaven\s*$/.test(line.trim()));
  return (ravenHeader >= 0 ? lines.slice(ravenHeader + 1) : lines)
    .filter((line) => !/^Raven is thinking/.test(line.trim()))
    .join("\n")
    .trim();
}

function parseStructuredOutput(stdout: string) {
  const lines = stdout.trim().split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]) as Record<string, unknown>;
      const answer = String(parsed.answer ?? parsed.output ?? "").trim();
      const usage = parsed.usage && typeof parsed.usage === "object"
        ? parsed.usage as Record<string, unknown>
        : undefined;
      if (answer) return { answer, usage };
    } catch {
      // Official Raven prints human-readable output; JSON is only for compatible wrappers.
    }
  }
  return undefined;
}

async function readTraceUsage(traceDirectory: string): Promise<{
  usage?: RavenUsage;
  model?: string;
}> {
  try {
    const raw = await readFile(join(traceDirectory, "logs", "audit-spans.log"), "utf8");
    const bySpanId = new Map<string, Record<string, unknown>>();
    for (const line of raw.split("\n").filter(Boolean)) {
      try {
        const span = JSON.parse(line) as Record<string, unknown>;
        bySpanId.set(String(span.spanId ?? Math.random()), span);
      } catch {
        // Ignore an incomplete trace line rather than losing the completed measurements.
      }
    }
    const llmSpans = [...bySpanId.values()].filter((span) => span.name === "llm.call");
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let model: string | undefined;
    for (const span of llmSpans) {
      const attributes = span.attributes && typeof span.attributes === "object"
        ? span.attributes as Record<string, unknown>
        : {};
      inputTokens += Number(attributes["llm.usage.input_tokens"] ?? 0);
      outputTokens += Number(attributes["llm.usage.output_tokens"] ?? 0);
      totalTokens += Number(attributes["llm.usage.total_tokens"] ?? 0);
      if (attributes["llm.model"]) model = String(attributes["llm.model"]);
    }
    if (inputTokens <= 0 && outputTokens <= 0 && totalTokens <= 0) return { model };
    return {
      model,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: totalTokens || inputTokens + outputTokens,
        estimated: false,
      },
    };
  } catch {
    return {};
  }
}

function usageFromWrapper(usage: Record<string, unknown> | undefined): RavenUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens);
  if (inputTokens <= 0 && outputTokens <= 0 && totalTokens <= 0) return undefined;
  return { inputTokens, outputTokens, totalTokens, estimated: false };
}

function replayExecution(
  scenario: Scenario,
  prompt: string,
  contract: RavenExecutionContract,
  detail: string,
): RavenExecutionResult {
  const answer = scenario.demoAnswer;
  const inputTokens = estimateTokens(prompt);
  const outputTokens = estimateTokens(answer);
  return {
    answer,
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: true },
    mode: "replay",
    model: contract.model,
    tools: contract.tools,
    detail,
  };
}

export async function executeRaven(input: {
  runId: string;
  kind: "uncontrolled" | "governed" | "counterfactual";
  scenario: Scenario;
  objective: string;
  plan: PlanCandidate;
  memories: MemoryCandidate[];
  contract: RavenExecutionContract;
  forceReplay?: boolean;
}): Promise<RavenExecutionResult> {
  const prompt = buildRavenPrompt(
    input.scenario,
    input.objective,
    input.plan,
    input.memories,
    input.contract,
  );
  const command = process.env.RAVEN_COMMAND?.trim() || "raven";
  const liveRequested = process.env.RAVEN_MODE?.trim().toLowerCase() === "live";
  if (input.forceReplay || !liveRequested) {
    return replayExecution(
      input.scenario,
      prompt,
      input.contract,
      input.forceReplay
        ? "Using an explicitly requested deterministic Raven replay."
        : "Using deterministic Raven replay; counts are labeled estimates.",
    );
  }
  if (!(await executableAvailable(command))) {
    throw new Error(`Raven live mode requires an executable ${command} command.`);
  }

  const traceDirectory = await mkdtemp(join(tmpdir(), `tokenos-raven-${input.kind}-`));
  const args = ["agent", "-m", prompt, "--no-markdown"];
  if (process.env.RAVEN_WORKSPACE?.trim()) args.push("--workspace", process.env.RAVEN_WORKSPACE.trim());
  if (process.env.RAVEN_CONFIG_PATH?.trim()) args.push("--config", process.env.RAVEN_CONFIG_PATH.trim());

  try {
    const timeout = Math.max(10_000, Number(process.env.RAVEN_TIMEOUT_MS ?? 120_000));
    const execution = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        RAVEN_TRACING: "1",
        RAVEN_TRACING_DIR: traceDirectory,
      },
    });
    const stdout = String(execution.stdout ?? "");
    const structured = parseStructuredOutput(stdout);
    const traces = await readTraceUsage(traceDirectory);
    const answer = structured?.answer || cleanRavenOutput(stdout);
    if (!answer) throw new Error("Raven returned no answer text");
    const measuredUsage = traces.usage ?? usageFromWrapper(structured?.usage);
    if (!measuredUsage) {
      throw new Error("Raven live execution returned no provider token usage in its isolated trace");
    }
    return {
      answer,
      usage: measuredUsage,
      mode: "live",
      model: traces.model ?? input.contract.model,
      tools: input.contract.tools,
      detail: `Raven ${input.kind} execution completed; token usage was read from Raven's own LLM trace.`,
    };
  } catch (error) {
    throw new Error(`Raven live execution failed: ${error instanceof Error ? error.message : "execution failed"}.`);
  } finally {
    await rm(traceDirectory, { recursive: true, force: true });
  }
}
