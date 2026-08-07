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
  MemoryCandidate,
  ProviderStatus,
  RunConstraints,
  RunEvent,
  RunResult,
  RunUsage,
} from "../shared/contracts";
import { getAppData, streamRun, type ScenarioSummary } from "./api";

type RunState = "idle" | "running" | "complete" | "error";

const phases = [
  { id: "recall", label: "Retrieve", detail: "EverOS candidates", icon: Brain },
  { id: "policy", label: "Pin", detail: "Safety and facts", icon: ShieldCheck },
  { id: "search", label: "Compile", detail: "Memory portfolios", icon: Graph },
  { id: "inference", label: "Compare", detail: "Same-model A/B", icon: ArrowsLeftRight },
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

function PhaseRail({ events }: { events: RunEvent[] }) {
  const currentPhase = events.at(-1)?.phase;
  const currentIndex = phases.findIndex((phase) => phase.id === currentPhase);

  return (
    <section className="phase-rail" aria-label="Economic memory compiler pipeline">
      {phases.map(({ id, label, detail, icon: Icon }, index) => {
        const event = [...events].reverse().find((item) => item.phase === id);
        const complete = currentIndex > index || events.some((item) => item.type === "ledger.completed");
        const active = currentPhase === id && !complete;
        return (
          <div className={`phase-node ${active ? "active" : ""} ${complete ? "complete" : ""}`} key={id}>
            <div className="phase-glyph">
              {complete ? <Check size={15} weight="bold" /> : <Icon size={16} />}
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
  ledger,
}: {
  comparison: ExecutionComparison | null;
  ledger: RunResult["ledger"] | null;
}) {
  if (!comparison) {
    return (
      <section className="savings-proof empty-savings">
        <div><ArrowsLeftRight size={24} /><span>Controlled comparison appears after execution.</span></div>
        <p>Baseline and compiled context use the same Cortex model, generation settings, task, and tools.</p>
      </section>
    );
  }

  return (
    <motion.section
      className="savings-proof"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="hero-saving">
        <span>{comparison.optimized.usage.estimated ? "MODELED CORTEX COST REDUCTION" : "MEASURED CORTEX COST REDUCTION"}</span>
        <strong>{percent(comparison.costReduction)}</strong>
        <small><TrendDown size={15} weight="bold" /> Same model. Fewer purchased memories.</small>
      </div>
      <dl className="comparison-metrics">
        <div>
          <dt>BASELINE INPUT</dt>
          <dd>{comparison.baseline.usage.promptTokens.toLocaleString()}</dd>
          <small>{money(comparison.baseline.usage.actualCost)}</small>
        </div>
        <div>
          <dt>COMPILED INPUT</dt>
          <dd>{comparison.optimized.usage.promptTokens.toLocaleString()}</dd>
          <small>{money(comparison.optimized.usage.actualCost)}</small>
        </div>
        <div>
          <dt>INPUT TOKENS REMOVED</dt>
          <dd>{percent(comparison.tokenReduction)}</dd>
          <small>{comparison.optimized.usage.estimated ? "controlled replay usage" : "provider-reported usage"}</small>
        </div>
        <div>
          <dt>REQUIRED FACTS</dt>
          <dd>{comparison.requiredFactsPreserved ? "PRESERVED" : "FAILED"}</dd>
          <small>{comparison.sameModel ? "model held constant" : "model changed"}</small>
        </div>
      </dl>
      <div className="experiment-contract" aria-label="Controlled experiment contract">
        <div><span>MODEL CONTROL</span><b>{comparison.modelId}</b></div>
        <div><span>GENERATION CONTROL</span><b>TEMP {comparison.generationConfig.temperature} · MAX {comparison.generationConfig.maxCompletionTokens}</b></div>
        <div><span>MEASUREMENT</span><b>{comparison.measurementMode === "live" ? "LIVE CORTEX USAGE" : comparison.measurementMode === "demo" ? "DETERMINISTIC REPLAY" : "MATCHED FALLBACK"}</b></div>
        <div><span>EVIDENCE LEDGER</span><b>{ledger?.mode === "snowflake" ? "SNOWFLAKE SQL" : ledger?.mode === "fallback" ? "LOCAL FALLBACK" : "LOCAL PROOF"}</b></div>
      </div>
    </motion.section>
  );
}

function MemoryBidCard({ memory, index }: { memory: MemoryCandidate; index: number }) {
  return (
    <motion.article
      className={`memory-bid ${memory.selected ? "selected" : "rejected"} ${memory.decisionCode ?? ""}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.025, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="memory-meta">
        <span>{memory.type.replace("_", " ")}</span>
        <b>{memory.tokens} TOK</b>
        <strong>{memory.decisionCode === "pinned" ? "PINNED" : memory.selected ? "BOUGHT" : "REJECTED"}</strong>
      </div>
      <p>{memory.content}</p>
      <div className="memory-economics">
        <span><b>{memory.utilityPer1k?.toFixed(2) ?? "-"}</b> utility / 1K</span>
        <span><b>{percent(memory.relevance)}</b> relevance</span>
        <span><b>{percent(memory.confidence)}</b> confidence</span>
      </div>
      {memory.decision && <small>{memory.decision}</small>}
    </motion.article>
  );
}

function MemoryAuction({
  compile,
  liveMemories,
}: {
  compile: CompileResult | null;
  liveMemories: MemoryCandidate[];
}) {
  const memories = compile?.memories ?? liveMemories;
  const selectedCount = compile?.selected.memoryIds.length ?? 0;
  const tokenCount = compile?.selected.memoryTokens ?? 0;
  const orderedMemories = [
    ...memories.filter((memory) => memory.selected),
    ...memories.filter((memory) => !memory.selected),
  ];
  const visibleMemories = orderedMemories.slice(0, 6);
  const ledgerMemories = orderedMemories.slice(6);

  return (
    <section className="surface-panel memory-auction">
      <div className="surface-heading">
        <div>
          <span>LIVE MEMORY MARKET</span>
          <h2>Every memory must justify its token price.</h2>
        </div>
        <div className="heading-stat">
          <b>{selectedCount}/{memories.length || 15}</b>
          <small>{tokenCount.toLocaleString()} TOKENS BOUGHT</small>
        </div>
      </div>

      {!memories.length ? (
        <div className="technical-empty">
          <Brain size={24} />
          <div><strong>Waiting for EverOS.</strong><p>Fifteen candidate memories will enter the compiler.</p></div>
        </div>
      ) : (
        <>
          <div className="memory-grid">
            {visibleMemories.map((memory, index) => <MemoryBidCard key={memory.id} memory={memory} index={index} />)}
          </div>
          {ledgerMemories.length > 0 && (
            <details className="memory-overflow">
              <summary>
                <span><b>REJECTED AUCTION LEDGER</b>{ledgerMemories.length} lower-value memories remain inspectable</span>
                <strong>SHOW ALL CANDIDATES <CaretDown size={14} /></strong>
              </summary>
              <div className="memory-grid overflow-grid">
                {ledgerMemories.map((memory, index) => <MemoryBidCard key={memory.id} memory={memory} index={index + visibleMemories.length} />)}
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function MemoryFrontier({ compile }: { compile: CompileResult }) {
  const plans = compile.frontier.length ? compile.frontier : compile.alternatives;
  const minTokens = Math.min(...plans.map((plan) => plan.memoryTokens), 0);
  const maxTokens = Math.max(...plans.map((plan) => plan.memoryTokens), 1);
  const minSuccess = Math.min(...plans.map((plan) => plan.successProbability), 0.78);
  const x = (tokens: number) => 30 + ((tokens - minTokens) / Math.max(1, maxTokens - minTokens)) * 335;
  const y = (success: number) => 105 - ((success - minSuccess) / Math.max(0.01, 1 - minSuccess)) * 80;

  return (
    <div className="frontier-plot">
      <svg viewBox="0 0 400 126" role="img" aria-label="Memory token and outcome quality frontier">
        <line x1="30" y1="105" x2="378" y2="105" className="chart-axis" />
        <line x1="30" y1="18" x2="30" y2="105" className="chart-axis" />
        {plans.map((plan) => {
          const selected = plan.id === compile.selected.id;
          return (
            <circle
              key={plan.id}
              cx={x(plan.memoryTokens)}
              cy={y(plan.successProbability)}
              r={selected ? 7 : 3.2}
              className={selected ? "plan-dot selected" : "plan-dot"}
            >
              <title>{`${plan.memoryTokens} memory tokens, ${percent(plan.successProbability)} expected quality`}</title>
            </circle>
          );
        })}
      </svg>
      <span className="plot-label tokens">FEWER MEMORY TOKENS</span>
      <span className="plot-label quality">HIGHER OUTCOME QUALITY</span>
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
            <span>MARGINAL VALUE</span>
            <code>[Utility(S + m) - Utility(S)] / TokenCost(m)</code>
            <small>Subject to safety, coverage, dependency, quality, region, latency, and budget constraints.</small>
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
  return (
    <section className="surface-panel relationship-proof">
      <div className="surface-heading compact">
        <div><span>MEMORY GRAPH</span><h2>Relationships affect the price.</h2></div>
        <LinkSimple size={20} />
      </div>
      {compile?.relationshipEdges.length ? (
        <div className="relationship-list">
          {compile.relationshipEdges.map((edge) => (
            <div key={`${edge.sourceId}-${edge.targetId}-${edge.type}`} className={`relation ${edge.type}`}>
              <span>{names.get(edge.sourceId)?.slice(0, 42)}</span>
              <b>{edge.type.replace("_", " ")}</b>
              <span>{names.get(edge.targetId)?.slice(0, 42)}</span>
              <small>{percent(edge.strength)}</small>
            </div>
          ))}
        </div>
      ) : (
        <div className="technical-empty small"><CirclesThreePlus size={22} /><p>Duplicate, contradiction, dependency, and complement edges appear here.</p></div>
      )}
    </section>
  );
}

function CounterfactualProof({
  counterfactuals,
}: {
  counterfactuals: CounterfactualResult[];
}) {
  return (
    <section className="surface-panel counterfactual-proof">
      <div className="surface-heading compact">
        <div><span>COUNTERFACTUAL LAB</span><h2>Did this memory change the answer?</h2></div>
        <Flask size={20} />
      </div>
      {counterfactuals.length ? (
        <div className="ablation-list">
          {counterfactuals.map((item) => (
            <article key={item.memoryId} className={item.policyPassed ? "safe" : "failed"}>
              <div>
                <span>{item.role === "rejected_control" ? "REJECTED CONTROL" : item.role.toUpperCase()}</span>
                <small>{item.mode === "live" ? "LIVE CORTEX" : item.mode === "demo" ? "REPLAY" : "FALLBACK"}</small>
                <b>{item.outcomeChanged ? "OUTCOME CHANGED" : "NO MATERIAL CHANGE"}</b>
              </div>
              <p>{item.memoryContent}</p>
              <small>{item.detail}</small>
              <dl>
                <div><dt>QUALITY DELTA</dt><dd>{(item.qualityDelta * 100).toFixed(1)} pt</dd></div>
                <div><dt>POLICY</dt><dd>{item.policyPassed ? "PASS" : "FAIL"}</dd></div>
                <div><dt>REQUIRED FACTS</dt><dd>{item.requiredFactsPreserved ? "PASS" : "FAIL"}</dd></div>
                <div><dt>RECHECK TOKENS</dt><dd>{item.promptTokens.toLocaleString()}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <div className="technical-empty small"><Flask size={22} /><p>TokenOS will remove pinned, purchased, and rejected-control memories and recheck the outcome.</p></div>
      )}
    </section>
  );
}

function PolicyProof({ evaluation }: { evaluation: Evaluation | null }) {
  return (
    <section className="surface-panel policy-proof">
      <div className="surface-heading compact">
        <div><span>SAFETY PROOF</span><h2>{evaluation ? (evaluation.policyPassed ? "All constraints survived" : "Unsafe context") : "Awaiting outcome"}</h2></div>
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
  const [runState, setRunState] = useState<RunState>("idle");
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [liveMemories, setLiveMemories] = useState<MemoryCandidate[]>([]);
  const [compile, setCompile] = useState<CompileResult | null>(null);
  const [answer, setAnswer] = useState("");
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [comparison, setComparison] = useState<ExecutionComparison | null>(null);
  const [counterfactuals, setCounterfactuals] = useState<CounterfactualResult[]>([]);
  const [ledger, setLedger] = useState<RunResult["ledger"] | null>(null);
  const [error, setError] = useState("");
  const [completedRuns, setCompletedRuns] = useState(0);
  const runSurfaceRef = useRef<HTMLElement>(null);
  const reduceMotion = useReducedMotion();
  const scenario = scenarios.find((item) => item.id === scenarioId) ?? scenarios[0];
  const progress = events.at(-1)?.progress ?? 0;
  const eventLog = useMemo(() => events.slice(-6).reverse(), [events]);

  useEffect(() => {
    getAppData()
      .then((data) => {
        setProviders(data.providers);
        setScenarios(data.scenarios);
      })
      .catch(() => setProviders({
        everos: "demo",
        snowflake: "demo",
        message: "Start the TokenOS API to run the compiler.",
      }));
  }, []);

  function resetRun(clearObjective = false) {
    setRunState("idle");
    setEvents([]);
    setLiveMemories([]);
    setCompile(null);
    setAnswer("");
    setEvaluation(null);
    setComparison(null);
    setCounterfactuals([]);
    setLedger(null);
    setError("");
    if (clearObjective) setObjective(scenario.objective);
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
    if (event.type === "recall.completed") {
      const data = event.data as { memories?: MemoryCandidate[]; mode?: ProviderStatus["everos"] };
      setLiveMemories(data.memories ?? []);
      if (data.mode) setProviders((current) => ({ ...current, everos: data.mode! }));
    }
    if (event.type === "search.completed") setCompile(event.data as CompileResult);
    if (event.type === "optimized.completed") {
      const data = event.data as { answer: string; usage: RunUsage; mode: ProviderStatus["snowflake"] };
      setAnswer(data.answer);
      setProviders((current) => ({ ...current, snowflake: data.mode }));
    }
    if (event.type === "inference.completed") {
      const data = event.data as { comparison: ExecutionComparison };
      setComparison(data.comparison);
    }
    if (event.type === "evaluation.completed") setEvaluation(event.data as Evaluation);
    if (event.type === "counterfactual.completed") setCounterfactuals(event.data as CounterfactualResult[]);
    if (event.type === "ledger.completed") {
      const result = event.data as RunResult;
      setCompile(result.compile);
      setAnswer(result.answer);
      setEvaluation(result.evaluation);
      setComparison(result.comparison);
      setCounterfactuals(result.counterfactuals);
      setLedger(result.ledger);
      setProviders(result.providers);
      setRunState("complete");
      setCompletedRuns((count) => count + 1);
    }
    if (event.type === "run.error") {
      const data = event.data as { compile?: CompileResult } | undefined;
      if (data?.compile) setCompile(data.compile);
      setError(event.message);
      setRunState("error");
    }
  }

  async function runCompiler() {
    if (objective.trim().length < 12) {
      setError("Describe a concrete task before running the compiler.");
      return;
    }
    resetRun(false);
    setRunState("running");
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
            <h1>Every memory has a token price. Buy only what changes the answer.</h1>
          </div>
          <p>TokenOS compiles the cheapest safe context, then proves the savings against a full-memory Cortex baseline.</p>
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
              <div>
                <label htmlFor="memory-budget">MEMORY TOKEN BUDGET</label>
                <output htmlFor="memory-budget">
                  <input
                    type="number"
                    min="1"
                    max="900"
                    step="1"
                    aria-label="Exact memory token budget"
                    value={constraints.maxMemoryTokens}
                    onChange={(event) => setConstraints((current) => ({ ...current, maxMemoryTokens: Math.max(1, Math.min(900, Number(event.target.value) || 1)) }))}
                  />
                  <span>tok</span>
                </output>
              </div>
              <input id="memory-budget" type="range" min="160" max="900" step="1" value={constraints.maxMemoryTokens} onChange={(event) => setConstraints((current) => ({ ...current, maxMemoryTokens: Number(event.target.value) }))} />
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
            <button className="compile-button" type="button" disabled={runState === "running"} onClick={runCompiler}>
              <span>{runState === "running" ? <Pulse size={19} /> : <Play size={17} weight="fill" />}</span>
              <b>{runState === "running" ? "COMPILING MEMORY" : "COMPILE + PROVE"}</b>
              <ArrowRight size={17} weight="bold" />
            </button>
          </aside>
        </section>

        <AnimatePresence>
          {error && (
            <motion.div className="global-error" role="alert" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}>
              <Warning size={17} weight="fill" /><span><b>Compiler refused the run.</b>{error}</span>
              {compile && !compile.selected.feasible && (
                <button type="button" onClick={() => setConstraints((current) => ({ ...current, maxMemoryTokens: compile.minimumSafeMemoryTokens }))}>
                  APPLY {compile.minimumSafeMemoryTokens} TOKEN SAFE FLOOR
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <section className="run-surface" ref={runSurfaceRef}>
          <div className="run-surface-heading">
            <div><span>LIVE ECONOMIC TRACE</span><h2>{runState === "idle" ? "Ready to price memory" : runState === "running" ? "Controlled experiment running" : runState === "complete" ? "Savings proven" : "Safe budget required"}</h2></div>
            <div className="progress-readout"><span>{Math.round(progress * 100)}%</span><i><b style={{ transform: `scaleX(${progress})` }} /></i></div>
          </div>
          <PhaseRail events={events} />
          <SavingsProof comparison={comparison} ledger={ledger} />

          <div className="product-grid">
            <div className="primary-stack">
              <section className="surface-panel answer-panel">
                <div className="surface-heading">
                  <div><span>COMPILED AGENT OUTPUT</span><h2>{answer ? "The purchased context produced this decision." : "The optimized answer will appear here."}</h2></div>
                  {evaluation && <div className="outcome-score"><b>{percent(evaluation.score)}</b><small>OUTCOME SCORE</small></div>}
                </div>
                {answer ? <motion.div className="answer-body" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>{formatAnswer(answer)}</motion.div> : runState === "running" ? (
                  <div className="answer-loading"><i /><i /><i /><span>Waiting for the compiled Cortex response</span></div>
                ) : (
                  <div className="technical-empty answer-empty"><Lightning size={24} /><div><strong>One run creates five pieces of evidence.</strong><p>Baseline, optimized context, token delta, safety result, and counterfactual ablations.</p></div></div>
                )}
              </section>
              <MemoryAuction compile={compile} liveMemories={liveMemories} />
              <CounterfactualProof counterfactuals={counterfactuals} />
            </div>

            <aside className="proof-stack">
              <CompilerProof compile={compile} />
              <RelationshipProof compile={compile} />
              <PolicyProof evaluation={evaluation} />
              <details className="event-console" open={runState === "running"}>
                <summary><span>EXECUTION TRACE</span><b>{events.length} EVENTS</b></summary>
                <div className="event-log" aria-label="Recent compiler events">
                  {eventLog.length ? eventLog.map((event, index) => (
                    <p key={`${event.type}-${event.progress}-${index}`}><span>{String(Math.round(event.progress * 100)).padStart(3, "0")}</span>{event.message}</p>
                  )) : <p><span>000</span>Waiting for a compiler run.</p>}
                </div>
              </details>
            </aside>
          </div>
        </section>
      </main>

      <footer className="app-footer">
        <span><Brain size={13} /> MEMORY: EVEROS V2</span>
        <span><Snowflake size={13} /> EXECUTION: SNOWFLAKE CORTEX</span>
        <span><Database size={13} /> EVIDENCE: {events.some((event) => event.type === "ledger.completed" && (event.data as RunResult).ledger.mode === "snowflake") ? "SNOWFLAKE SQL" : "LOCAL / READY"}</span>
        <span><Stack size={13} /> OPTIMIZER: CONSTRAINED MAXIMUM COVERAGE</span>
      </footer>
    </div>
  );
}

export default App;
