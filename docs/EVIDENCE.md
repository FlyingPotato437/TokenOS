# Evidence contract

TokenOS separates optimizer proof, execution measurement, and learning evidence so a replay cannot be mistaken for a live-provider result.

## Local run ledger

The default path is `.tokenos/run-ledger.jsonl`, configurable with `TOKENOS_LEDGER_PATH`. The server appends one UTF-8 JSON object followed by a newline for every completed run. The evidence and historical-lift signal survive a server restart. Set the variable to `:memory:` for isolated tests that must not write to disk.

Each entry is the compact durable learning/evidence record:

```text
runId, scenarioId, objective, createdAt
selectedMemoryIds, allMemoryIds
selectedMemoryTokens, uncontrolledMemoryTokens
uncontrolledInputTokens, governedInputTokens, tokenReduction
policyPassed, requiredFactsPreserved, measurementEstimated
lesson
```

The ledger stores the replay/live label next to the evidence it qualifies. Moving a replay file does not make it live evidence.

## Historical-lift reuse

The same run ledger is the replay learning store. TokenOS reads successful entries for the related scenario, identifies memory IDs in previously sufficient portfolios, and applies a bounded historical outcome lift on the next compilation. This is evidence reuse, not model weights.

## Execution measurement

### Replay

Replay answers and usage are deterministic. Usage values are estimates and carry `estimated: true`. Replay proves control flow, exact compilation, refusal behavior, A/B invariants, evaluator behavior, persistence, and learning-contract behavior.

### Live Raven

TokenOS creates an isolated Raven trace directory for each invocation and runs Raven with the fixed execution contract. A live variant must have input, output, and total tokens from the new LLM trace, or from an explicitly compatible structured wrapper response, and carries `estimated: false`. Missing or malformed usage cannot be silently converted into a live estimate.

### Mixed provider runs

EverOS and Raven labels are independent, and credentials do not override their explicit mode switches. Live EverOS with replay Raven is a mixed run. Local recall with live Raven is also a mixed run. Live retrieval supplemented with workspace safety anchors is labeled mixed provenance. The health endpoint and final run record preserve these labels.

## Unsafe-budget evidence

An unsafe request is not written as a completed execution. Compilation returns:

```text
kind: safe_budget_refusal
requestedBudget
minimumSafeBudget
missingPolicyMemoryIds
missingRequiredFacts
minimumSafeMemoryIds
message
```

The stream reaches `compile.refused` and then terminates without a Raven-start event. Applying `minimumSafeBudget` creates a new request; the successful rerun receives its own run ID and ledger entry.
