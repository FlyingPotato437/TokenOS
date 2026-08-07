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

export async function getAppData() {
  const [healthResponse, scenariosResponse] = await Promise.all([
    fetch("/api/health"),
    fetch("/api/scenarios"),
  ]);

  if (!healthResponse.ok || !scenariosResponse.ok) {
    throw new Error("TokenOS compiler is not reachable.");
  }

  const health = (await healthResponse.json()) as {
    ok: boolean;
    providers: ProviderStatus;
  };
  const scenarios = (await scenariosResponse.json()) as ScenarioSummary[];
  return { providers: health.providers, scenarios };
}

export async function streamRun(
  input: RunRequest,
  onEvent: (event: RunEvent) => void,
) {
  const response = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Compiler returned ${response.status}.`);
  }

  if (!response.body) throw new Error("The compiler stream is unavailable.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent(JSON.parse(line) as RunEvent);
    }

    if (done) break;
  }

  if (buffer.trim()) onEvent(JSON.parse(buffer) as RunEvent);
}
