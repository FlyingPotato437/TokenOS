import { modelCatalog } from "../shared/catalog.ts";
import type {
  CompileResult,
  MemoryCandidate,
  PlanCandidate,
  ProviderMode,
  ProviderStatus,
  RunUsage,
  Scenario,
} from "../shared/contracts.ts";

type RetrievalResult = {
  memories: MemoryCandidate[];
  mode: ProviderMode;
  detail: string;
};

type InferenceResult = {
  answer: string;
  usage: RunUsage;
  mode: ProviderMode;
  detail: string;
};

const tokenEstimate = (text: string) => Math.max(1, Math.ceil(text.length / 4));

function configured(value: string | undefined) {
  return Boolean(value && value.trim() && !value.includes("your-account"));
}

export function getProviderStatus(): ProviderStatus {
  const everosLive = configured(process.env.EVEROS_API_KEY);
  const snowflakeLive =
    configured(process.env.SNOWFLAKE_ACCOUNT_URL) && configured(process.env.SNOWFLAKE_PAT);

  return {
    everos: everosLive ? "live" : "demo",
    snowflake: snowflakeLive ? "live" : "demo",
    message:
      everosLive && snowflakeLive
        ? "EverOS retrieval and Snowflake Cortex inference are live."
        : "The local optimizer is live. Add provider credentials to replace demo retrieval and inference.",
  };
}

function normalizeLiveMemories(payload: unknown): MemoryCandidate[] {
  const envelope = payload as {
    data?: {
      episodes?: Array<Record<string, unknown>>;
      profiles?: Array<Record<string, unknown>>;
    };
    episodes?: Array<Record<string, unknown>>;
    profiles?: Array<Record<string, unknown>>;
  };
  const data = envelope.data ?? envelope;
  const episodes = Array.isArray(data.episodes) ? data.episodes : [];
  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  const normalized: MemoryCandidate[] = [];

  episodes.slice(0, 12).forEach((episode, index) => {
    const facts = Array.isArray(episode.atomic_facts)
      ? episode.atomic_facts
          .map((fact) =>
            typeof fact === "string"
              ? fact
              : String((fact as Record<string, unknown>).content ?? ""),
          )
          .filter(Boolean)
          .join(" ")
      : "";
    const content = String(
      episode.summary ?? episode.episode ?? episode.content ?? facts ?? "",
    ).trim();
    if (!content) return;
    const relevance = Number(episode.score ?? episode.relevance_score ?? 0.72);
    normalized.push({
      id: String(episode.id ?? episode.episode_id ?? `everos-episode-${index}`),
      content,
      source: "EverOS live episode",
      type: "episode",
      tokens: tokenEstimate(content),
      relevance: Math.min(0.99, Math.max(0.1, relevance)),
      confidence: 0.88,
      successLift: 0.05 + Math.min(0.16, relevance * 0.12),
    });
  });

  profiles.slice(0, 3).forEach((profile, index) => {
    const profileData = profile.profile_data;
    const content =
      profileData && typeof profileData === "object"
        ? Object.entries(profileData as Record<string, unknown>)
            .map(([key, value]) => `${key}: ${String(value)}`)
            .join(". ")
        : String(profile.content ?? profile.summary ?? "");
    if (!content.trim()) return;
    normalized.push({
      id: String(profile.id ?? `everos-profile-${index}`),
      content,
      source: "EverOS live profile",
      type: "profile",
      tokens: tokenEstimate(content),
      relevance: 0.82,
      confidence: 0.92,
      successLift: 0.1,
    });
  });

  return normalized;
}

function mergeWithWorkspacePolicies(
  scenario: Scenario,
  liveMemories: MemoryCandidate[],
): MemoryCandidate[] {
  const policies = scenario.memories.filter((memory) => memory.policyCritical);
  const supplemental = scenario.memories.filter((memory) => !memory.policyCritical);
  const merged = [...policies, ...liveMemories];
  const existing = new Set(merged.map((memory) => memory.content.toLowerCase()));

  for (const memory of supplemental) {
    if (merged.length >= 15) break;
    if (!existing.has(memory.content.toLowerCase())) merged.push(memory);
  }

  return merged.slice(0, 15);
}

export async function retrieveMemories(
  scenario: Scenario,
  objective: string,
): Promise<RetrievalResult> {
  const apiKey = process.env.EVEROS_API_KEY;
  const baseUrl = process.env.EVEROS_BASE_URL ?? "https://api.evermind.ai";

  if (!configured(apiKey)) {
    return {
      memories: scenario.memories,
      mode: "demo",
      detail: "Using the deterministic EverOS replay set.",
    };
  }

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v2/memory/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: objective,
        user_id: process.env.EVEROS_USER_ID ?? "tokenos-demo-user",
        method: "hybrid",
        top_k: 15,
        include_profile: true,
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      throw new Error(`EverOS returned ${response.status}`);
    }

    const liveMemories = normalizeLiveMemories(await response.json());
    if (!liveMemories.length) {
      return {
        memories: scenario.memories,
        mode: "fallback",
        detail: "EverOS returned no matches, so TokenOS used the workspace memory set.",
      };
    }

    return {
      memories: mergeWithWorkspacePolicies(scenario, liveMemories),
      mode: "live",
      detail: `EverOS returned ${liveMemories.length} live memory candidates.`,
    };
  } catch (error) {
    return {
      memories: scenario.memories,
      mode: "fallback",
      detail: `EverOS fallback: ${error instanceof Error ? error.message : "request failed"}.`,
    };
  }
}

