import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowsLeftRight,
  Brain,
  CaretDown,
  ChartLineUp,
  Check,
  CirclesThreePlus,
  Database,
  Flask,
  Gauge,
  Graph,
  Lightning,
  LinkSimple,
  LockKey,
  Play,
  Pulse,
  ShieldCheck,
  Snowflake,
  Stack,
  TrendDown,
  Warning,
} from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { scenarios as localScenarios } from "../shared/catalog";
import type {
  CompileResult,
  CounterfactualResult,
  Evaluation,
  ExecutionComparison,
  LedgerStatus,
  MemoryCandidate,
  PlanCandidate,
  ProviderStatus,
  RunConstraints,
  RunEvent,
  RunResult,
  RunUsage,
} from "../shared/contracts";
import { getAppData, streamRun, type ScenarioSummary } from "./api";

type RunState = "idle" | "streaming" | "complete" | "error" | "infeasible";
type CatalogState = "loading" | "ready" | "fallback";
type SafeRefusal = { minimumTokens: number; minimumCost: number };

const phases = [
  { id: "recall", label: "Retrieve", detail: "EverOS candidates", icon: Brain },
  { id: "policy", label: "Pin", detail: "Safety and facts", icon: ShieldCheck },
  { id: "search", label: "Compile", detail: "Memory portfolios", icon: Graph },
  { id: "inference", label: "Compare", detail: "Same Cortex model", icon: ArrowsLeftRight },
  { id: "evaluation", label: "Ablate", detail: "Counterfactual proof", icon: Flask },
  { id: "ledger", label: "Record", detail: "Snowflake evidence", icon: Database },
] as const;

const defaultConstraints: RunConstraints = {
  maxCost: 0.003,
  maxLatencyMs: 1800,
  minSuccess: 0.9,
  maxMemoryTokens: 360,
  strategy: "balanced",
  region: "ANY_REGION",
};

const money = (value: number) =>
  value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 0.1 ? 4 : 2,
    maximumFractionDigits: value < 0.1 ? 4 : 2,
  });

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function isUsage(value: unknown): value is RunUsage {
  return isRecord(value) &&
    typeof value.promptTokens === "number" &&
    typeof value.completionTokens === "number" &&
    typeof value.totalTokens === "number" &&
    typeof value.actualCost === "number" &&
    typeof value.estimated === "boolean";
}

function isEvaluation(value: unknown): value is Evaluation {
  return isRecord(value) &&
    typeof value.score === "number" &&
    typeof value.policyPassed === "boolean" &&
    Array.isArray(value.checks);
}

function isPlan(value: unknown): value is PlanCandidate {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.modelId === "string" &&
    typeof value.memoryTokens === "number" &&
    typeof value.successProbability === "number" &&
    typeof value.feasible === "boolean" &&
    Array.isArray(value.memoryIds);
}

function isMemory(value: unknown): value is MemoryCandidate {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.content === "string" &&
    typeof value.tokens === "number" &&
    typeof value.relevance === "number" &&
    typeof value.confidence === "number";
}

function isCompile(value: unknown): value is CompileResult {
  return isRecord(value) &&
    isPlan(value.selected) &&
    isPlan(value.baseline) &&
    Array.isArray(value.memories) && value.memories.every(isMemory) &&
    Array.isArray(value.alternatives) && value.alternatives.every(isPlan) &&
    Array.isArray(value.frontier) && value.frontier.every(isPlan) &&
    Array.isArray(value.relationshipEdges) &&
    typeof value.evaluatedCount === "number" &&
    typeof value.feasibleCount === "number" &&
    typeof value.minimumSafeMemoryTokens === "number" &&
    typeof value.minimumSafeCost === "number";
}

function isComparison(value: unknown): value is ExecutionComparison {
  return isRecord(value) &&
    isRecord(value.baseline) && isUsage(value.baseline.usage) && isEvaluation(value.baseline.evaluation) &&
    isRecord(value.optimized) && isUsage(value.optimized.usage) && isEvaluation(value.optimized.evaluation) &&
    typeof value.tokenReduction === "number" &&
    typeof value.costReduction === "number" &&
    typeof value.requiredFactsPreserved === "boolean" &&
    typeof value.sameModel === "boolean";
}

function isCounterfactual(value: unknown): value is CounterfactualResult {
  return isRecord(value) &&
    typeof value.memoryId === "string" &&
    typeof value.memoryContent === "string" &&
    typeof value.promptTokens === "number" &&
    typeof value.qualityDelta === "number" &&
    typeof value.policyPassed === "boolean" &&
    typeof value.outcomeChanged === "boolean" &&
    typeof value.detail === "string";
}

function isLedger(value: unknown): value is LedgerStatus {
  return isRecord(value) &&
    (value.mode === "local" || value.mode === "snowflake" || value.mode === "fallback") &&
    typeof value.detail === "string";
}

