import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  type LocalRunEvidence,
  persistLocalRun,
  readLearnedMemorySignals,
  resetMemoryLedger,
} from "./ledger.ts";

const originalPath = process.env.TOKENOS_LEDGER_PATH;
const temporaryDirectories: string[] = [];

function evidence(runId: string, policyPassed = true): LocalRunEvidence {
  return {
    runId,
    createdAt: "2026-08-07T18:00:00.000Z",
    scenarioId: "incident",
    objective: "Investigate checkout latency safely.",
    selectedMemoryIds: ["inc-policy-1", "inc-episode-1", "inc-case-1", "inc-profile-2"],
    allMemoryIds: ["inc-policy-1", "inc-episode-1", "inc-case-1", "inc-profile-2", "noise"],
    selectedMemoryTokens: 233,
    uncontrolledMemoryTokens: 1015,
    uncontrolledInputTokens: 1400,
    governedInputTokens: 620,
    tokenReduction: 0.557,
    policyPassed,
    requiredFactsPreserved: policyPassed,
    measurementEstimated: false,
    lesson: "The four-memory incident portfolio was sufficient.",
  };
}

afterEach(async () => {
  resetMemoryLedger();
  if (originalPath === undefined) delete process.env.TOKENOS_LEDGER_PATH;
  else process.env.TOKENOS_LEDGER_PATH = originalPath;
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

test("the local ledger appends compact A/B evidence to a private JSONL file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tokenos-ledger-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "runs.jsonl");
  process.env.TOKENOS_LEDGER_PATH = path;

  const result = await persistLocalRun(evidence("run-1"));
  const stored = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

  assert.equal(result.mode, "disk");
  assert.equal(result.entryId, "run-1");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].tokenReduction, 0.557);
  assert.deepEqual(stored[0].selectedMemoryIds, evidence("run-1").selectedMemoryIds);
});

test("successful local cases become historical bid signals on the next task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tokenos-learning-test-"));
  temporaryDirectories.push(directory);
  process.env.TOKENOS_LEDGER_PATH = join(directory, "runs.jsonl");

  await persistLocalRun(evidence("run-1"));
  await persistLocalRun(evidence("run-2"));
  await persistLocalRun(evidence("unsafe-run", false));
  const signals = await readLearnedMemorySignals("incident");

  assert.equal(signals.length, 2);
  assert.deepEqual(signals.map((signal) => signal.runId), ["run-1", "run-2"]);
  assert.equal(signals.at(-1)?.occurrences, 2);
  assert.ok(signals.every((signal) => signal.memoryIds.includes("inc-case-1")));
});

test("the evidence ledger still works in explicitly ephemeral demo mode", async () => {
  process.env.TOKENOS_LEDGER_PATH = ":memory:";
  const result = await persistLocalRun(evidence("memory-run"));
  const signals = await readLearnedMemorySignals("incident");

  assert.equal(result.mode, "memory");
  assert.equal(signals[0].runId, "memory-run");
});