function buildSystemPrompt(
  scenario: Scenario,
  objective: string,
  plan: PlanCandidate,
  memories: MemoryCandidate[],
  variant: "baseline" | "optimized" | "counterfactual",
) {
  const selectedMemoryIds = new Set(plan.memoryIds);
  const context = memories
    .filter((memory) => selectedMemoryIds.has(memory.id))
    .map((memory, index) => `${index + 1}. ${memory.content}`)
    .join("\n");
  const tools = scenario.tools
    .filter((tool) => plan.toolIds.includes(tool.id))
    .map((tool) => `- ${tool.name}: ${tool.description}`)
    .join("\n");

  return `You are the execution agent inside TokenOS. Produce a concise, action-oriented answer.

Controlled experiment variant: ${variant}

Hard policy:
${scenario.policy}

Selected long-term memory:
${context || "No memory selected."}

Approved tools and available results:
${tools || "No tools selected."}

Task:
${objective}

Do not mention TokenOS internals. State the recommended action, supporting evidence, and policy-safe next steps.`;
}

function estimateUsage(
  answer: string,
  prompt: string,
  plan: PlanCandidate,
): RunUsage {
  const model = modelCatalog.find((item) => item.id === plan.modelId) ?? modelCatalog[1];
  const promptTokens = Math.max(plan.inputTokens, tokenEstimate(prompt));
  const completionTokens = tokenEstimate(answer);
  const actualCost =
    ((promptTokens * model.inputCreditsPerMillion + completionTokens * model.outputCreditsPerMillion) /
      1_000_000) *
    2;

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    actualCost: Math.max(0, actualCost),
    estimated: true,
  };
}

export async function executeInference(
  scenario: Scenario,
  objective: string,
  compile: CompileResult,
  memories: MemoryCandidate[],
  plan: PlanCandidate = compile.selected,
  variant: "baseline" | "optimized" | "counterfactual" = "optimized",
): Promise<InferenceResult> {
  const accountUrl = process.env.SNOWFLAKE_ACCOUNT_URL;
  const pat = process.env.SNOWFLAKE_PAT;
  const prompt = buildSystemPrompt(scenario, objective, plan, memories, variant);

  if (!configured(accountUrl) || !configured(pat)) {
    return {
      answer: scenario.demoAnswer,
      usage: estimateUsage(scenario.demoAnswer, prompt, plan),
      mode: "demo",
      detail: `Using the deterministic Cortex ${variant} replay.`,
    };
  }

  const model = process.env.TOKENOS_FORCE_MODEL || plan.modelId;
  const endpoint = `${accountUrl?.replace(/\/$/, "")}/api/v2/cortex/v1/chat/completions`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_completion_tokens: 600,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      code?: string | number;
      message?: string;
    };

    if (!response.ok || payload.code === 390112 || !payload.choices?.[0]?.message?.content) {
      throw new Error(payload.message ?? `Snowflake returned ${response.status}`);
    }

    const answer = payload.choices[0].message.content;
    const modelPricing =
      modelCatalog.find((item) => item.id === plan.modelId) ?? modelCatalog[1];
    const promptTokens = payload.usage?.prompt_tokens ?? tokenEstimate(prompt);
    const completionTokens = payload.usage?.completion_tokens ?? tokenEstimate(answer);
    const inferenceCost =
      ((promptTokens * modelPricing.inputCreditsPerMillion +
        completionTokens * modelPricing.outputCreditsPerMillion) /
        1_000_000) *
      2;
    return {
      answer,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: payload.usage?.total_tokens ?? promptTokens + completionTokens,
        actualCost: inferenceCost,
        estimated: false,
      },
      mode: "live",
      detail: `Snowflake Cortex completed the ${variant} run with ${model}.`,
    };
  } catch (error) {
    return {
      answer: scenario.demoAnswer,
      usage: estimateUsage(scenario.demoAnswer, prompt, plan),
      mode: "fallback",
      detail: `Cortex fallback: ${error instanceof Error ? error.message : "request failed"}.`,
    };
  }
}

export async function writeInteractionToEverOS(
  objective: string,
  answer: string,
  runId: string,
) {
  const apiKey = process.env.EVEROS_API_KEY;
  const baseUrl = process.env.EVEROS_BASE_URL ?? "https://api.evermind.ai";
  if (!configured(apiKey)) return false;

  const now = Date.now();
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v2/memory/add`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session_id: `tokenos-${runId}`,
        async_mode: true,
        messages: [
          {
            sender_id: process.env.EVEROS_USER_ID ?? "tokenos-demo-user",
            role: "user",
            timestamp: now,
            content: objective,
          },
          {
            sender_id: "tokenos-agent",
            role: "assistant",
            timestamp: now + 1,
            content: answer,
          },
        ],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