function isProviderStatus(value: unknown): value is ProviderStatus {
  const validMode = (mode: unknown) => mode === "demo" || mode === "live" || mode === "fallback";
  return isRecord(value) && validMode(value.everos) && validMode(value.snowflake) && typeof value.message === "string";
}

function isRunResult(value: unknown): value is RunResult {
  return isRecord(value) &&
    typeof value.answer === "string" &&
    isCompile(value.compile) &&
    isUsage(value.usage) &&
    isEvaluation(value.evaluation) &&
    isComparison(value.comparison) &&
    Array.isArray(value.counterfactuals) && value.counterfactuals.every(isCounterfactual) &&
    isProviderStatus(value.providers) &&
    isLedger(value.ledger);
}

function ProviderBadge({
  label,
  mode,
  icon: Icon,
}: {
  label: string;
  mode: ProviderStatus["everos"];
  icon: typeof Brain;
}) {
  return (
    <span className={`provider-badge ${mode}`} title={`${label}: ${mode}`}>
      <Icon size={14} weight="bold" />
      <span>{label}</span>
      <b>{mode}</b>
    </span>
  );
}

function PhaseRail({ events, runState }: { events: RunEvent[]; runState: RunState }) {
  const currentPhase = events.at(-1)?.phase;
  const currentIndex = phases.findIndex((phase) => phase.id === currentPhase);
  const finished = runState === "complete";

  return (
    <section className="phase-rail" aria-label="Economic memory compiler pipeline">
      {phases.map(({ id, label, detail, icon: Icon }, index) => {
        const event = [...events].reverse().find((item) => item.phase === id);
        const complete = finished || currentIndex > index;
        const failed = (runState === "error" || runState === "infeasible") && currentPhase === id;
        const active = currentPhase === id && !complete && !failed;
        return (
          <div
            className={`phase-node ${active ? "active" : ""} ${complete ? "complete" : ""} ${failed ? "failed" : ""}`}
            key={id}
          >
            <div className="phase-glyph">
              {complete ? <Check size={15} weight="bold" /> : failed ? <Warning size={15} weight="fill" /> : <Icon size={16} />}
            </div>
            <div className="phase-copy">
              <strong>{label}</strong>
              <span>{event?.message ?? detail}</span>
            </div>
          </div>
        );
      })}
    </section>
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
  const output: React.ReactNode[] = [];
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
    const heading = headings.has(line) || (lines[index + 1] === "" && line.length < 42);
    output.push(heading ? <h3 key={`${line}-${index}`}>{line}</h3> : <p key={`${line}-${index}`}>{line}</p>);
  });
  flush();
  return output;
}

function SavingsProof({
  comparison,
  baselineUsage,
  optimizedUsage,
}: {
  comparison: ExecutionComparison | null;
  baselineUsage: RunUsage | null;
  optimizedUsage: RunUsage | null;
}) {
  if (!comparison) {
    return (
      <section className={`savings-proof empty-savings ${baselineUsage ? "has-baseline" : ""}`}>
        <div className="comparison-promise">
          <ArrowsLeftRight size={25} />
          <span>
            <b>{baselineUsage ? "Baseline recorded. Controlled comparison is still running." : "Controlled comparison appears after execution."}</b>
            <small>Model, generation settings, task, and tools stay fixed. Only memory selection changes.</small>
          </span>
        </div>
        <dl className="pending-usage">
          <div><dt>BASELINE PROMPT</dt><dd>{baselineUsage ? baselineUsage.promptTokens.toLocaleString() : "Pending"}</dd></div>
          <div><dt>OPTIMIZED PROMPT</dt><dd>{optimizedUsage ? optimizedUsage.promptTokens.toLocaleString() : "Pending"}</dd></div>
          <div><dt>MEASURED SAVINGS</dt><dd>Withheld</dd></div>
        </dl>
      </section>
    );
  }

  return (
    <motion.section className="savings-proof" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <div className="hero-saving">
        <span>MEASURED CORTEX COST REDUCTION</span>
        <strong>{percent(comparison.costReduction)}</strong>
        <small><TrendDown size={15} weight="bold" /> Same model. Fewer purchased memories.</small>
      </div>
      <dl className="comparison-metrics">
        <div>
          <dt>BASELINE PROMPT</dt>
          <dd>{comparison.baseline.usage.promptTokens.toLocaleString()}</dd>
          <small>{money(comparison.baseline.usage.actualCost)}</small>
        </div>
        <div>
          <dt>COMPILED PROMPT</dt>
          <dd>{comparison.optimized.usage.promptTokens.toLocaleString()}</dd>
          <small>{money(comparison.optimized.usage.actualCost)}</small>
        </div>
        <div>
          <dt>PROMPT TOKENS REMOVED</dt>
          <dd>{percent(comparison.tokenReduction)}</dd>
          <small>actual Cortex usage</small>
        </div>
        <div>
          <dt>REQUIRED FACTS</dt>
          <dd>{comparison.requiredFactsPreserved ? "PRESERVED" : "FAILED"}</dd>
          <small>{comparison.sameModel ? "same model verified" : "model mismatch"}</small>
        </div>
      </dl>
    </motion.section>
  );
}

