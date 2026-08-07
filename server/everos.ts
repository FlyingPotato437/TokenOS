import type { MemoryCandidate, ProviderMode, Scenario } from "../shared/contracts.ts";
import type { LearningReceipt } from "../shared/raven-contract.ts";

const DEFAULT_BASE_URL = "https://api.evermind.ai";
const MAX_CANDIDATES = 15;

export type EverOSRetrieval = {
  memories: MemoryCandidate[];
  mode: ProviderMode;
  detail: string;
  historicalLiftApplied: boolean;
};

export type LearnedMemorySignal = {
  runId: string;
  memoryIds: string[];
  occurrences: number;
};

function configured(value: string | undefined) {
  return Boolean(value?.trim());
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function estimateMemoryTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

function recordText(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeScore(record: Record<string, unknown>, fallback: number) {
  const raw = Number(record.score ?? record.relevance_score ?? fallback);
  return clamp(Number.isFinite(raw) ? raw : fallback, 0.05, 0.99);
}

function normalizeEverOSPayload(payload: unknown): MemoryCandidate[] {
  const envelope = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const data = envelope.data && typeof envelope.data === "object"
    ? envelope.data as Record<string, unknown>
    : envelope;
  const memories: MemoryCandidate[] = [];

  records(data.episodes).forEach((episode, index) => {
    const content = recordText(episode, ["summary", "episode", "content"]);
    if (!content) return;
    const relevance = normalizeScore(episode, 0.72);
    memories.push({
      id: String(episode.id ?? episode.episode_id ?? `everos-episode-${index}`),
      content,
      source: "EverOS episode",
      type: "episode",
      tokens: estimateMemoryTokens(content),
      relevance,
      confidence: clamp(Number(episode.confidence ?? 0.88), 0.1, 0.99),
      successLift: 0.04 + relevance * 0.13,
      recency: clamp(Number(episode.recency ?? 0.72), 0.05, 1),
    });
  });

  records(data.profiles).forEach((profile, index) => {
    const profileData = profile.profile_data;
    const content = profileData && typeof profileData === "object"
      ? Object.entries(profileData as Record<string, unknown>)
          .map(([key, value]) => `${key}: ${String(value)}`)
          .join(". ")
      : recordText(profile, ["content", "summary"]);
    if (!content.trim()) return;
    memories.push({
      id: String(profile.id ?? `everos-profile-${index}`),
      content,
      source: "EverOS profile",
      type: "profile",
      tokens: estimateMemoryTokens(content),
      relevance: normalizeScore(profile, 0.82),
      confidence: clamp(Number(profile.confidence ?? 0.94), 0.1, 0.99),
      successLift: 0.1,
      recency: 0.9,
    });
  });

  records(data.agent_cases).forEach((agentCase, index) => {
    const intent = recordText(agentCase, ["task_intent", "content", "summary"]);
    const insight = recordText(agentCase, ["key_insight", "lesson", "outcome"]);
    const content = [intent, insight].filter(Boolean).join("\n\n");
    if (!content) return;
    const relevance = normalizeScore(agentCase, 0.84);
    memories.push({
      id: String(agentCase.id ?? `everos-agent-case-${index}`),
      content,
      source: "EverOS Raven case",
      type: "agent_case",
      tokens: estimateMemoryTokens(content),
      relevance,
      confidence: clamp(Number(agentCase.confidence ?? 0.9), 0.1, 0.99),
      successLift: 0.1 + relevance * 0.09,
      recency: clamp(Number(agentCase.recency ?? 0.82), 0.05, 1),
      historicalOutcomeLift: 0.035,
      learnedCaseId: String(agentCase.id ?? `everos-agent-case-${index}`),
    });
  });

  records(data.agent_skills).forEach((skill, index) => {
    const name = recordText(skill, ["name"]);
    const body = recordText(skill, ["content", "description", "summary"]);
    const content = [name, body].filter(Boolean).join(": ");
    if (!content) return;
    const relevance = normalizeScore(skill, 0.8);
    memories.push({
      id: String(skill.id ?? `everos-agent-skill-${index}`),
      content,
      source: "EverOS Raven skill",
      type: "agent_skill",
      tokens: estimateMemoryTokens(content),
      relevance,
      confidence: clamp(Number(skill.confidence ?? 0.86), 0.1, 0.99),
      successLift: 0.07 + relevance * 0.08,
      recency: clamp(Number(skill.recency ?? 0.8), 0.05, 1),
    });
  });

  return memories;
}

function mergeUnique(...groups: MemoryCandidate[][]) {
  const merged: MemoryCandidate[] = [];
  const ids = new Set<string>();
  const content = new Set<string>();
  for (const memory of groups.flat()) {
    const normalizedContent = memory.content.trim().toLowerCase();
    if (!normalizedContent || ids.has(memory.id) || content.has(normalizedContent)) continue;
    ids.add(memory.id);
    content.add(normalizedContent);
    merged.push(memory);
  }
  return merged;
}

function mergeWithReplayAnchors(scenario: Scenario, liveMemories: MemoryCandidate[]) {
  const anchors = scenario.memories.filter(
    (memory) => memory.policyCritical || (memory.requiredFacts?.length ?? 0) > 0,
  );
  const supplemental = scenario.memories.filter((memory) => !anchors.includes(memory));
  return mergeUnique(anchors, liveMemories, supplemental).slice(0, MAX_CANDIDATES);
}

function applyHistoricalSignals(
  memories: MemoryCandidate[],
  signals: LearnedMemorySignal[],
) {
  const byMemory = new Map<string, LearnedMemorySignal>();
  for (const signal of signals) {
    for (const memoryId of signal.memoryIds) {
      const previous = byMemory.get(memoryId);
      if (!previous || signal.occurrences >= previous.occurrences) byMemory.set(memoryId, signal);
    }
  }
  let applied = false;
  const boosted = memories.map((memory) => {
    const signal = byMemory.get(memory.id);
    if (!signal) return memory;
    applied = true;
    return {
      ...memory,
      historicalOutcomeLift: Math.min(0.12, (memory.historicalOutcomeLift ?? 0) + signal.occurrences * 0.025),
      learnedCaseId: signal.runId,
    };
  });
  return { memories: boosted, applied };
}

async function searchTrack(body: Record<string, unknown>) {
  const apiKey = process.env.EVEROS_API_KEY!;
  const baseUrl = process.env.EVEROS_BASE_URL ?? DEFAULT_BASE_URL;
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v2/memory/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`EverOS search returned ${response.status}`);
  return normalizeEverOSPayload(await response.json());
}

export async function retrieveEverOSMemories(
  scenario: Scenario,
  objective: string,
  historicalSignals: LearnedMemorySignal[] = [],
): Promise<EverOSRetrieval> {
  const liveRequested = process.env.EVEROS_MODE?.trim().toLowerCase() === "live";
  if (!liveRequested || !configured(process.env.EVEROS_API_KEY)) {
    const boosted = applyHistoricalSignals(scenario.memories, historicalSignals);
    return {
      memories: boosted.memories,
      mode: "replay",
      detail: "Using the deterministic EverOS replay across profiles, episodes, Raven cases, and skills.",
      historicalLiftApplied: boosted.applied,
    };
  }

  const userId = process.env.EVEROS_USER_ID ?? "tokenos-demo-user";
  const agentId = process.env.EVEROS_AGENT_ID ?? "tokenos-raven";
  const appId = process.env.EVEROS_APP_ID ?? "tokenos";
  const projectId = process.env.EVEROS_PROJECT_ID ?? "raven-demo";
  try {
    const [userMemories, agentMemories] = await Promise.all([
      searchTrack({ query: objective, user_id: userId, app_id: appId, project_id: projectId, method: "hybrid", top_k: 12, include_profile: true }),
      searchTrack({ query: objective, agent_id: agentId, app_id: appId, project_id: projectId, method: "hybrid", top_k: 12 }),
    ]);
    const liveMemories = mergeUnique(userMemories, agentMemories);
    if (!liveMemories.length) throw new Error("EverOS returned no usable memory records");
    const merged = mergeWithReplayAnchors(scenario, liveMemories);
    const boosted = applyHistoricalSignals(merged, historicalSignals);
    return {
      memories: boosted.memories,
      mode: "mixed",
      detail: `EverOS returned ${userMemories.length} user memories and ${agentMemories.length} Raven cases or skills; workspace policy anchors completed the governed set.`,
      historicalLiftApplied: boosted.applied,
    };
  } catch (error) {
    const boosted = applyHistoricalSignals(scenario.memories, historicalSignals);
    return {
      memories: boosted.memories,
      mode: "replay",
      detail: `EverOS live recall failed, so the response is explicitly labeled replay: ${error instanceof Error ? error.message : "request failed"}.`,
      historicalLiftApplied: boosted.applied,
    };
  }
}

export async function writeRavenCaseToEverOS(input: {
  runId: string;
  objective: string;
  answer: string;
  lesson: string;
  selectedMemoryIds: string[];
  historicalLiftApplied: boolean;
}): Promise<LearningReceipt> {
  const liveRequested = process.env.EVEROS_MODE?.trim().toLowerCase() === "live";
  if (!liveRequested || !configured(process.env.EVEROS_API_KEY)) {
    return {
      mode: "local",
      written: true,
      agentCaseId: input.runId,
      lesson: input.lesson,
      historicalLiftApplied: input.historicalLiftApplied,
      detail: "Successful Raven case recorded in the local learning ledger; EverOS replay mode is active.",
    };
  }

  const apiKey = process.env.EVEROS_API_KEY!;
  const baseUrl = (process.env.EVEROS_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const userId = process.env.EVEROS_USER_ID ?? "tokenos-demo-user";
  const agentId = process.env.EVEROS_AGENT_ID ?? "tokenos-raven";
  const appId = process.env.EVEROS_APP_ID ?? "tokenos";
  const projectId = process.env.EVEROS_PROJECT_ID ?? "raven-demo";
  const sessionId = `tokenos-${input.runId}`;
  const timestamp = Date.now();
  const messages = [
    { sender_id: userId, role: "user", timestamp, content: input.objective },
    { sender_id: agentId, role: "assistant", timestamp: timestamp + 1, content: input.answer },
    {
      sender_id: agentId,
      role: "assistant",
      timestamp: timestamp + 2,
      content: `Successful memory portfolio: ${input.selectedMemoryIds.join(", ")}. ${input.lesson}`,
    },
  ];
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  try {
    const addResponse = await fetch(`${baseUrl}/api/v2/memory/add`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        session_id: sessionId,
        agent_id: agentId,
        app_id: appId,
        project_id: projectId,
        mode: "agent",
        async_mode: false,
        messages,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!addResponse.ok) throw new Error(`add returned ${addResponse.status}`);
    const addPayload = await addResponse.json().catch(() => ({})) as Record<string, unknown>;
    const flushResponse = await fetch(`${baseUrl}/api/v2/memory/flush`, {
      method: "POST",
      headers,
      body: JSON.stringify({ session_id: sessionId, agent_id: agentId, app_id: appId, project_id: projectId }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!flushResponse.ok) throw new Error(`flush returned ${flushResponse.status}`);
    return {
      mode: "everos",
      written: true,
      agentCaseId: String(addPayload.request_id ?? sessionId),
      lesson: input.lesson,
      historicalLiftApplied: input.historicalLiftApplied,
      detail: "Successful Raven outcome was flushed to EverOS for agent-case and skill extraction.",
    };
  } catch (error) {
    return {
      mode: "local",
      written: true,
      agentCaseId: input.runId,
      lesson: input.lesson,
      historicalLiftApplied: input.historicalLiftApplied,
      detail: `EverOS writeback fell back to the local learning ledger: ${error instanceof Error ? error.message : "request failed"}.`,
    };
  }
}
