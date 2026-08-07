# TokenOS judge question guide

## Why is this not just RAG?

RAG ranks memories for relevance. TokenOS treats relevance as one signal, then optimizes the value of a complete memory portfolio under token, cost, quality, policy, fact, dependency, region, and latency constraints. It also proves the result against a same-model full-context baseline and with ablations.

## Why not top-k embeddings?

Top-k scores items independently and fixes the number selected. It does not know that two high-ranked memories duplicate each other, that an item contradicts policy, that one memory depends on another, or that a lower-ranked item supplies a required fact. TokenOS evaluates those interactions and allows the economic contract to determine portfolio size.

## How is utility measured?

The current compiler combines configured relevance, confidence, recency, historical success lift, fact coverage, and relationship effects. It applies diminishing returns to aggregate lift. Displayed utility per 1,000 tokens is a local counterfactual difference: compare the selected plan with the same memory removed, or with a rejected memory added.

## What if TokenOS removes something important?

Safety-critical memories are pinned, required facts and dependencies are hard feasibility checks, and the selected plan is evaluated after execution. The pinned-memory ablation intentionally removes the safety policy and must fail, demonstrating that the evaluator detects the unsafe context.

## How are safety policies protected?

A portfolio missing any `policyCritical` memory is rejected with a `memory policy` blocker. The evaluator independently checks that critical memory survived. If the budget is too small to include a safe plan, TokenOS refuses the run and reports the minimum safe token budget and cost.

## Why EverOS?

EverOS supplies the persistent-memory boundary: hybrid retrieval of profile and episodic context before compilation, plus writeback of the optimized interaction after the run. TokenOS adds the economic selection layer between memory retrieval and inference.

## Why Snowflake?

Snowflake Cortex provides the controlled inference target, while the SQL API stores an auditable record of plans, usage, evaluations, and counterfactuals close to enterprise data. The system also works without credentials so judges can separate compiler behavior from provider availability.

## Why is using the same model important?

It isolates memory selection as the experimental variable. If the optimized run used a smaller model, lower cost would not prove that memory compilation caused the savings.

## How do you know a rejected memory did not matter?

The rejected-control ablation removes an irrelevant memory from the full baseline and reruns the same model. TokenOS checks policy, required facts, answer change, and expected quality delta. The smoke test requires no material outcome change.

## What happens when the memory budget is too small?

The compiler does not call inference with an unsafe context. It emits `run.error` with the full compile evidence, including the minimum safe memory-token budget and cost.

## Does it learn over time?

Not in this hackathon build. The scores are deterministic inputs. TokenOS writes interactions and evidence that could later calibrate outcome lift, but there is no automatic learning loop or reinforcement learning in the repository today.

## Which results are live?

The UI exposes provider badges, while API evidence includes the provider and comparison measurement modes. `live` Cortex results use provider-returned token counts when available; `demo` uses deterministic replay and estimated usage; `fallback` means a live provider was configured but the run used deterministic fallback. The SQL ledger independently reports `snowflake`, `local`, or `fallback`.

## How are contradictions and dependencies handled?

Selecting both sides of a contradiction adds a quality penalty. A selected memory missing a declared dependency makes the portfolio infeasible. Duplicate pairs are penalized, while complementary pairs receive a lift.

## What is the long-term vision?

Use accumulated ledger evidence to calibrate memory value for specific tasks, teams, and policies, then manage memory like a portfolio with measurable return. That calibration loop is a product direction, not a feature claimed by the current implementation.