function EvidenceStrip({
  compile,
  liveMemories,
  constraints,
  comparison,
  ledger,
}: {
  compile: CompileResult | null;
  liveMemories: MemoryCandidate[];
  constraints: RunConstraints;
  comparison: ExecutionComparison | null;
  ledger: LedgerStatus | null;
}) {
  const candidateCount = compile?.memories.length ?? liveMemories.length;
  return (
    <section className="evidence-strip" aria-label="Live experiment evidence">
      <div><span>EVEROS CANDIDATES</span><b>{candidateCount || "15 expected"}</b></div>
      <div><span>PORTFOLIOS TESTED</span><b>{compile ? compile.evaluatedCount.toLocaleString() : "32,768 target"}</b></div>
      <div><span>MEMORY BUDGET</span><b>{constraints.maxMemoryTokens.toLocaleString()} tok</b></div>
      <div><span>SELECTED MEMORY</span><b>{compile ? `${compile.selected.memoryTokens} tok` : "Pending"}</b></div>
      <div><span>CORTEX CONTROL</span><b>{comparison ? (comparison.sameModel ? "Same model" : "Mismatch") : "Locked"}</b></div>
      <div><span>LEDGER MODE</span><b>{ledger?.mode ?? "Pending"}</b></div>
    </section>
  );
}

const decisionLabels: Record<NonNullable<MemoryCandidate["decisionCode"]>, string> = {
  pinned: "Pinned",
  selected: "Purchased",
  redundant: "Rejected: redundant",
  contradiction: "Rejected: contradictory",
  low_value: "Rejected: low value",
  irrelevant: "Rejected: irrelevant",
};

