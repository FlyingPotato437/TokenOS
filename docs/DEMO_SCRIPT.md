# TokenOS: three-minute demonstration

Use the production-incident scenario. Before presenting, confirm the provider chips say either `replay` or `live` and use the matching words below. Never describe estimated replay usage as live measurement.

## 0:00–0:25 — The growing-memory problem

**Show:** The objective and the 15-memory recall count.

**Say:** “Persistent agents get more useful as memory accumulates, but every remembered episode, policy, and case can be sent back through the model again. Traditional retrieval optimizes for relevance. TokenOS asks a harder economic question: which memories are worth paying for on this decision, without removing anything required for safety? This demo uses EverOS for memory and Raven as the agent execution service.”

## 0:25–0:50 — Run uncontrolled Raven

**Show:** Start the normal production-incident run, then point to the uncontrolled side of the A/B comparison.

**Say:** “This is uncontrolled Raven. It receives all 15 recalled memories. Raven’s runtime, model, tools, task, temperature, and output limit are now locked for both sides of the experiment. The dashboard records input, output, and total tokens. Today’s provider label is **[read `replay` or `live`]**, so these numbers are **[estimated deterministically / measured from Raven telemetry]**.”

## 0:50–1:20 — Compile the memory portfolio

**Show:** The 32,768 evaluated portfolios, four purchased memories, pinned policy, and rejected-memory ledger.

**Say:** “TokenOS prices all 15 memories and searches all 32,768 possible portfolios. The normal governed contract buys four. The business-hours restart policy is pinned; required incident facts survive; a complementary memory earns extra value. Duplicate, contradictory, stale, irrelevant, and low-value memories lose the auction. This is set optimization, not top-k retrieval.”

Open the full memory ledger. Point to one duplicate, the contradictory old runbook, and one irrelevant event. Close it.

## 1:20–1:45 — Run governed Raven and read the proof

**Show:** The governed result and controlled-comparison invariants.

**Say:** “Governed Raven sees only the four purchased memories. It returns the same safe decision with **[read governed input tokens]** input tokens instead of **[read uncontrolled input tokens]**—an exact displayed reduction of **[read percentage]**. Every comparison invariant is true. Only memory context changed.”

The answer can remain visible, but point to token reduction and required-facts preservation first.

## 1:45–2:05 — Prove necessary and unnecessary memory

**Show:** Counterfactual ablations.

**Say:** “A lower token count alone is not enough. When TokenOS removes the pinned restart policy, the safety proof fails. When it removes a rejected irrelevant control from the full-memory baseline, the outcome does not materially change. Critical memories prove necessary; rejected memories prove unnecessary.”

## 2:05–2:30 — Refuse an unsafe budget and recover

**Show:** Enter a budget below the displayed minimum and run. Confirm the trace contains no Raven-start event. Click the action that applies the returned safe floor, then rerun.

**Say:** “Now I force the memory budget below the provable floor. TokenOS refuses before Raven executes and returns the computed minimum-safe budget: **[read token floor]**. This is a typed refusal, not a crash. One click applies that exact floor; the rerun succeeds safely.”

## 2:30–2:48 — Close the learning loop

**Show:** The learning receipt. Switch to or submit the related follow-up task and show the learned Raven case with historical outcome lift.

**Say:** “The successful governed outcome becomes an EverOS Raven agent case. In replay it is persisted to the local learning store and labeled local. On this related task, the case returns with explicit historical outcome lift. TokenOS is reusing measured evidence; it is not pretending to retrain the model.”

## 2:48–3:00 — Evidence ledger and close

**Show:** Open the execution trace and the persisted run ledger entry. Point to provider labels, the fixed execution contract, both token records, safety checks, ablations, and learning receipt. Close on the A/B summary.

**Say:** “The ledger makes every claim auditable after the demo: what Raven saw, what TokenOS bought, what it rejected, which mode ran, and what happened next.”

End with this exact line:

“Every memory has a token price. TokenOS buys only the memories that change the answer.”
