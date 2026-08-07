import type {
  ProviderStatus,
  RunEvent,
  RunRequest,
  Scenario,
} from "../shared/contracts";

export type ScenarioSummary = Pick<
  Scenario,
  "id" | "name" | "tag" | "objective" | "valueAtRisk" | "policy" | "tools"
>;

export type StreamTerminal = "completed" | "refused";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function isProviderStatus(value: unknown): value is ProviderStatus {
  if (!isRecord(value)) return false;
  const validMode = (mode: unknown) =>
    mode === "demo" || mode === "live" || mode === "fallback";
  return validMode(value.everos) && validMode(value.snowflake) && typeof value.message === "string";
}

function isScenarioSummary(value: unknown): value is ScenarioSummary {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.tag === "string" &&
    typeof value.objective === "string" &&
    typeof value.valueAtRisk === "number" &&
    typeof value.policy === "string" &&
    Array.isArray(value.tools);
}

function isRunEventEnvelope(value: unknown): value is RunEvent {
  return isRecord(value) &&
    typeof value.type === "string" &&
    typeof value.phase === "string" &&
    typeof value.progress === "number" &&
    Number.isFinite(value.progress) &&
    typeof value.message === "string";
}

async function readError(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof payload?.error === "string" ? payload.error : fallback;
}

export async function getAppData() {
  const [healthResponse, scenariosResponse] = await Promise.all([
    fetch("/api/health", { headers: { Accept: "application/json" } }),
    fetch("/api/scenarios", { headers: { Accept: "application/json" } }),
  ]);

  if (!healthResponse.ok || !scenariosResponse.ok) {
    throw new Error("TokenOS compiler is not reachable.");
  }

  const health = (await healthResponse.json()) as unknown;
  const scenarioPayload = (await scenariosResponse.json()) as unknown;

  if (!isRecord(health) || health.ok !== true || !isProviderStatus(health.providers)) {
    throw new Error("The compiler health response is invalid.");
  }
  if (!Array.isArray(scenarioPayload) || !scenarioPayload.every(isScenarioSummary)) {
    throw new Error("The compiler scenario response is invalid.");
  }

  return { providers: health.providers, scenarios: scenarioPayload };
}

export async function streamRun(
  input: RunRequest,
  onEvent: (event: RunEvent) => void,
): Promise<StreamTerminal> {
  const response = await fetch("/api/run", {
    method: "POST",
    headers: {
      Accept: "application/x-ndjson, application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(await readError(response, `Compiler returned ${response.status}.`));
  }
  if (!response.body) throw new Error("The compiler stream is unavailable.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal: StreamTerminal | null = null;
  let lineNumber = 0;

  const processLine = (line: string) => {
    if (!line.trim()) return;
    lineNumber += 1;
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      throw new Error(`The compiler sent invalid stream data on line ${lineNumber}.`);
    }
    if (!isRunEventEnvelope(payload)) {
      throw new Error(`The compiler sent an invalid event on line ${lineNumber}.`);
    }

    const event = {
      ...payload,
      progress: Math.min(1, Math.max(0, payload.progress)),
    } as RunEvent;
    onEvent(event);
    if (event.type === "ledger.completed") terminal = "completed";
    if (event.type === "run.error") terminal = "refused";
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    lines.forEach(processLine);
    if (done) break;
  }

  processLine(buffer);
  if (!terminal) throw new Error("The compiler stream ended before a final result was recorded.");
  return terminal;
}
