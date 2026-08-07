import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowClockwise,
  ArrowRight,
  Bird,
  Brain,
  CaretDown,
  Check,
  CheckCircle,
  CirclesThreePlus,
  FileText,
  GitBranch,
  Lightning,
  LinkSimple,
  LockKey,
  Play,
  Receipt,
  ShieldCheck,
  Sparkle,
  StackSimple,
  TrendDown,
  Warning,
} from "@phosphor-icons/react";
import { scenarios as localScenarios } from "../shared/catalog";
import type {
  CompileResult,
  CounterfactualResult,
  Evaluation,
  MemoryCandidate,
  Strategy,
} from "../shared/contracts";
import type {
  MemoryAuctionCandidate,
  RavenComparison,
  RavenProviderStatus,
  RavenRunEvent,
  RavenRunResult,
  SafeBudgetRefusal,
} from "../shared/raven-contract";
import { getAppData, streamRun, type ScenarioSummary } from "./api";

type RunState = "idle" | "running" | "complete" | "refused" | "error";

const fallbackScenarios: ScenarioSummary[] = localScenarios.map(
  ({ id, name, tag, objective, policy, tools }) => ({ id, name, tag, objective, policy, tools }),
);

const defaultProviders: RavenProviderStatus = {
  everos: "replay",
  raven: "replay",
  message: "EverOS retrieval and Raven execution are available as deterministic replay.",
};

const pipeline = [
  { id: "recall", label: "Recall", detail: "Retrieve candidates", icon: Brain },
  { id: "price", label: "Measure", detail: "Count memory tokens", icon: Lightning },
  { id: "connect", label: "Connect", detail: "Find conflicts + duplicates", icon: LinkSimple },
  { id: "compile", label: "Select", detail: "Build smallest safe context", icon: CirclesThreePlus },
  { id: "execute", label: "Execute", detail: "Agent A/B via Raven", icon: Bird },
  { id: "learn", label: "Learn", detail: "Write agent case", icon: Sparkle },
] as const;

const decisionOrder = [
  "pinned",
  "learned_case",
  "dependency",
  "complement",
  "selected",
  "redundant",
  "contradiction",
  "stale",
  "irrelevant",
  "low_value",
] as const;

type DisplayDecision = (typeof decisionOrder)[number];

const decisionLabels: Record<DisplayDecision, string> = {
  pinned: "Required · included",
  learned_case: "Past case · included",
  dependency: "Required by another memory",
  complement: "Useful with another memory",
  selected: "Included",
  redundant: "Excluded · duplicate",
  contradiction: "Excluded · conflicts",
  stale: "Excluded · outdated",
  irrelevant: "Excluded · low task match",
  low_value: "Excluded · small expected benefit",
};

const strategyLabels: Record<Strategy, string> = {
  economy: "Smallest context",
  balanced: "Balanced",
  quality: "Highest expected quality",
};

const scenarioQualityFloors: Record<string, number> = {
  incident: 0.9,
  support: 0.88,
  fraud: 0.88,
};

const whole = (value: number) => Math.round(value).toLocaleString();
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

function providerCopy(label: "EverOS" | "Raven", mode: RavenProviderStatus["everos"]) {
  if (mode === "live") return `${label} live`;
  if (mode === "mixed") return `${label} mixed`;
  return `${label} replay`;
}

function plainEventMessage(message: string) {
  return message
    .replace("total memory tokens priced", "candidate memory tokens counted")
    .replace("portfolios evaluated", "memory combinations tested")
    .replace("memories purchased for Raven", "memories selected for Raven context")
    .replace("compiled a safe Raven context", "selected a safe Raven context");
}

function ProviderBadge({
  label,
  mode,
}: {
  label: "EverOS" | "Raven";
  mode: RavenProviderStatus["everos"];
}) {
  return (
    <span className={`provider-badge ${mode}`} title={`${label} mode: ${mode}`}>
      <span className="provider-dot" aria-hidden="true" />
      {providerCopy(label, mode)}
    </span>
  );
}

function StageHeading({
  number,
  eyebrow,
  title,
  children,
}: {
  number: string;
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="stage-heading">
      <span className="stage-number">{number}</span>
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p>{children}</p>
      </div>
    </div>
  );
}

function PipelineRail({ events, status }: { events: RavenRunEvent[]; status: RunState }) {
  const latest = events.at(-1);
  const completedTypes = new Set(events.map((event) => event.type));
  const completedByPhase: Record<(typeof pipeline)[number]["id"], boolean> = {
    recall: completedTypes.has("recall.completed"),
    price: completedTypes.has("price.completed"),
    connect: completedTypes.has("connect.completed"),
    compile: completedTypes.has("compile.completed") || completedTypes.has("compile.refused"),
    execute: completedTypes.has("comparison.completed"),
    learn: completedTypes.has("learn.completed") || completedTypes.has("run.completed"),
  };
  const refusalIndex = pipeline.findIndex((phase) => phase.id === "compile");

  return (
    <div className="pipeline-wrap" aria-live="polite" aria-busy={status === "running"}>
      <div className="pipeline-progress" aria-hidden="true">
        <span style={{ width: `${(latest?.progress ?? 0) * 100}%` }} />
      </div>
      <ol className="pipeline-rail">
        {pipeline.map(({ id, label, detail, icon: Icon }, index) => {
          const event = [...events].reverse().find((item) => item.phase === id);
          const complete = completedByPhase[id];
          const active = latest?.phase === id && !complete && status === "running";
          const blocked = status === "refused" && index > refusalIndex;
          return (
            <li
              className={`${complete ? "complete" : ""} ${active ? "active" : ""} ${blocked ? "blocked" : ""}`}
              key={id}
            >
              <span className="pipeline-icon">
                {complete ? <Check size={16} weight="bold" /> : <Icon size={18} weight="bold" />}
              </span>
              <div>
                <span className="pipeline-index">0{index + 1}</span>
                <strong>{label}</strong>
                <small>{blocked ? "Not called" : event?.message ? plainEventMessage(event.message) : detail}</small>
              </div>
            </li>
          );
        })}
      </ol>
      {!events.length && (
        <div className="pipeline-empty">
          <Play size={18} weight="fill" /> The trace will populate when the TokenOS proof starts.
        </div>
      )}
    </div>
  );
}

type RunFact = {
  id: string;
  label: string;
  value: string;
  detail: string;
  tone?: "accent" | "safe";
};

function eventPayload<T>(events: RavenRunEvent[], type: RavenRunEvent["type"]) {
  return events.find((event) => event.type === type)?.data as T | undefined;
}

