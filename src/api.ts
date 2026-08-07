import type { ProviderMode, Scenario } from "../shared/contracts";
import type {
  RavenProviderStatus,
  RavenRunEvent,
  RavenRunEventType,
  RavenRunRequest,
} from "../shared/raven-contract";

export type ScenarioSummary = Pick<
  Scenario,
  "id" | "name" | "tag" | "objective" | "policy" | "tools"
>;

const providerModes = new Set<ProviderMode>(["live", "replay", "mixed"]);
const eventTypes = new Set<RavenRunEventType>([
  "run.started",
  "recall.started",
  "recall.completed",
  "price.completed",
  "connect.completed",
  "compile.started",
  "compile.completed",
  "compile.refused",
  "raven.started",
  "uncontrolled.completed",
  "governed.completed",
  "comparison.completed",
  "learn.started",
  "learn.completed",
  "run.completed",
  "run.error",
]);

function providerMode(value: unknown): ProviderMode {
  return providerModes.has(value as ProviderMode) ? (value as ProviderMode) : "replay";
}

function ravenMode(value: unknown): RavenProviderStatus["raven"] {
  return value === "live" ? "live" : "replay";
}

function parseEvent(line: string): RavenRunEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("The TokenOS run returned malformed evidence.");
  }

  if (!value || typeof value !== "object") {
    throw new Error("The TokenOS run returned an invalid event.");
  }
  const event = value as Partial<RavenRunEvent>;
  if (
    !eventTypes.has(event.type as RavenRunEventType) ||
    typeof event.phase !== "string" ||
    typeof event.progress !== "number" ||
    typeof event.message !== "string"
  ) {
    throw new Error("The TokenOS run returned incomplete evidence.");
  }

  return {
    ...event,
    type: event.type as RavenRunEventType,
    phase: event.phase as RavenRunEvent["phase"],
    progress: Math.max(0, Math.min(1, event.progress)),
    message: event.message,
  };
}

export async function getAppData() {
  const [healthResponse, scenariosResponse] = await Promise.all([
    fetch("/api/health"),
    fetch("/api/scenarios"),
  ]);

  if (!healthResponse.ok || !scenariosResponse.ok) {
    throw new Error("TokenOS memory governor is not reachable.");
  }

  const health = (await healthResponse.json()) as {
    ok: boolean;
    providers?: Partial<RavenProviderStatus>;
  };
  const scenarios = (await scenariosResponse.json()) as ScenarioSummary[];
  const providers: RavenProviderStatus = {
    everos: providerMode(health.providers?.everos),
    raven: ravenMode(health.providers?.raven),
    message: health.providers?.message ?? "Raven and EverOS provider modes are reported by the runtime.",
  };

  return { providers, scenarios };
}

export async function streamRun(
  input: RavenRunRequest,
  onEvent: (event: RavenRunEvent) => void | Promise<void>,
) {
  const response = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Memory governor returned ${response.status}.`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-ndjson")) {
    throw new Error("The TokenOS run endpoint returned an unexpected response. Refresh and run again.");
  }
  if (!response.body) throw new Error("The TokenOS run did not return an evidence stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;

  const emit = async (line: string) => {
    if (!line.trim()) return;
    const event = parseEvent(line);
    if (["run.completed", "compile.refused", "run.error"].includes(event.type)) terminal = true;
    await onEvent(event);
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) await emit(line);
    if (done) break;
  }

  if (buffer.trim()) await emit(buffer);
  if (!terminal) throw new Error("The TokenOS run ended before the final result. Run it again.");
}
