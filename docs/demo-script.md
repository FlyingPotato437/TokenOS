# Three-minute TokenOS judging script

Before presenting, run `npm run smoke`. For claims of actual provider usage, also confirm the product's Snowflake badge shows `live` and the API evidence reports comparison measurement mode `live` with `usage.estimated: false`. If it shows `demo` or `fallback`, call the numbers deterministic replay estimates, not live Cortex measurements.

## Spoken script

### 0:00 to 0:25 | The problem

“Persistent agents get more expensive as memory grows. Traditional retrieval asks which memories look relevant. TokenOS asks: what is the cheapest safe combination of memories that still produces the right decision?

Today’s case: checkout latency is back. Investigate it, but do not restart during business hours.”

### 0:25 to 0:55 | Full-memory baseline

“I’ll run one controlled experiment. EverOS returns 15 candidates; the baseline sends all 15 to Snowflake Cortex.

Both runs use the same task, model, temperature, completion limit, and tools. Only memory context changes, so savings cannot be attributed to model switching.”

### 0:55 to 1:30 | Compiled memory auction

“TokenOS pins the safety policy and required facts. Then optional memories compete on marginal outcome value per token.

The graph catches duplicates, contradictions, dependencies, and complements. Here, stale restart advice contradicts the pinned policy. The compiler evaluates all 32,768 portfolios, rejects unsafe or infeasible sets, and purchases the best plan under this contract.”

### 1:30 to 1:55 | Measured reduction

“The baseline used [read baseline prompt tokens] prompt tokens and cost [read baseline cost]. The optimized run used [read optimized prompt tokens] and cost [read optimized cost]: [read token reduction] fewer tokens and [read cost reduction] lower Cortex cost.

The answer remains visible, but the proof is economic: both runs succeed, the optimized run is cheaper, and required facts survive.”

### 1:55 to 2:20 | Pinned-policy ablation

“TokenOS reruns the same model without the pinned no-restart policy. The safety proof fails. This memory earned its place because removing it changes whether the plan is safe.”

### 2:20 to 2:40 | Rejected-memory control

“Now the control: remove an irrelevant rejected memory from the full baseline. Policy and facts still pass, and the outcome does not materially change. We did not just label it unnecessary; we tested its removal.”

### 2:40 to 3:00 | Evidence ledger and close

“Finally, Snowflake records memory decisions, token and cost measurements, safety checks, generation settings, and all three counterfactuals. That is an auditable receipt for every memory purchase. Today TokenOS logs evidence; automatic learning is future work.

Every memory has a token price. TokenOS buys only the memories that change the answer.”

## Submission copy

### One-line pitch

TokenOS is an Economic Memory Compiler that buys the smallest safe memory portfolio and proves the savings with same-model execution and counterfactual evidence.

### Short hackathon description

Persistent agents become more expensive as their memory grows. TokenOS sits between EverOS and Snowflake Cortex to evaluate each memory as an economic asset, pin safety-critical context, and search 32,768 portfolios for the cheapest safe combination. It compares a full-memory baseline with an optimized run using the same model, task, generation settings, and tools; verifies required facts and policy; runs three counterfactual ablations; and records the evidence in Snowflake. Credential-free demo mode is deterministic and clearly labeled, while live Cortex mode records provider-reported token usage and calculated request cost.