function MemoryAuction({
  compile,
  liveMemories,
}: {
  compile: CompileResult | null;
  liveMemories: MemoryCandidate[];
}) {
  const memories = compile?.memories ?? liveMemories;
  const selectedCount = compile?.selected.memoryIds.length ?? memories.filter((memory) => memory.selected).length;
  const tokenCount = compile?.selected.memoryTokens ?? 0;

  return (
    <section className="surface-panel memory-auction">
      <div className="surface-heading memory-heading">
        <div>
          <span>LIVE MEMORY MARKET</span>
          <h2>Every memory must justify its token price.</h2>
        </div>
        <div className="heading-stat">
          <b>{selectedCount}/{memories.length || 15}</b>
          <small>{tokenCount.toLocaleString()} TOKENS PURCHASED</small>
        </div>
      </div>
      <div className="decision-legend" aria-label="Memory decision legend">
        <span className="pinned">Pinned</span>
        <span className="purchased">Purchased</span>
        <span className="rejected">Rejected with reason</span>
      </div>

      {!memories.length ? (
        <div className="technical-empty">
          <Brain size={24} />
          <div><strong>Waiting for EverOS.</strong><p>Fifteen candidate memories will enter the compiler.</p></div>
        </div>
      ) : (
        <div className="memory-grid">
          {memories.map((memory, index) => {
            const decisionCode = memory.decisionCode ?? (memory.selected ? "selected" : undefined);
            const decisionLabel = decisionCode ? decisionLabels[decisionCode] : "Candidate";
            return (
              <motion.article
                className={`memory-bid ${memory.selected ? "selected" : "rejected"} ${decisionCode ?? "candidate"}`}
                key={memory.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.02, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="memory-meta">
                  <span>{memory.type.replace("_", " ")}</span>
                  <b>{memory.tokens} TOK</b>
                  <strong>{decisionLabel}</strong>
                </div>
                <p>{memory.content}</p>
                <div className="memory-economics">
                  <span><b>{memory.utilityPer1k?.toFixed(2) ?? "Pending"}</b> utility / 1K</span>
                  <span><b>{percent(memory.relevance)}</b> relevance</span>
                  <span><b>{percent(memory.confidence)}</b> confidence</span>
                </div>
                <small>{memory.decision ?? `${memory.source}. Awaiting compiler decision.`}</small>
              </motion.article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function MemoryFrontier({ compile }: { compile: CompileResult }) {
  const plans = (compile.frontier.length ? compile.frontier : compile.alternatives)
    .slice()
    .sort((left, right) => left.memoryTokens - right.memoryTokens);
  if (!plans.length) {
    return <div className="technical-empty small"><ChartLineUp size={22} /><p>No feasible Pareto points were returned.</p></div>;
  }

  const minTokens = Math.min(...plans.map((plan) => plan.memoryTokens));
  const maxTokens = Math.max(...plans.map((plan) => plan.memoryTokens));
  const minSuccess = Math.min(...plans.map((plan) => plan.successProbability));
  const maxSuccess = Math.max(...plans.map((plan) => plan.successProbability));
  const x = (tokens: number) => 36 + ((tokens - minTokens) / Math.max(1, maxTokens - minTokens)) * 340;
  const y = (success: number) => 112 - ((success - minSuccess) / Math.max(0.01, maxSuccess - minSuccess)) * 84;
  const frontierPath = plans.map((plan) => `${x(plan.memoryTokens)},${y(plan.successProbability)}`).join(" ");

  return (
    <div className="frontier-plot">
      <svg viewBox="0 0 410 138" role="img" aria-label="Pareto frontier for memory tokens, quality, and cost">
        <line x1="36" y1="112" x2="388" y2="112" className="chart-axis" />
        <line x1="36" y1="20" x2="36" y2="112" className="chart-axis" />
        <polyline points={frontierPath} className="frontier-line" />
        {plans.map((plan) => {
          const selected = plan.id === compile.selected.id;
          return (
            <circle
              key={plan.id}
              cx={x(plan.memoryTokens)}
              cy={y(plan.successProbability)}
              r={selected ? 7 : 4}
              className={selected ? "plan-dot selected" : "plan-dot"}
            >
              <title>{`${plan.memoryTokens} memory tokens, ${percent(plan.successProbability)} quality, ${money(plan.estimatedCost)}`}</title>
            </circle>
          );
        })}
      </svg>
      <span className="plot-label tokens">MEMORY TOKENS</span>
      <span className="plot-label quality">OUTCOME QUALITY</span>
    </div>
  );
}

function CompilerProof({ compile }: { compile: CompileResult | null }) {
  return (
    <section className="surface-panel compiler-proof">
      <div className="surface-heading compact">
        <div><span>COMPILER PROOF</span><h2>{compile ? "Exact portfolio search" : "Awaiting task"}</h2></div>
        <Graph size={21} />
      </div>
      {compile ? (
        <>
          <div className="compiler-stat-grid">
            <div><b>{compile.evaluatedCount.toLocaleString()}</b><span>portfolios evaluated</span></div>
            <div><b>{compile.feasibleCount.toLocaleString()}</b><span>safe portfolios</span></div>
            <div><b>{compile.relationshipEdges.length}</b><span>graph relationships</span></div>
            <div><b>{compile.minimumSafeMemoryTokens}</b><span>minimum safe tokens</span></div>
          </div>
          <MemoryFrontier compile={compile} />
          <div className="compiler-equation">
            <span>MARGINAL VALUE PER 1,000 TOKENS</span>
            <code>[Utility(S + m) - Utility(S)] / TokenCost(m)</code>
            <small>Safety, coverage, dependency, quality, region, latency, and budget remain hard constraints.</small>
          </div>
        </>
      ) : (
        <div className="technical-empty small"><ChartLineUp size={22} /><p>The Pareto frontier and exact search evidence will render here.</p></div>
      )}
    </section>
  );
}

function RelationshipProof({ compile }: { compile: CompileResult | null }) {
  const names = new Map(compile?.memories.map((memory) => [memory.id, memory.content]) ?? []);
  const edges = compile?.relationshipEdges ?? [];
  const nodeIds = Array.from(new Set(edges.flatMap((edge) => [edge.sourceId, edge.targetId]))).slice(0, 10);
  const positions = new Map(nodeIds.map((id, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, nodeIds.length) - Math.PI / 2;
    return [id, { x: 220 + Math.cos(angle) * 145, y: 112 + Math.sin(angle) * 78 }];
  }));

  return (
    <section className="surface-panel relationship-proof">
      <div className="surface-heading compact">
        <div><span>MEMORY RELATIONSHIP GRAPH</span><h2>Relationships change portfolio value.</h2></div>
        <LinkSimple size={20} />
      </div>
      {edges.length ? (
        <>
          <div className="relationship-graph">
            <svg viewBox="0 0 440 224" role="img" aria-label="Memory dependency and conflict graph">
              <defs>
                <marker id="graph-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                  <path d="M0,0 L7,3.5 L0,7 Z" />
                </marker>
              </defs>
              {edges.map((edge) => {
                const source = positions.get(edge.sourceId);
                const target = positions.get(edge.targetId);
                if (!source || !target) return null;
                return (
                  <line
                    key={`${edge.sourceId}-${edge.targetId}-${edge.type}`}
                    x1={source.x}
                    y1={source.y}
                    x2={target.x}
                    y2={target.y}
                    className={`graph-edge ${edge.type}`}
                    markerEnd="url(#graph-arrow)"
                  >
                    <title>{`${edge.type.replace("_", " ")}: ${names.get(edge.sourceId)} to ${names.get(edge.targetId)}`}</title>
                  </line>
                );
              })}
              {nodeIds.map((id, index) => {
                const point = positions.get(id)!;
                return (
                  <g className="graph-node" key={id} transform={`translate(${point.x} ${point.y})`}>
                    <circle r="18" />
                    <text textAnchor="middle" dominantBaseline="middle">M{String(index + 1).padStart(2, "0")}</text>
                    <title>{names.get(id)}</title>
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="relationship-key">
            {edges.map((edge) => (
              <div key={`${edge.sourceId}-${edge.targetId}-${edge.type}-key`}>
                <b>{edge.type.replace("_", " ")}</b>
                <span>{names.get(edge.sourceId)?.slice(0, 44)}</span>
                <small>{percent(edge.strength)}</small>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="technical-empty small"><CirclesThreePlus size={22} /><p>Duplicate, contradiction, dependency, and complement edges appear here.</p></div>
      )}
    </section>
  );
}

function CounterfactualProof({ counterfactuals }: { counterfactuals: CounterfactualResult[] }) {
  return (
    <section className="surface-panel counterfactual-proof">
      <div className="surface-heading compact">
        <div><span>THREE CONTROLLED ABLATIONS</span><h2>Did each memory change the answer?</h2></div>
        <Flask size={20} />
      </div>
      {counterfactuals.length ? (
        <div className="ablation-list">
          {counterfactuals.map((item, index) => (
            <article key={`${item.memoryId}-${item.role}`} className={item.policyPassed ? "safe" : "failed"}>
              <header>
                <span>TEST {index + 1} / 3</span>
                <b>{item.role === "rejected_control" ? "REJECTED CONTROL" : item.role.toUpperCase()}</b>
              </header>
              <div className="ablation-verdict">
                {item.policyPassed ? <Check size={16} weight="bold" /> : <Warning size={16} weight="fill" />}
                <strong>{item.outcomeChanged ? "Outcome changed" : "No material change"}</strong>
              </div>
              <p>{item.memoryContent}</p>
              <small>{item.detail}</small>
              <dl>
                <div><dt>QUALITY DELTA</dt><dd>{(item.qualityDelta * 100).toFixed(1)} pt</dd></div>
                <div><dt>POLICY</dt><dd>{item.policyPassed ? "PASS" : "FAIL"}</dd></div>
                <div><dt>RECHECK TOKENS</dt><dd>{item.promptTokens.toLocaleString()}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <div className="technical-empty small"><Flask size={22} /><p>TokenOS removes the pinned policy, highest-value purchase, and one rejected control.</p></div>
      )}
    </section>
  );
}

function PolicyProof({ evaluation }: { evaluation: Evaluation | null }) {
  return (
    <section className="surface-panel policy-proof">
      <div className="surface-heading compact">
        <div><span>POLICY AND SAFETY PROOF</span><h2>{evaluation ? (evaluation.policyPassed ? "All constraints survived" : "Unsafe context") : "Awaiting outcome"}</h2></div>
        {evaluation?.policyPassed && <ShieldCheck size={21} weight="fill" />}
      </div>
      <div className="check-list">
        {evaluation ? evaluation.checks.map((check) => (
          <div key={check.label} className={check.passed ? "passed" : "failed"}>
            {check.passed ? <Check size={14} weight="bold" /> : <Warning size={14} weight="fill" />}
            <span><strong>{check.label}</strong><small>{check.detail}</small></span>
          </div>
        )) : <p>Policies, required facts, tools, region, and response completeness are checked after execution.</p>}
      </div>
    </section>
  );
}

function LedgerProof({ ledger }: { ledger: LedgerStatus | null }) {
  return (
    <section className="surface-panel ledger-proof">
      <div className="surface-heading compact">
        <div><span>SNOWFLAKE EVIDENCE LEDGER</span><h2>{ledger ? `${ledger.mode} mode recorded` : "Awaiting final record"}</h2></div>
        <Database size={20} />
      </div>
      <div className="ledger-body">
        <span className={`ledger-mode ${ledger?.mode ?? "pending"}`}>{ledger?.mode ?? "pending"}</span>
        <p>{ledger?.detail ?? "Baseline, optimized, and counterfactual evidence will be recorded after the run."}</p>
      </div>
    </section>
  );
}

function App() {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>(
    localScenarios.map(({ id, name, tag, objective, valueAtRisk, policy, tools }) => ({
      id, name, tag, objective, valueAtRisk, policy, tools,
    })),
  );
  const [scenarioId, setScenarioId] = useState(localScenarios[0].id);
  const [objective, setObjective] = useState(localScenarios[0].objective);
  const [constraints, setConstraints] = useState<RunConstraints>(defaultConstraints);
  const [providers, setProviders] = useState<ProviderStatus>({
    everos: "demo",
    snowflake: "demo",
    message: "Connecting to the TokenOS compiler.",
  });
  const [catalogState, setCatalogState] = useState<CatalogState>("loading");
  const [runState, setRunState] = useState<RunState>("idle");
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [liveMemories, setLiveMemories] = useState<MemoryCandidate[]>([]);
  const [compile, setCompile] = useState<CompileResult | null>(null);
  const [answer, setAnswer] = useState("");
  const [baselineUsage, setBaselineUsage] = useState<RunUsage | null>(null);
  const [optimizedUsage, setOptimizedUsage] = useState<RunUsage | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [comparison, setComparison] = useState<ExecutionComparison | null>(null);
  const [counterfactuals, setCounterfactuals] = useState<CounterfactualResult[]>([]);
  const [ledger, setLedger] = useState<LedgerStatus | null>(null);
  const [safeRefusal, setSafeRefusal] = useState<SafeRefusal | null>(null);
  const [error, setError] = useState("");
  const [completedRuns, setCompletedRuns] = useState(0);
  const runSurfaceRef = useRef<HTMLElement>(null);
  const reduceMotion = useReducedMotion();
  const scenario = scenarios.find((item) => item.id === scenarioId) ?? scenarios[0];
  const progress = events.at(-1)?.progress ?? 0;
  const eventLog = useMemo(() => events.slice(-7).reverse(), [events]);

  useEffect(() => {
    getAppData()
      .then((data) => {
        setProviders(data.providers);
        setScenarios(data.scenarios);
        setCatalogState("ready");
      })
      .catch(() => {
        setCatalogState("fallback");
        setProviders({
          everos: "demo",
          snowflake: "demo",
          message: "Start the TokenOS API to run the compiler.",
        });
      });
  }, []);

  function resetRun(clearObjective = false) {
    setRunState("idle");
    setEvents([]);
    setLiveMemories([]);
    setCompile(null);
    setAnswer("");
    setBaselineUsage(null);
    setOptimizedUsage(null);
    setEvaluation(null);
    setComparison(null);
    setCounterfactuals([]);
    setLedger(null);
    setSafeRefusal(null);
    setError("");
    if (clearObjective && scenario) setObjective(scenario.objective);
  }

  function chooseScenario(id: string) {
    const next = scenarios.find((item) => item.id === id);
    setScenarioId(id);
    if (next) {
      setObjective(next.objective);
      setConstraints((current) => ({
        ...current,
        region: id === "support" ? "AWS_US" : "ANY_REGION",
        maxMemoryTokens: id === "incident" ? 360 : 300,
      }));
    }
    resetRun(false);
  }

  function handleEvent(event: RunEvent) {
    setEvents((current) => [...current, event]);

    switch (event.type) {
      case "run.started": {
        if (isRecord(event.data) && isProviderStatus(event.data.providers)) setProviders(event.data.providers);
        break;
      }
      case "recall.completed": {
        if (!isRecord(event.data) || !Array.isArray(event.data.memories) || !event.data.memories.every(isMemory)) {
          throw new Error("The recall event did not include a valid memory portfolio.");
        }
        setLiveMemories(event.data.memories);
        const mode = event.data.mode;
        if (mode === "demo" || mode === "live" || mode === "fallback") {
          setProviders((current) => ({ ...current, everos: mode }));
        }
        break;
      }
      case "search.completed": {
        if (!isCompile(event.data)) throw new Error("The compiler returned an invalid portfolio result.");
        setCompile(event.data);
        break;
      }
      case "baseline.completed": {
        if (!isRecord(event.data) || !isUsage(event.data.usage)) throw new Error("The baseline usage event is invalid.");
        setBaselineUsage(event.data.usage);
        break;
      }
      case "optimized.completed": {
        if (!isRecord(event.data) || typeof event.data.answer !== "string" || !isUsage(event.data.usage)) {
          throw new Error("The optimized execution event is invalid.");
        }
        setAnswer(event.data.answer);
        setOptimizedUsage(event.data.usage);
        const mode = event.data.mode;
        if (mode === "demo" || mode === "live" || mode === "fallback") {
          setProviders((current) => ({ ...current, snowflake: mode }));
        }
        break;
      }
      case "inference.completed": {
        if (!isRecord(event.data) || !isComparison(event.data.comparison)) {
          throw new Error("The Cortex comparison event is invalid.");
        }
        setComparison(event.data.comparison);
        break;
      }
      case "evaluation.completed": {
        if (!isEvaluation(event.data)) throw new Error("The safety evaluation event is invalid.");
        setEvaluation(event.data);
        break;
      }
      case "counterfactual.completed": {
        if (!Array.isArray(event.data) || !event.data.every(isCounterfactual)) {
          throw new Error("The counterfactual evidence event is invalid.");
        }
        setCounterfactuals(event.data);
        break;
      }
      case "ledger.completed": {
        if (!isRunResult(event.data)) throw new Error("The final ledger event is invalid.");
        setCompile(event.data.compile);
        setAnswer(event.data.answer);
        setOptimizedUsage(event.data.usage);
        setEvaluation(event.data.evaluation);
        setComparison(event.data.comparison);
        setCounterfactuals(event.data.counterfactuals);
        setProviders(event.data.providers);
        setLedger(event.data.ledger);
        setRunState("complete");
        setCompletedRuns((count) => count + 1);
        setError("");
        break;
      }
      case "run.error": {
        const failedCompile = isRecord(event.data) && isCompile(event.data.compile) ? event.data.compile : null;
        if (failedCompile) {
          setCompile(failedCompile);
          setSafeRefusal({
            minimumTokens: failedCompile.minimumSafeMemoryTokens,
            minimumCost: failedCompile.minimumSafeCost,
          });
          setRunState("infeasible");
        } else {
          setRunState("error");
        }
        setError(event.message);
        break;
      }
      case "recall.started":
      case "policy.completed":
      case "search.started":
      case "inference.started":
        break;
      default:
        break;
    }
  }

  async function runCompiler() {
    if (objective.trim().length < 12) {
      setError("Describe a concrete task before running the compiler.");
      setRunState("error");
      return;
    }
    resetRun(false);
    setRunState("streaming");
    window.setTimeout(() => {
      runSurfaceRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    }, 100);

    try {
      await streamRun({ scenarioId, objective: objective.trim(), constraints }, handleEvent);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "The compiler run failed.");
      setRunState("error");
    }
  }

  const stateTitle = runState === "idle"
    ? "Ready to price memory"
    : runState === "streaming"
      ? "Controlled experiment running"
      : runState === "complete"
        ? "Economic proof complete"
        : runState === "infeasible"
          ? "Safe contract required"
          : "Experiment interrupted";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to compiler</a>
      <header className="app-nav">
        <div className="brand-lockup">
          <span className="brand-mark"><Snowflake size={18} weight="fill" /></span>
          <span><strong>TOKENOS</strong><small>ECONOMIC MEMORY COMPILER</small></span>
        </div>
        <div className="nav-status">
          <ProviderBadge label="EVEROS" mode={providers.everos} icon={Brain} />
          <ProviderBadge label="SNOWFLAKE" mode={providers.snowflake} icon={Snowflake} />
          <span className="run-counter"><Pulse size={14} /> {completedRuns} PROOFS</span>
          <button type="button" className="new-run" onClick={() => resetRun(true)}>NEW RUN</button>
        </div>
      </header>

      <main id="main-content">
        <section className="workbench-intro">
          <div>
            <span className="intro-label">COST OF INTELLIGENCE</span>
            <h1>Buy the smallest safe memory portfolio.</h1>
          </div>
          <div className="intro-proof">
            <p>TokenOS compiles agent memory, then proves the savings against a full-context Snowflake Cortex baseline.</p>
            <span className={`catalog-state ${catalogState}`}>
              <i /> {catalogState === "loading" ? "Checking compiler" : catalogState === "ready" ? "Compiler connected" : "Local catalog ready"}
            </span>
          </div>
        </section>

        <section className="control-principle" aria-label="Controlled experiment principle">
          <LockKey size={17} weight="bold" />
          <span><b>SAME CORTEX MODEL</b> Baseline and optimized runs keep model, settings, task, and tools fixed. Only the purchased memories vary.</span>
        </section>

        <section className="composer" aria-label="Memory compilation contract">
          <div className="objective-column">
            <div className="composer-topline">
              <label htmlFor="scenario">DEMO CASE</label>
              <div className="select-shell">
                <select id="scenario" value={scenarioId} onChange={(event) => chooseScenario(event.target.value)}>
                  {scenarios.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <CaretDown size={14} />
              </div>
              <span>{scenario?.tag}</span>
              <span>VALUE AT RISK {money(scenario?.valueAtRisk ?? 0)}</span>
            </div>
            <label className="objective-label" htmlFor="objective">What decision should the agent make?</label>
            <textarea id="objective" value={objective} onChange={(event) => setObjective(event.target.value)} rows={4} />
            <div className="policy-line"><ShieldCheck size={16} /><span><b>PINNED POLICY</b>{scenario?.policy}</span></div>
          </div>

          <aside className="constraint-column">
            <div className="constraint-heading"><span>MEMORY PURCHASE CONTRACT</span><Gauge size={18} /></div>
            <div className="strategy-toggle" aria-label="Optimization strategy">
              {(["economy", "balanced", "quality"] as const).map((strategy) => (
                <button type="button" key={strategy} className={constraints.strategy === strategy ? "active" : ""} onClick={() => setConstraints((current) => ({ ...current, strategy }))}>{strategy}</button>
              ))}
            </div>
            <div className="constraint-control">
              <div><label htmlFor="memory-budget">MEMORY TOKEN BUDGET</label><output>{constraints.maxMemoryTokens} tok</output></div>
              <input id="memory-budget" type="range" min="80" max="900" step="20" value={constraints.maxMemoryTokens} onChange={(event) => setConstraints((current) => ({ ...current, maxMemoryTokens: Number(event.target.value) }))} />
            </div>
            <div className="constraint-control">
              <div><label htmlFor="quality">OUTCOME FLOOR</label><output>{percent(constraints.minSuccess)}</output></div>
              <input id="quality" type="range" min="0.78" max="0.98" step="0.01" value={constraints.minSuccess} onChange={(event) => setConstraints((current) => ({ ...current, minSuccess: Number(event.target.value) }))} />
            </div>
            <div className="constraint-selects">
              <label>CORTEX COST CAP
                <select value={constraints.maxCost} onChange={(event) => setConstraints((current) => ({ ...current, maxCost: Number(event.target.value) }))}>
                  <option value="0.001">$0.0010</option>
                  <option value="0.003">$0.0030</option>
                  <option value="0.006">$0.0060</option>
                </select>
              </label>
              <label>REGION
                <select value={constraints.region} onChange={(event) => setConstraints((current) => ({ ...current, region: event.target.value as RunConstraints["region"] }))}>
                  <option value="ANY_REGION">Any region</option>
                  <option value="AWS_US">AWS US</option>
                  <option value="AWS_EU">AWS EU</option>
                </select>
              </label>
            </div>
            <button className="compile-button" type="button" disabled={runState === "streaming"} onClick={runCompiler}>
              <span>{runState === "streaming" ? <Pulse size={19} /> : <Play size={17} weight="fill" />}</span>
              <b>{runState === "streaming" ? "COMPILING MEMORY" : "RUN COMPLETE EXPERIMENT"}</b>
              <ArrowRight size={17} weight="bold" />
            </button>
          </aside>
        </section>

        <AnimatePresence mode="wait">
          {safeRefusal ? (
            <motion.section className="safe-refusal" role="alert" key="safe-refusal" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}>
              <Warning size={20} weight="fill" />
              <div>
                <span>CONTEXT BANKRUPTCY</span>
                <h2>This contract cannot fund a safe memory portfolio.</h2>
                <p>{error}</p>
              </div>
              <dl>
                <div><dt>MINIMUM SAFE BUDGET</dt><dd>{safeRefusal.minimumTokens} tok</dd></div>
                <div><dt>MINIMUM SAFE COST</dt><dd>{money(safeRefusal.minimumCost)}</dd></div>
              </dl>
            </motion.section>
          ) : error ? (
            <motion.div className="global-error" role="alert" key="global-error" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}>
              <Warning size={17} weight="fill" /><span><b>Run could not complete.</b>{error}</span>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <section className="run-surface" ref={runSurfaceRef} aria-live="polite">
          <div className="run-surface-heading">
            <div><span>LIVE ECONOMIC TRACE</span><h2>{stateTitle}</h2></div>
            <div className="progress-readout"><span>{Math.round(progress * 100)}%</span><i><b style={{ transform: `scaleX(${progress})` }} /></i></div>
          </div>
          <PhaseRail events={events} runState={runState} />
          <EvidenceStrip compile={compile} liveMemories={liveMemories} constraints={constraints} comparison={comparison} ledger={ledger} />
          <SavingsProof comparison={comparison} baselineUsage={baselineUsage} optimizedUsage={optimizedUsage} />

          <div className="product-grid">
            <div className="primary-stack">
              <MemoryAuction compile={compile} liveMemories={liveMemories} />
              <CounterfactualProof counterfactuals={counterfactuals} />
              <section className="surface-panel answer-panel">
                <div className="surface-heading">
                  <div><span>SECONDARY: OPTIMIZED AGENT ANSWER</span><h2>{answer ? "The purchased context produced this decision." : "The optimized answer will appear here."}</h2></div>
                  {evaluation && <div className="outcome-score"><b>{percent(evaluation.score)}</b><small>OUTCOME SCORE</small></div>}
                </div>
                {answer ? (
                  <motion.div className="answer-body" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>{formatAnswer(answer)}</motion.div>
                ) : runState === "streaming" ? (
                  <div className="answer-loading"><i /><i /><i /><span>WAITING FOR OPTIMIZED CORTEX EXECUTION</span></div>
                ) : (
                  <div className="technical-empty answer-empty"><Lightning size={24} /><div><strong>Economic proof comes first.</strong><p>The final answer stays visible, but remains secondary to selection, cost, safety, and ablation evidence.</p></div></div>
                )}
              </section>
            </div>

            <aside className="proof-stack">
              <CompilerProof compile={compile} />
              <RelationshipProof compile={compile} />
              <PolicyProof evaluation={evaluation} />
              <LedgerProof ledger={ledger} />
              <section className="event-console" aria-label="Recent compiler events">
                <div><span>NDJSON EVENT STREAM</span><b>{events.length} EVENTS</b></div>
                {eventLog.length ? eventLog.map((event, index) => (
                  <p key={`${event.type}-${event.progress}-${index}`}><span>{String(Math.round(event.progress * 100)).padStart(3, "0")}</span>{event.message}</p>
                )) : <p><span>000</span>Waiting for a compiler run.</p>}
              </section>
            </aside>
          </div>
        </section>
      </main>

      <footer className="app-footer">
        <span><Brain size={13} /> MEMORY: EVEROS</span>
        <span><Snowflake size={13} /> EXECUTION: SNOWFLAKE CORTEX</span>
        <span><Database size={13} /> EVIDENCE: {(ledger?.mode ?? "LOCAL / READY").toUpperCase()}</span>
        <span><Stack size={13} /> OPTIMIZER: CONSTRAINED MAXIMUM COVERAGE</span>
      </footer>
    </div>
  );
}

export default App;
