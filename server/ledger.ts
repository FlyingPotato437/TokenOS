import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { LocalRunLedgerStatus } from "../shared/raven-contract.ts";
import type { LearnedMemorySignal } from "./everos.ts";

export type LocalRunEvidence = {
  runId: string;
  createdAt: string;
  scenarioId: string;
  objective: string;
  selectedMemoryIds: string[];
  allMemoryIds: string[];
  selectedMemoryTokens: number;
  uncontrolledMemoryTokens: number;
  uncontrolledInputTokens: number;
  governedInputTokens: number;
  tokenReduction: number;
  policyPassed: boolean;
  requiredFactsPreserved: boolean;
  measurementEstimated: boolean;
  lesson: string;
};

const memoryEntries: LocalRunEvidence[] = [];

export function ledgerPath() {
  const configured = process.env.TOKENOS_LEDGER_PATH?.trim() || ".tokenos/run-ledger.jsonl";
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

function validEntry(value: unknown): value is LocalRunEvidence {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LocalRunEvidence>;
  return Boolean(
    candidate.runId &&
    candidate.scenarioId &&
    Array.isArray(candidate.selectedMemoryIds) &&
    typeof candidate.policyPassed === "boolean" &&
    typeof candidate.requiredFactsPreserved === "boolean",
  );
}

async function diskEntries() {
  try {
    const contents = await readFile(ledgerPath(), "utf8");
    return contents
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return validEntry(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code === "ENOENT") return [];
    throw error;
  }
}

function uniqueEntries(entries: LocalRunEvidence[]) {
  const byRunId = new Map<string, LocalRunEvidence>();
  entries.forEach((entry) => byRunId.set(entry.runId, entry));
  return [...byRunId.values()];
}

export async function readLearnedMemorySignals(scenarioId: string): Promise<LearnedMemorySignal[]> {
  let stored: LocalRunEvidence[] = [];
  try {
    stored = await diskEntries();
  } catch {
    // The in-memory index remains available if local disk access fails.
  }
  const successful = uniqueEntries([...stored, ...memoryEntries]).filter(
    (entry) =>
      entry.scenarioId === scenarioId &&
      entry.policyPassed &&
      entry.requiredFactsPreserved,
  );
  return successful.map((entry, index) => ({
    runId: entry.runId,
    memoryIds: entry.selectedMemoryIds,
    occurrences: successful
      .slice(0, index + 1)
      .filter((candidate) => candidate.selectedMemoryIds.some((id) => entry.selectedMemoryIds.includes(id)))
      .length,
  }));
}

export async function persistLocalRun(entry: LocalRunEvidence): Promise<LocalRunLedgerStatus> {
  memoryEntries.unshift(entry);
  memoryEntries.splice(50);
  if (process.env.TOKENOS_LEDGER_PATH === ":memory:") {
    return {
      mode: "memory",
      entryId: entry.runId,
      path: "in-process memory",
      detail: "A/B evidence and the successful memory portfolio were retained in the process learning ledger.",
    };
  }
  try {
    const path = ledgerPath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    return {
      mode: "disk",
      entryId: entry.runId,
      path,
      detail: "A/B evidence and the successful memory portfolio were appended to the local TokenOS ledger.",
    };
  } catch (error) {
    return {
      mode: "memory",
      entryId: entry.runId,
      path: "in-process memory",
      detail: `The disk ledger was unavailable, so evidence remains in memory: ${error instanceof Error ? error.message : "write failed"}.`,
    };
  }
}

export function resetMemoryLedger() {
  memoryEntries.splice(0);
}