function PhaseAnimation({
  phase,
  compile,
  comparison,
}: {
  phase: RavenRunEvent["phase"] | "idle";
  compile: CompileResult | null;
  comparison: RavenComparison | null;
}) {
  if (phase === "recall") {
    return <div className="phase-animation memory-particles" aria-hidden="true">{Array.from({ length: 12 }, (_, index) => <i key={index} />)}</div>;
  }
  if (phase === "price") {
    return <div className="phase-animation price-bars" aria-hidden="true">{[42, 78, 55, 91, 36, 66].map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>;
  }
  if (phase === "connect") {
    return <div className="phase-animation relation-map" aria-hidden="true"><i /><i /><i /><i /><span /><span /><span /></div>;
  }
  if (phase === "compile") {
    const selected = new Set(compile?.selected.memoryIds ?? []);
    const memories = compile?.memories ?? [];
    return (
      <div className="phase-animation portfolio-matrix" aria-hidden="true">
        {Array.from({ length: 20 }, (_, index) => <i className={memories[index] && selected.has(memories[index].id) ? "bought" : ""} key={index} />)}
      </div>
    );
  }
  if (phase === "execute") {
    const uncontrolled = comparison?.uncontrolled.usage.inputTokens ?? 100;
    const governed = comparison?.governed.usage.inputTokens ?? 56;
    return (
      <div className="phase-animation ab-bars" aria-hidden="true">
        <div><span>ALL MEMORY</span><i style={{ width: "100%" }} /><b>{comparison ? whole(uncontrolled) : "…"}</b></div>
        <div><span>TOKENOS</span><i style={{ width: `${Math.max(18, (governed / uncontrolled) * 100)}%` }} /><b>{comparison ? whole(governed) : "…"}</b></div>
      </div>
    );
  }
  if (phase === "learn") {
    return <div className="phase-animation learning-loop" aria-hidden="true"><span>OUTCOME</span><i>→</i><strong>CASE</strong><i>→</i><span>NEXT RUN</span></div>;
  }
  return <div className="phase-animation ready-pulse" aria-hidden="true"><i /><i /><i /><strong>READY</strong></div>;
}

function RunSpotlight({
  events,
  status,
  compile,
  comparison,
  result,
  refusal,
  replayMode,
}: {
  events: RavenRunEvent[];
  status: RunState;
  compile: CompileResult | null;
  comparison: RavenComparison | null;
  result: RavenRunResult | null;
  refusal: SafeBudgetRefusal | null;
  replayMode: boolean;
}) {
  const latest = events.at(-1);
  const recall = eventPayload<{ memories?: MemoryCandidate[] }>(events, "recall.completed");
  const pricing = eventPayload<{ totalCandidateTokens?: number; budget?: number }>(events, "price.completed");
  const connected = eventPayload<{ relationshipEdges?: unknown[] }>(events, "connect.completed");
  const uncontrolled = eventPayload<RavenComparison["uncontrolled"]>(events, "uncontrolled.completed");
  const governed = eventPayload<RavenComparison["governed"]>(events, "governed.completed");
  const start = eventPayload<{ runId?: string }>(events, "run.started");
  const activePhase = latest?.phase ?? "idle";
  const pipelinePhase = pipeline.find((item) => item.id === activePhase);
  const facts: RunFact[] = [];

  if (recall?.memories) facts.push({ id: "recall", label: "Candidate memories", value: whole(recall.memories.length), detail: "retrieved for this task" });
  if (pricing?.totalCandidateTokens !== undefined) facts.push({ id: "price", label: "Candidate memory tokens", value: whole(pricing.totalCandidateTokens), detail: `maximum allowed: ${whole(pricing.budget ?? 0)}` });
  if (connected?.relationshipEdges) facts.push({ id: "connect", label: "Relationships resolved", value: whole(connected.relationshipEdges.length), detail: "duplicates, conflicts + dependencies" });
  if (compile?.evaluatedCount) facts.push({ id: "search", label: "Portfolios searched", value: whole(compile.evaluatedCount), detail: "exact exhaustive search", tone: "accent" });
  if (compile?.selected.feasible) facts.push({ id: "selected", label: "Memories included", value: `${compile.selected.memoryIds.length}/${compile.memories.length}`, detail: `${whole(compile.selected.memoryTokens)} memory tokens sent`, tone: "accent" });
  if (uncontrolled && !comparison) facts.push({ id: "uncontrolled", label: "All-memory input", value: whole(uncontrolled.usage.inputTokens), detail: `${uncontrolled.memoriesLoaded} memories loaded` });
  if (governed && !comparison) facts.push({ id: "governed", label: "TokenOS input", value: whole(governed.usage.inputTokens), detail: `${governed.memoriesLoaded} included memories` });
  if (comparison) {
    const inputTokensSaved = comparison.uncontrolled.usage.inputTokens - comparison.governed.usage.inputTokens;
    facts.push({
      id: "context-spend",
      label: "Agent input tokens",
      value: `${whole(comparison.uncontrolled.usage.inputTokens)} → ${whole(comparison.governed.usage.inputTokens)}`,
      detail: "same agent runtime · only memory changed",
    });
    facts.push({
      id: "reduction",
      label: comparison.measurementMode === "live" ? "Measured input reduction" : "Estimated input reduction",
      value: percent(comparison.tokenReduction),
      detail: `${whole(inputTokensSaved)} input tokens avoided`,
      tone: "accent",
    });
    facts.push({
      id: "safety",
      label: "Outcome + safety",
      value: comparison.requiredFactsPreserved && comparison.governed.evaluation.policyPassed ? "PASS" : "FAIL",
      detail: "required facts and policy checked",
      tone: comparison.requiredFactsPreserved && comparison.governed.evaluation.policyPassed ? "safe" : undefined,
    });
  }
  if (result) facts.push({ id: "learn", label: "Learning receipt", value: result.learning.written ? "WRITTEN" : "LOCAL", detail: result.learning.agentCaseId, tone: "safe" });

  const headline = status === "idle"
    ? "Ready to select the smallest safe context."
    : status === "complete"
      ? "Safe memory set selected. Comparison complete."
      : status === "refused"
        ? "Budget refused before agent execution."
        : status === "error"
          ? "The proof stopped safely."
          : pipelinePhase?.label ?? "Locking the experiment";
  const supporting = status === "idle"
    ? "Start the comparison to retrieve memories, count their tokens, resolve relationships, select a safe set, run Raven, and record the result."
    : latest?.message ? plainEventMessage(latest.message) : "TokenOS is preparing the run.";

  return (
    <div className={`run-spotlight ${status}`} aria-live="polite" aria-busy={status === "running"}>
      <div className="run-spotlight-topline">
        <span className="run-state"><i />{status === "idle" ? "TOKENOS READY" : status === "running" ? replayMode ? "DEMO RUN" : "LIVE RUN" : status === "complete" ? "COMPARISON COMPLETE" : status.toUpperCase()}</span>
        <span className="run-id">{start?.runId ?? "Run ID assigned on start"}</span>
        <strong>{whole((latest?.progress ?? 0) * 100)}%</strong>
      </div>
      <div className="run-spotlight-grid">
        <div className="active-run-step" key={latest?.type ?? status}>
          <div className="run-scan" />
          <div className="active-step-copy">
            <span>{pipelinePhase ? `STEP 0${pipeline.findIndex((item) => item.id === pipelinePhase.id) + 1} / 06` : "BUDGET-AWARE MEMORY SELECTION"}</span>
            <h3>{headline}</h3>
            <p>{supporting}</p>
            {refusal && <b className="run-safe-floor">Safe floor: {whole(refusal.minimumSafeBudget)} tokens</b>}
          </div>
          <PhaseAnimation phase={activePhase} compile={compile} comparison={comparison} />
        </div>
        <div className="run-fact-stack" aria-label="Evidence from this run">
          {facts.length ? facts.slice(-5).map((fact, index) => (
            <div className={`run-fact ${fact.tone ?? ""}`} style={{ "--fact-index": index } as CSSProperties} key={fact.id}>
              <span>{fact.label}</span><strong>{fact.value}</strong><small>{fact.detail}</small>
            </div>
          )) : (
            <div className="run-facts-empty">
              <span>WHAT WILL APPEAR HERE</span>
              <b>15 candidates → one safe memory set</b>
              <p>The optimizer numbers are computed from your task, budget, and selection priority. Agent usage is labeled live or replay.</p>
            </div>
          )}
        </div>
      </div>
      <PipelineRail events={events} status={status} />
    </div>
  );
}

function formatAnswer(answer: string) {
  const headings = new Set([
    "Recommended next action",
    "Safe execution plan",
    "Operator update",
    "Change from the failed attempt",
    "Customer message",
    "Recommendation",
    "Evidence package",
    "Policy decision",
  ]);
  const lines = answer.split("\n").map((line) => line.trim());
  const output: ReactNode[] = [];
  let bullets: string[] = [];

  const flush = () => {
    if (!bullets.length) return;
    output.push(
      <ul key={`list-${output.length}`}>
        {bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
      </ul>,
    );
    bullets = [];
  };

  lines.forEach((line, index) => {
    if (!line) {
      flush();
      return;
    }
    if (line.startsWith("- ")) {
      bullets.push(line.slice(2));
      return;
    }
    flush();
    const heading = headings.has(line) || (lines[index + 1] === "" && line.length < 44);
    output.push(heading ? <h3 key={`${line}-${index}`}>{line}</h3> : <p key={`${line}-${index}`}>{line}</p>);
  });
  flush();
  return output;
}

function requiredFactsPassed(evaluation: Evaluation) {
  return evaluation.checks.find((check) => check.label === "Required facts")?.passed ?? false;
}

function passCopy(passed: boolean) {
  return <span className={`result-mark ${passed ? "pass" : "fail"}`}>{passed ? "PASS" : "FAIL"}</span>;
}

function ComparisonProof({ comparison }: { comparison: RavenComparison | null }) {
  if (!comparison) {
    return (
      <div className="evidence-empty">
        <TrendDown size={26} />
        <div>
          <strong>No A/B evidence yet.</strong>
          <p>Run the proof to compare the same agent service with all memories versus the TokenOS-governed set.</p>
        </div>
      </div>
    );
  }

  const { uncontrolled, governed } = comparison;
  const savedTokens = uncontrolled.usage.totalTokens - governed.usage.totalTokens;
  const savedInputTokens = uncontrolled.usage.inputTokens - governed.usage.inputTokens;
  const liveMeasurement = comparison.measurementMode === "live";
  const measurement = liveMeasurement ? "LIVE RAVEN USAGE" : "REPLAY · ESTIMATED USAGE";

  return (
    <div className="comparison-proof">
      <div className="reduction-hero">
        <div>
          <span>{liveMeasurement ? "MEASURED RAVEN INPUT-TOKEN REDUCTION" : "ESTIMATED INPUT-TOKEN REDUCTION"}</span>
          <strong>{percent(comparison.tokenReduction)}</strong>
        </div>
        <p><b>{whole(savedInputTokens)}</b> fewer input tokens · {whole(savedTokens)} fewer total tokens.</p>
        <span className="mode-label">{measurement}</span>
      </div>

      <div className="runtime-contract" aria-label="Fixed agent experiment controls">
        <div><LockKey size={17} /><span><b>Same agent service</b>Raven held constant</span></div>
        <div><CheckCircle size={17} /><span><b>Same model</b>{comparison.sameModel ? comparison.executionContract.model : "Changed"}</span></div>
        <div><CheckCircle size={17} /><span><b>Same tools</b>{comparison.sameTools ? `${comparison.executionContract.tools.length} held constant` : "Changed"}</span></div>
        <div><CheckCircle size={17} /><span><b>Same task</b>{comparison.executionContract.taskFingerprint}</span></div>
      </div>

      <div className="table-shell">
        <table className="comparison-table">
          <colgroup><col /><col /><col /></colgroup>
          <thead>
            <tr>
              <th scope="col">Evidence</th>
              <th scope="col">All memory</th>
              <th scope="col">TokenOS governed</th>
            </tr>
          </thead>
          <tbody>
            <tr><th scope="row">Memories loaded</th><td>{whole(uncontrolled.memoriesLoaded)}</td><td className="governed-value">{whole(governed.memoriesLoaded)}</td></tr>
            <tr><th scope="row">Input tokens</th><td>{whole(uncontrolled.usage.inputTokens)}</td><td className="governed-value">{whole(governed.usage.inputTokens)}</td></tr>
            <tr><th scope="row">Output tokens</th><td>{whole(uncontrolled.usage.outputTokens)}</td><td className="governed-value">{whole(governed.usage.outputTokens)}</td></tr>
            <tr className="total-row"><th scope="row">Total tokens</th><td>{whole(uncontrolled.usage.totalTokens)}</td><td className="governed-value">{whole(governed.usage.totalTokens)}</td></tr>
            <tr><th scope="row">Required facts</th><td>{passCopy(requiredFactsPassed(uncontrolled.evaluation))}</td><td>{passCopy(requiredFactsPassed(governed.evaluation))}</td></tr>
            <tr><th scope="row">Policy result</th><td>{passCopy(uncontrolled.evaluation.policyPassed)}</td><td>{passCopy(governed.evaluation.policyPassed)}</td></tr>
          </tbody>
        </table>
      </div>
      <p className="measurement-note">
        {liveMeasurement
          ? "Live result: Raven reported these token counts in its execution trace."
          : "Replay result: Raven was not called. The response and model-token counts are deterministic estimates; TokenOS still ran the real memory-selection, relationship, and safety algorithms."}
      </p>
    </div>
  );
}

function displayDecision(memory: MemoryCandidate): DisplayDecision {
  if (memory.selected && memory.policyCritical) return "pinned";
  if (memory.selected && (memory.type === "agent_case" || memory.type === "agent_skill")) return "learned_case";
  if (memory.selected) return "selected";
  if (memory.decisionCode === "dependency") return "dependency";
  if (memory.decisionCode === "complement") return "complement";
  if (memory.decisionCode === "contradiction") return "contradiction";
  if (memory.decisionCode === "redundant") return "redundant";
  if (memory.decisionCode === "stale") return "stale";
  if (memory.decisionCode === "irrelevant") return "irrelevant";
  return "low_value";
}

function decisionReason(memory: MemoryCandidate, decision: DisplayDecision) {
  if (decision === "pinned") return "A required policy or fact. TokenOS cannot remove it.";
  if (decision === "learned_case") return `A prior successful case with ${percent(memory.relevance)} task match.`;
  if (decision === "selected") return `Expected to help this task enough to justify ${whole(memory.tokens)} context tokens.`;
  if (decision === "dependency") return "Needed by an included memory to remain complete or correct.";
  if (decision === "complement") return "Adds useful evidence when paired with an included memory.";
  if (decision === "redundant") return "Repeats information already supplied by an included memory.";
  if (decision === "contradiction") return "Conflicts with a newer fact or required policy.";
  if (decision === "stale") return "A newer memory supersedes this information.";
  if (decision === "irrelevant") return `Only ${percent(memory.relevance)} match to the current task.`;
  return `Its estimated success gain (${percent(memory.successLift)}) is too small for ${whole(memory.tokens)} context tokens.`;
}

function MemoryTable({ memories }: { memories: MemoryAuctionCandidate[] }) {
  return (
    <div className="table-shell">
      <table className="memory-table">
        <thead>
          <tr>
            <th scope="col">Decision</th>
            <th scope="col">Memory</th>
            <th scope="col">Token size</th>
            <th scope="col">Task match</th>
            <th scope="col">Expected success gain</th>
            <th scope="col">Why</th>
          </tr>
        </thead>
        <tbody>
          {memories.map((memory) => {
            const decision = displayDecision(memory);
            const stale = !memory.selected && (memory.recency ?? 1) < 0.3;
            return (
              <tr key={memory.id}>
                <td data-label="Decision">
                  <span className={`decision-pill ${decision}`}>{decisionLabels[decision]}</span>
                  {stale && decision !== "stale" && <span className="secondary-reason">Also stale</span>}
                </td>
                <td data-label="Memory">
                  <strong>{memory.content}</strong>
                  <small>{memory.type.replace("_", " ")} · {memory.id} · {memory.source}</small>
                </td>
                <td data-label="Token size" className="mono">{whole(memory.tokens)}</td>
                <td data-label="Task match" className="mono">{percent(memory.relevance)}</td>
                <td data-label="Expected success gain" className="mono">{percent(memory.successLift)}</td>
                <td data-label="Why">{decisionReason(memory, decision)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MemorySelectionEvidence({ compile }: { compile: CompileResult | null }) {
  const memories = (compile?.memories ?? []) as MemoryAuctionCandidate[];
  if (!compile) {
    return (
      <div className="evidence-empty">
        <StackSimple size={26} />
        <div><strong>Memory decisions appear after the comparison.</strong><p>Every candidate will show whether it was included, its token size, its task match, and the reason.</p></div>
      </div>
    );
  }

  const selected = memories.filter((memory) => memory.selected);
  const rejected = memories.filter((memory) => !memory.selected);
  const counts = decisionOrder.reduce<Record<DisplayDecision, number>>((output, decision) => {
    output[decision] = memories.filter((memory) => {
      if (decision === "stale") return !memory.selected && (memory.recency ?? 1) < 0.3;
      return displayDecision(memory) === decision;
    }).length;
    return output;
  }, {} as Record<DisplayDecision, number>);

  return (
    <div className="auction-evidence">
      <div className="auction-summary">
        <div><span>Memory combinations tested</span><strong>{whole(compile.evaluatedCount)}</strong></div>
        <div><span>Combinations that passed safety</span><strong>{whole(compile.feasibleCount)}</strong></div>
        <div><span>Memories included</span><strong>{selected.length}</strong></div>
        <div><span>Context tokens sent</span><strong>{whole(compile.selected.memoryTokens)}</strong></div>
      </div>

      <div className="score-explainer" role="note">
        <b>How to read the scores</b>
        <span><strong>Task match</strong> estimates how closely a memory matches this request. <strong>Expected success gain</strong> is the optimizer's configured estimate of how much it could improve the answer. Both are selection inputs—not measured revenue or guaranteed outcomes.</span>
      </div>

      <div className="decision-ledger" aria-label="Memory decision states">
        {decisionOrder.map((decision) => (
          <span className={counts[decision] ? "present" : "absent"} key={decision}>
            <b>{counts[decision]}</b>{decisionLabels[decision]}
          </span>
        ))}
      </div>

      <h3 className="subsection-title">Context sent to Raven</h3>
      <MemoryTable memories={selected} />

      <details className="evidence-disclosure">
        <summary>
          <span><CaretDown size={17} /> Excluded memories and reasons</span>
          <b>{rejected.length} decisions</b>
        </summary>
        <MemoryTable memories={rejected} />
      </details>

      <div className="relationship-evidence">
        <div className="subsection-heading">
          <div><GitBranch size={20} /><h3>Relationship evidence</h3></div>
          <p>Duplicates, conflicts, and dependencies that changed the selected context.</p>
        </div>
        {compile.relationshipEdges.length ? (
          <div className="table-shell">
            <table className="relationship-table">
              <thead><tr><th>Source</th><th>Relationship</th><th>Target</th><th>Strength</th></tr></thead>
              <tbody>
                {compile.relationshipEdges.map((edge, index) => (
                  <tr key={`${edge.sourceId}-${edge.targetId}-${index}`}>
                    <td data-label="Source">{edge.sourceId}</td>
                    <td data-label="Relationship"><span>{edge.type.replace("_", " ")}</span></td>
                    <td data-label="Target">{edge.targetId}</td>
                    <td data-label="Strength" className="mono">{percent(edge.strength)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="inline-empty">No material memory relationships were returned for this task.</p>}
      </div>
    </div>
  );
}

function SafetyInterlock({ refusal }: { refusal: SafeBudgetRefusal }) {
  return (
    <aside className="safety-interlock" role="alert">
      <div className="interlock-icon"><LockKey size={25} weight="bold" /></div>
      <div>
        <span className="interlock-kicker">EXECUTION BLOCKED BEFORE THE AGENT</span>
        <h3>{whole(refusal.requestedBudget)} tokens cannot carry every required fact.</h3>
        <p>Minimum-safe budget: <b>{whole(refusal.minimumSafeBudget)} tokens</b>. The Raven execution service was never called.</p>
      </div>
      <a href="#safety-proof">Review and recover <ArrowRight size={16} /></a>
    </aside>
  );
}

function SafetyProof({
  result,
  refusal,
  budget,
  onApplyFloor,
}: {
  result: RavenRunResult | null;
  refusal: SafeBudgetRefusal | null;
  budget: number;
  onApplyFloor: () => void;
}) {
  if (refusal) {
    const applied = budget >= refusal.minimumSafeBudget;
    return (
      <div className="refusal-proof">
        <div className="refusal-equation">
          <span>Requested</span><b>{whole(refusal.requestedBudget)}</b><i>&lt;</i><span>Minimum safe</span><b>{whole(refusal.minimumSafeBudget)}</b>
        </div>
        <div className="never-called">
          <span>Agent executions</span><strong>0</strong><p>The compile guard refused execution before the Raven service boundary.</p>
        </div>
        {refusal.missingPolicyMemoryIds.length > 0 && (
          <p className="missing-proof"><Warning size={18} /> Missing policy memories: {refusal.missingPolicyMemoryIds.join(", ")}</p>
        )}
        <button className="primary-action floor-action" type="button" onClick={onApplyFloor}>
          <><ShieldCheck size={20} weight="bold" /> APPLY + RERUN {whole(refusal.minimumSafeBudget)}-TOKEN SAFE BUDGET</>
        </button>
        {applied && <p className="recovery-copy">The safe floor is applied; rerun recovery starts automatically.</p>}
      </div>
    );
  }

  if (!result) {
    return (
      <div className="evidence-empty">
        <ShieldCheck size={26} />
        <div><strong>Safety evidence appears after compilation.</strong><p>The guard computes a floor before any agent can execute.</p></div>
      </div>
    );
  }

  const checks = result.comparison.governed.evaluation.checks;
  const replayResult = result.comparison.measurementMode === "replay";
  const pivotal = result.counterfactuals.filter((item) => item.role !== "rejected_control");
  return (
    <div className="safety-proof-grid">
      <div className="safe-floor-proof">
        <span>COMPUTED MINIMUM-SAFE BUDGET</span>
        <strong>{whole(result.compile.minimumSafeMemoryTokens)} <small>memory tokens</small></strong>
        <p>Required policies and facts are included before TokenOS considers any optional memory.</p>
      </div>
      <div className="checks-list">
        {checks.map((check) => (
          <div key={check.label}>
            {check.passed ? <CheckCircle size={18} weight="fill" /> : <Warning size={18} weight="fill" />}
            <span><b>{check.label}</b>{replayResult && check.label === "Policy result" ? check.detail.replace("Raven's answer", "The replayed answer") : replayResult && check.label === "Answer completeness" ? check.detail.replace("Raven returned", "The replay produced") : check.detail}</span>
          </div>
        ))}
      </div>
      <details className="evidence-disclosure counterfactuals">
        <summary><span><CaretDown size={17} /> Required-fact ablation proof</span><b>{result.counterfactuals.length} tests</b></summary>
        <div className="counterfactual-list">
          {(pivotal.length ? pivotal : result.counterfactuals).map((test: CounterfactualResult) => (
            <div key={test.memoryId}>
              <span className={`result-mark ${test.policyPassed && test.requiredFactsPreserved ? "pass" : "fail"}`}>
                {test.outcomeChanged ? "PIVOTAL" : "CONTROL"}
              </span>
              <p><b>{test.memoryId}</b>{test.detail}</p>
              <small>Required facts {test.requiredFactsPreserved ? "preserved" : "failed"} · policy {test.policyPassed ? "passed" : "failed"}</small>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function LearningEvidence({ result }: { result: RavenRunResult | null }) {
  if (!result) {
    return (
      <div className="evidence-empty">
        <Receipt size={26} />
        <div><strong>No learning receipt yet.</strong><p>A successful governed run produces the case and sufficient-memory evidence.</p></div>
      </div>
    );
  }

  const receipt = result.learning;
  const selected = result.compile.memories.filter((memory) => memory.selected);
  const tokensSaved = result.comparison.uncontrolled.usage.totalTokens - result.comparison.governed.usage.totalTokens;
  const receiptLabel = receipt.mode === "everos"
    ? "STORED IN EVEROS"
    : receipt.written
      ? "STORED IN LOCAL LEARNING LEDGER"
      : "LEARNING NOT WRITTEN";
  const storageCopy = receipt.mode === "everos"
    ? "Yes — EverOS"
    : receipt.written
      ? "Yes — local replay ledger"
      : "No";
  const replayResult = result.comparison.measurementMode === "replay";
  const receiptDetail = replayResult && receipt.mode !== "everos"
    ? "Replay outcome recorded in the local learning ledger. No live Raven or EverOS write occurred."
    : receipt.detail;
  return (
    <div className="learning-receipt">
      <div className="receipt-header">
        <div><Receipt size={24} weight="bold" /><span><b>TokenOS learning receipt</b>{new Date(result.createdAt).toLocaleString()}</span></div>
        <span className={`receipt-status ${receipt.mode === "everos" ? "stored" : "staged"}`}>
          {receiptLabel}
        </span>
      </div>
      <dl className="receipt-rows">
        <div><dt>Agent case stored</dt><dd>{storageCopy}</dd></div>
        <div><dt>Case identifier</dt><dd className="mono">{receipt.agentCaseId ?? "Pending"}</dd></div>
        <div><dt>Memories that proved sufficient</dt><dd>{selected.map((memory) => memory.id).join(", ")}</dd></div>
        <div><dt>Outcome score</dt><dd>{percent(result.comparison.governed.evaluation.score)}</dd></div>
        <div><dt>Tokens saved</dt><dd>{whole(tokensSaved)} total tokens</dd></div>
        <div><dt>Historical-outcome signal</dt><dd>{receipt.written ? "Available on the next related run" : "Not available"}</dd></div>
      </dl>
      <p className="receipt-detail"><FileText size={17} /> {receiptDetail}</p>
    </div>
  );
}

function SubsequentRun({ result }: { result: RavenRunResult | null }) {
  if (!result) {
    return (
      <div className="evidence-empty">
        <ArrowClockwise size={26} />
        <div><strong>The next-run signal starts with a successful case.</strong><p>TokenOS can rank a related agent case more highly when it helped a past run succeed.</p></div>
      </div>
    );
  }

  const learned = result.compile.memories.find(
    (memory) => memory.selected && (memory.type === "agent_case" || memory.type === "agent_skill"),
  );
  if (!learned) {
    return <p className="inline-empty">No prior agent case was required for this task; the new receipt remains available for a later related run.</p>;
  }

  const explicitHistoricalLift = learned.historicalOutcomeLift ?? 0;
  return (
    <div className="subsequent-proof">
      <div className="retrieved-case">
        <span><ArrowClockwise size={16} weight="bold" /> RETRIEVED AGENT CASE</span>
        <h3>{learned.content}</h3>
        <p className="mono">{learned.learnedCaseId ?? learned.id}</p>
      </div>
      <div className="value-explanation">
        <span>WHY THIS CASE RANKED HIGHER</span>
        <p>The case matched this task, came from a successful prior outcome, and supplied useful evidence in only <b>{whole(learned.tokens)} tokens</b>.</p>
        <dl>
          <div><dt>Task match</dt><dd>{percent(learned.relevance)}</dd></div>
          <div><dt>Expected success gain</dt><dd>{percent(learned.successLift)}</dd></div>
          <div><dt>Past-result boost</dt><dd>{explicitHistoricalLift > 0 ? percent(explicitHistoricalLift) : "Included in replay fixture"}</dd></div>
          <div><dt>Selection result</dt><dd>Included</dd></div>
        </dl>
      </div>
      <p className="next-run-note">
        {result.learning.mode === "everos"
          ? `The new case ${result.learning.agentCaseId} can receive the same historical-outcome advantage after EverOS consolidation.`
          : result.learning.written
            ? `The local learning ledger will rank related memories more highly on the next run using case ${result.learning.agentCaseId}.`
            : "This panel is a deterministic next-run preview; no learning signal was written."}
      </p>
    </div>
  );
}

function RuntimeTruth({ providers, replayMode }: { providers: RavenProviderStatus; replayMode: boolean }) {
  if (!replayMode) {
    return (
      <aside className="runtime-truth live" aria-label="Runtime authenticity">
        <span className="runtime-truth-state"><CheckCircle size={19} weight="fill" /> LIVE MODE</span>
        <div>
          <strong>Raven is executing and reporting model usage.</strong>
          <p>TokenOS computes the memory set; Raven's trace supplies the displayed input and output token counts. EverOS status: {providers.everos}.</p>
        </div>
      </aside>
    );
  }

  if (providers.everos === "live" || providers.everos === "mixed") {
    return (
      <aside className="runtime-truth partial" aria-label="Runtime authenticity">
        <span className="runtime-truth-state"><Warning size={19} weight="fill" /> PARTIAL LIVE</span>
        <div>
          <strong>EverOS is connected. Raven is still in replay.</strong>
          <p><b>Live now:</b> EverOS API access and memory write-back. <b>Replayed or estimated:</b> Raven's answer and model token usage. A completed run can fall back to replay if EverOS returns no usable memories.</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="runtime-truth replay" aria-label="Runtime authenticity">
      <span className="runtime-truth-state"><Warning size={19} weight="fill" /> DEMO MODE</span>
      <div>
        <strong>Raven and EverOS are not live on this machine.</strong>
        <p><b>Computed now:</b> memory selection, token-budget search, relationships, safety checks, and local learning. <b>Replayed or estimated:</b> EverOS retrieval, Raven's answer, and model token usage.</p>
      </div>
    </aside>
  );
}

export default function App() {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>(fallbackScenarios);
  const [scenarioId, setScenarioId] = useState(fallbackScenarios[0]?.id ?? "incident");
  const [objective, setObjective] = useState(fallbackScenarios[0]?.objective ?? "");
  const [memoryBudget, setMemoryBudget] = useState(360);
  const [strategy, setStrategy] = useState<Strategy>("balanced");
  const [providers, setProviders] = useState<RavenProviderStatus>(defaultProviders);
  const [events, setEvents] = useState<RavenRunEvent[]>([]);
  const [status, setStatus] = useState<RunState>("idle");
  const [compile, setCompile] = useState<CompileResult | null>(null);
  const [comparison, setComparison] = useState<RavenComparison | null>(null);
  const [result, setResult] = useState<RavenRunResult | null>(null);
  const [refusal, setRefusal] = useState<SafeBudgetRefusal | null>(null);
  const [error, setError] = useState("");
  const [connectionNote, setConnectionNote] = useState("");
  const [loadingAppData, setLoadingAppData] = useState(true);
  const runButtonRef = useRef<HTMLButtonElement>(null);
  const runStageRef = useRef<HTMLElement>(null);

  const selectedScenario = useMemo(
    () => scenarios.find((scenario) => scenario.id === scenarioId) ?? scenarios[0],
    [scenarioId, scenarios],
  );
  const qualityFloor = scenarioQualityFloors[selectedScenario?.id ?? ""] ?? 0.88;

  const refreshAppData = useCallback(async () => {
    setLoadingAppData(true);
    setConnectionNote("");
    try {
      const appData = await getAppData();
      setProviders(appData.providers);
      setScenarios(appData.scenarios.length ? appData.scenarios : fallbackScenarios);
    } catch (loadError) {
      setConnectionNote(loadError instanceof Error ? loadError.message : "The runtime could not be reached.");
      setProviders(defaultProviders);
    } finally {
      setLoadingAppData(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void getAppData()
      .then((appData) => {
        if (!active) return;
        setProviders(appData.providers);
        setScenarios(appData.scenarios.length ? appData.scenarios : fallbackScenarios);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setConnectionNote(loadError instanceof Error ? loadError.message : "The runtime could not be reached.");
        setProviders(defaultProviders);
      })
      .finally(() => {
        if (active) setLoadingAppData(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const selectScenario = (nextId: string) => {
    const next = scenarios.find((scenario) => scenario.id === nextId);
    setScenarioId(nextId);
    if (next) setObjective(next.objective);
    setStatus("idle");
    setEvents([]);
    setCompile(null);
    setComparison(null);
    setResult(null);
    setRefusal(null);
    setError("");
  };

  const runProof = async (budgetOverride?: number) => {
    const exactBudget = Math.round(budgetOverride ?? memoryBudget);
    if (!selectedScenario || !objective.trim()) {
      setStatus("error");
      setError("Choose an agent task and enter an objective before running the proof.");
      return;
    }
    if (!Number.isFinite(exactBudget) || exactBudget < 1) {
      setStatus("error");
      setError("Enter an exact memory budget of at least 1 token.");
      return;
    }

    setMemoryBudget(exactBudget);
    setStatus("running");
    setEvents([]);
    setCompile(null);
    setComparison(null);
    setResult(null);
    setRefusal(null);
    setError("");
    requestAnimationFrame(() => runStageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));

    try {
      await streamRun(
        {
          scenarioId: selectedScenario.id,
          objective: objective.trim(),
          constraints: { maxMemoryTokens: exactBudget, minSuccess: qualityFloor, strategy },
        },
        async (event) => {
          setEvents((current) => [...current, event]);
          if (event.type === "compile.completed") setCompile(event.data as CompileResult);
          if (event.type === "comparison.completed") setComparison(event.data as RavenComparison);
          if (event.type === "compile.refused") {
            const payload = event.data as { refusal?: SafeBudgetRefusal; compile?: CompileResult };
            const refused = payload.refusal ?? event.data as SafeBudgetRefusal;
            setRefusal(refused);
            setCompile(payload.compile ?? null);
            setStatus("refused");
          }
          if (event.type === "run.completed") {
            const completed = event.data as RavenRunResult;
            setResult(completed);
            setCompile(completed.compile);
            setComparison(completed.comparison);
            setProviders(completed.providers);
            setStatus("complete");
          }
          if (event.type === "run.error") {
            setError(event.message);
            setStatus("error");
          }
          if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            const revealDelay = event.type.endsWith(".started") ? 260 : event.type === "run.completed" ? 200 : 460;
            await new Promise((resolve) => window.setTimeout(resolve, revealDelay));
          }
        },
      );
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "The Raven proof failed.");
      setStatus("error");
    }
  };

  const applySafeFloor = () => {
    if (!refusal) return;
    const safeBudget = refusal.minimumSafeBudget;
    setMemoryBudget(safeBudget);
    void runProof(safeBudget);
  };

  const replayMode = providers.raven !== "live" || comparison?.measurementMode === "replay";

  return (
    <div id="top" className="app-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="TokenOS home">
          <span className="tokenos-mark" aria-hidden="true"><b>T</b><i>OS</i></span>
          <span><b className="tokenos-wordmark">TokenOS</b><small>Memory governor for Raven</small></span>
        </a>
        <div className="provider-status" aria-label="Connected service status">
          <span className="provider-label">SERVICES</span>
          <ProviderBadge label="EverOS" mode={providers.everos} />
          <ProviderBadge label="Raven" mode={providers.raven} />
        </div>
      </header>

      <main>
        <RuntimeTruth providers={providers} replayMode={replayMode} />

        <section className="hero-section" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow">BUDGET-AWARE MEMORY FOR RAVEN</p>
            <h1 id="hero-title">Give Raven only the memories <span>this task needs.</span></h1>
            <p className="hero-support">TokenOS selects the smallest safe set of EverOS memories for each task, then compares it with loading every available memory.</p>
            <div className="hero-proof-line"><Sparkle size={17} weight="fill" /> Same task and agent. Fewer memory tokens. Safety checks preserved.</div>
          </div>
          <aside className="hero-agent-card" aria-label="Example of TokenOS selecting memories for an agent task executed through Raven">
            <div className="agent-card-header">
              <span className="agent-avatar"><Bird size={27} weight="fill" /></span>
              <span><b>Incident agent task</b><small>Execution service · Raven</small></span>
              <span className="agent-ready"><i /> ready</span>
            </div>
            <blockquote>“Checkout latency is back. Investigate it, but don’t restart anything during business hours.”</blockquote>
            <div className="memory-note-list">
              <div className="memory-note pinned"><ShieldCheck size={18} weight="fill" /><span><b>Business-hours policy</b><small>Required · 42 tokens</small></span><strong>INCLUDE</strong></div>
              <div className="memory-note bought"><Brain size={18} weight="fill" /><span><b>Prior pool-saturation case</b><small>Matches task · 86 tokens</small></span><strong>INCLUDE</strong></div>
              <div className="memory-note rejected"><Warning size={18} /><span><b>Outdated restart runbook</b><small>Conflicts with policy</small></span><strong>EXCLUDE</strong></div>
            </div>
            <div className="agent-card-summary"><span><b>15</b> candidate memories</span><ArrowRight size={17} /><span><b>4</b> sent to Raven</span></div>
            <p><CirclesThreePlus size={16} weight="fill" /> TokenOS decides the context. Raven runs the agent.</p>
          </aside>
        </section>

        <section className="narrative-stage task-stage" id="task">
          <StageHeading number="01" eyebrow="AGENT TASK + MEMORY BUDGET" title="Give TokenOS a task. Set one hard memory budget.">
            TokenOS is agent-agnostic. In this demo Raven provides agent execution while the task, model, tools, and generation settings stay fixed.
          </StageHeading>
          <div className="task-console">
            <div className="task-inputs">
              <label>
                <span>Demo task</span>
                <select value={scenarioId} onChange={(event) => selectScenario(event.target.value)} disabled={status === "running"}>
                  {scenarios.map((scenario) => <option value={scenario.id} key={scenario.id}>{scenario.tag} · {scenario.name}</option>)}
                </select>
              </label>
              <label>
                <span>Agent objective</span>
                <textarea value={objective} onChange={(event) => setObjective(event.target.value)} rows={4} disabled={status === "running"} />
              </label>
              <div className="policy-line"><ShieldCheck size={18} weight="bold" /><span><b>Required policy</b>{selectedScenario?.policy ?? "Policy loads with the selected task."}</span></div>
            </div>
            <div className="budget-controls">
              <label className="budget-field">
                <span>Maximum memory context</span>
                <span className="number-input"><input type="number" min="1" step="1" inputMode="numeric" value={memoryBudget} onChange={(event) => setMemoryBudget(Number(event.target.value))} disabled={status === "running"} /><b>TOKENS</b></span>
              </label>
              <fieldset className="strategy-control" disabled={status === "running"}>
                <legend>Selection priority</legend>
                {(["economy", "balanced", "quality"] as Strategy[]).map((option) => (
                  <label className={strategy === option ? "selected" : ""} key={option}>
                    <input type="radio" name="strategy" value={option} checked={strategy === option} onChange={() => setStrategy(option)} />
                    {strategyLabels[option]}
                  </label>
                ))}
              </fieldset>
              <div className="fixed-constraints">
                <span><b>{whole(qualityFloor * 100)}%</b> minimum expected success score</span><span><b>{selectedScenario?.tools.length ?? 0}</b> fixed tools</span>
              </div>
              <button ref={runButtonRef} className="primary-action run-action" type="button" onClick={() => void runProof()} disabled={status === "running" || loadingAppData}>
                {status === "running" ? <><span className="spinner" /> TOKENOS IS SELECTING…</> : <><Play size={20} weight="fill" /> SELECT MEMORY + RUN COMPARISON</>}
              </button>
              <p className="mode-disclosure"><span className={replayMode ? "replay" : "live"} /> {replayMode ? "Demo mode: optimizer is real; Raven response and usage are replayed estimates." : "Live mode: Raven executes and reports model usage."}</p>
            </div>
          </div>
          {connectionNote && (
            <div className="recoverable-error" role="status"><Warning size={19} /><span><b>Runtime connection unavailable.</b> {connectionNote} The local catalog remains visible.</span><button type="button" onClick={() => void refreshAppData()}><ArrowClockwise size={16} /> Retry connection</button></div>
          )}
          {status === "error" && (
            <div className="recoverable-error run-error" role="alert"><Warning size={19} /><span><b>Proof stopped.</b> {error}</span><button type="button" onClick={() => void runProof()}><ArrowClockwise size={16} /> Retry proof</button></div>
          )}
        </section>

        <section ref={runStageRef} className={`narrative-stage pipeline-stage ${status !== "idle" ? "has-run" : ""}`} id="pipeline">
          <StageHeading number="02" eyebrow="YOUR RUN · COMPUTED RESULTS" title="Watch TokenOS build Raven's context.">
            Results from this task, budget, and selection priority appear step by step. Every agent measurement is explicitly labeled live or replay.
          </StageHeading>
          <RunSpotlight events={events} status={status} compile={compile} comparison={comparison} result={result} refusal={refusal} replayMode={replayMode} />
          {refusal && <SafetyInterlock refusal={refusal} />}
        </section>

        <section className="narrative-stage comparison-stage" id="comparison">
          <StageHeading number="03" eyebrow="CONTROLLED A/B COMPARISON" title="Load everything versus load only what is needed.">
            The task, model, tools, and generation settings stay fixed. Only the memory context changes.
          </StageHeading>
          <ComparisonProof comparison={comparison} />
        </section>

        <section className="narrative-stage answer-stage" id="answer">
          <StageHeading number="04" eyebrow="THE GOVERNED OUTCOME" title={comparison?.measurementMode === "live" ? "Raven's optimized answer." : "Replayed Raven answer."}>
            {comparison?.measurementMode === "live" ? "This answer came from the connected Raven runtime." : "In demo mode this is a deterministic response fixture, not a live Raven generation."}
          </StageHeading>
          {result ? (
            <article className="answer-paper">
              <div className="answer-meta"><span><CirclesThreePlus size={17} weight="fill" /> GOVERNED BY TOKENOS · {result.comparison.measurementMode === "live" ? "EXECUTED VIA RAVEN" : "RAVEN REPLAY"}</span><b>{result.compile.selected.memoryIds.length} memories · {whole(result.comparison.governed.usage.totalTokens)} total tokens</b></div>
              <div className="answer-body">{formatAnswer(result.answer)}</div>
            </article>
          ) : (
            <div className="evidence-empty"><FileText size={26} /><div><strong>The governed agent answer will appear here.</strong><p>{status === "refused" ? "Execution was correctly blocked before the agent could answer." : "Run the A/B proof to generate the optimized response."}</p></div></div>
          )}
        </section>

        <section className="narrative-stage auction-stage" id="auction">
          <StageHeading number="05" eyebrow="MEMORY SELECTION + RELATIONSHIPS" title="Which memories were sent to Raven—and why.">
            Required policies are always included. Optional memories are selected using token size, task match, prior outcomes, duplicates, conflicts, and dependencies.
          </StageHeading>
          <MemorySelectionEvidence compile={compile} />
        </section>

        <section className="narrative-stage safety-stage" id="safety-proof">
          <StageHeading number="06" eyebrow="SAFETY + REQUIRED-FACT PROOF" title="A budget can be too small to be safe.">
            TokenOS computes the minimum-safe memory budget and refuses before agent execution whenever policy or required facts cannot fit.
          </StageHeading>
          <SafetyProof result={result} refusal={refusal} budget={memoryBudget} onApplyFloor={applySafeFloor} />
        </section>

        <section className="narrative-stage learning-stage" id="learning">
          <StageHeading number="07" eyebrow="TOKENOS LEARNING RECEIPT" title="The successful portfolio becomes future evidence.">
            TokenOS records exactly which memories proved sufficient and prepares the reusable agent case for EverOS write-back.
          </StageHeading>
          <LearningEvidence result={result} />
        </section>

        <section className="narrative-stage subsequent-stage" id="subsequent-run">
          <StageHeading number="08" eyebrow="SUBSEQUENT-RUN IMPROVEMENT" title="The next related task can reuse what worked.">
            When a compact memory set succeeds, the resulting agent case becomes stronger evidence for a similar future task.
          </StageHeading>
          <SubsequentRun result={result} />
        </section>

        <section className="closing-statement">
          <CirclesThreePlus size={30} weight="fill" />
          <p>TokenOS lets Raven learn more without loading everything it has learned into every request.</p>
        </section>
      </main>

      <footer>
        <span>Agent execution via <a href="https://github.com/EverMind-AI/Raven" target="_blank" rel="noreferrer">Raven</a> · Memory through EverOS</span>
        <span>TokenOS · Memory governor for Raven</span>
      </footer>
    </div>
  );
}
