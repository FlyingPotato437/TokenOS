# TokenOS judge Q&A

## Why is this not just RAG?

RAG ranks memories by relevance to a query. TokenOS selects a portfolio by economic value under hard safety and token constraints. It evaluates how memories interact, pins policy, refuses unsafe budgets, and proves the result with a same-Raven A/B comparison and ablations.

## Why not use top-k embeddings?

Top-k treats each item independently. It can buy several duplicates, miss a dependency, or include a stale contradiction. TokenOS scores the whole set: duplicate and contradiction penalties, complement lift, dependency feasibility, required-fact coverage, and marginal value per token.

## How is memory utility measured?

Each candidate starts with task relevance, token cost, source confidence, recency, expected outcome lift, and required-fact coverage. Historical lift can come from a prior related agent case. Portfolio-level relationship effects are then applied. TokenOS explains the final marginal quality change per 1,000 tokens by comparing the chosen set with the same set plus or minus that memory.

## What if TokenOS removes something important?

Policies and required facts are hard constraints, not soft ranking features. A portfolio that drops one is infeasible. TokenOS also ablates purchased memories after execution; removing the pinned incident policy visibly fails the safety proof.

## How are safety policies protected?

Safety-critical memories are pinned. TokenOS computes the smallest portfolio that still contains pinned policy, required facts, and valid dependencies. If the requested token budget is below that floor, the compiler refuses before Raven executes and returns the exact safe budget.

## Why EverOS?

EverOS supplies persistent user memories and Raven agent cases instead of a static demo-only document corpus. TokenOS can write a successful governed outcome back as an agent case and surface historical lift on a related run. Provider labels distinguish live EverOS, mixed live-plus-workspace provenance, and local replay.

## Why Raven?

TokenOS is agent-agnostic; Raven is the agent execution service implemented for this hackathon build. TokenOS governs which EverOS memories reach that service. The live adapter invokes Raven directly and accepts measured token usage only from Raven telemetry; deterministic replay keeps the same contract testable without external credentials. Supporting another agent runtime would require an adapter that preserves the same fixed-contract and usage-reporting guarantees, not a rewrite of the compiler.

## Why must both runs use the same Raven contract?

Otherwise token or outcome differences could come from a different model, tool set, task, runtime, temperature, or output limit. Holding those constant isolates memory context as the independent variable.

## How do you know a rejected memory did not matter?

TokenOS removes a rejected irrelevant control from the all-memory baseline and reruns the evaluation. No material answer, safety, fact-coverage, or expected-quality change is evidence that the memory did not earn its token cost for this task.

## What happens when the memory budget is too small?

Compilation stops before Raven. The API returns a typed safe-budget refusal with the requested budget, computed minimum-safe budget, and missing policy memory IDs. The UI can apply the returned floor and safely rerun with one click.

## Does the system learn over time?

In a bounded, explicit way. A successful outcome is stored as an EverOS agent case, or locally in replay, and a related future run can receive historical outcome lift. The current build does not retrain a model, run reinforcement learning, or autonomously rewrite its scoring function.

## Which results are live?

The interface labels EverOS and Raven independently. Credentials alone enable nothing: each provider also needs its explicit `live` mode. Replay usage is deterministic and marked estimated. Raven usage is called measured/live only when the CLI completes and its isolated trace supplies input, output, and total tokens.

## How are contradictions and dependencies handled?

A selected contradiction adds a portfolio penalty and is explicitly labeled; a contradiction against pinned policy should lose to the policy-safe set. A memory with an unmet `depends_on` edge makes its portfolio infeasible. Complement pairs add lift, while duplicate pairs add redundancy penalty.

## Why exhaustive search?

The incident demo deliberately uses 15 candidates, making all 32,768 subsets cheap to enumerate and easy to audit. It proves the objective and constraints without hiding solver behavior. A larger deployment would use branch-and-bound or an integer solver behind the same contract; that scaling work is future scope.

## What are the strongest results?

Not that the algorithm is clever. The uncontrolled result succeeds; the governed result also succeeds; governed input is smaller; the safety-critical memory proves necessary; and a rejected control proves unnecessary.

## What is the long-term product vision?

Persistent agent memory becomes a managed economic resource. Teams can set memory budgets and safety contracts, audit what every run purchased, and improve future portfolio value using outcome evidence—without changing the agent runtime or surrendering policy control.
