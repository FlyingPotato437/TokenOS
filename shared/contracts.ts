export type Strategy = "economy" | "balanced" | "quality";
export type Region = "ANY_REGION" | "AWS_US" | "AWS_EU";
export type MemoryType = "profile" | "episode" | "event" | "agent_case" | "policy";
export type ProviderMode = "demo" | "live" | "fallback";
export type MemoryRelationType = "duplicate" | "contradicts" | "depends_on" | "complements";

export type MemoryRelationship = {
  sourceId: string;
  targetId: string;
  type: MemoryRelationType;
  strength: number;
};

export type RunConstraints = {
  maxCost: number;
  maxLatencyMs: number;
  minSuccess: number;
  strategy: Strategy;
  region: Region;
  maxMemoryTokens: number;
};

export type MemoryCandidate = {
  id: string;
  content: string;
  source: string;
  type: MemoryType;
  tokens: number;
  relevance: number;
  confidence: number;
  successLift: number;
  recency?: number;
  requiredFacts?: string[];
  relationships?: Array<Omit<MemoryRelationship, "sourceId">>;
  policyCritical?: boolean;
  selected?: boolean;
  utilityPer1k?: number;
  decision?: string;
  decisionCode?: "pinned" | "selected" | "redundant" | "contradiction" | "low_value" | "irrelevant";
};

export type ToolOption = {
  id: string;
  name: string;
  description: string;
  estimatedCost: number;
  latencyMs: number;
  successLift: number;
  required?: boolean;
};

export type ModelOption = {
  id: string;
  name: string;
  shortName: string;
  inputCreditsPerMillion: number;
  outputCreditsPerMillion: number;
  reliability: number;
  latencyMs: number;
  expectedOutputTokens: number;
  regions: Region[];
};

export type Scenario = {
  id: string;
  name: string;
  tag: string;
  objective: string;
  valueAtRisk: number;
  policy: string;
  requiredFacts?: string[];
  memories: MemoryCandidate[];
  tools: ToolOption[];
  demoAnswer: string;
};

export type PlanCandidate = {
  id: string;
  modelId: string;
  modelName: string;
  memoryIds: string[];
  toolIds: string[];
  estimatedCost: number;
  successProbability: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  memoryTokens: number;
  coveredFacts: string[];
  redundancyPenalty: number;
  score: number;
  feasible: boolean;
  blockers: string[];
};

export type CounterfactualPlan = {
  id: string;
  memoryId: string;
  memoryContent: string;
  role: "pinned" | "selected" | "rejected_control";
  plan: PlanCandidate;
  expectedQualityDelta: number;
  expectedPolicyPassed: boolean;
};

export type CompileResult = {
  selected: PlanCandidate;
  baseline: PlanCandidate;
  alternatives: PlanCandidate[];
  frontier: PlanCandidate[];
  memories: MemoryCandidate[];
  evaluatedCount: number;
  feasibleCount: number;
  dominatedCount: number;
  objectiveFunction: string;
  relationshipEdges: MemoryRelationship[];
  minimumSafeCost: number;
  minimumSafeMemoryTokens: number;
  counterfactualPlans: CounterfactualPlan[];
};

export type ProviderStatus = {
  everos: ProviderMode;
  snowflake: ProviderMode;
  message: string;
};

export type RunUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  actualCost: number;
  estimated: boolean;
};

export type Evaluation = {
  score: number;
  policyPassed: boolean;
  checks: Array<{ label: string; passed: boolean; detail: string }>;
};

export type ExecutionVariant = {
  answer: string;
  usage: RunUsage;
  evaluation: Evaluation;
};

export type ExecutionComparison = {
  baseline: ExecutionVariant;
  optimized: ExecutionVariant;
  tokenReduction: number;
  costReduction: number;
  requiredFactsPreserved: boolean;
  sameModel: boolean;
};

export type CounterfactualResult = {
  memoryId: string;
  memoryContent: string;
  role: CounterfactualPlan["role"];
  promptTokens: number;
  qualityDelta: number;
  policyPassed: boolean;
  outcomeChanged: boolean;
  detail: string;
};

export type LedgerStatus = {
  mode: "local" | "snowflake" | "fallback";
  detail: string;
};

export type RunResult = {
  runId: string;
  scenarioId: string;
  objective: string;
  answer: string;
  compile: CompileResult;
  usage: RunUsage;
  evaluation: Evaluation;
  comparison: ExecutionComparison;
  counterfactuals: CounterfactualResult[];
  providers: ProviderStatus;
  ledger: LedgerStatus;
  createdAt: string;
};

export type RunEvent = {
  type:
    | "run.started"
    | "recall.started"
    | "recall.completed"
    | "policy.completed"
    | "search.started"
    | "search.completed"
    | "inference.started"
    | "baseline.completed"
    | "optimized.completed"
    | "inference.completed"
    | "evaluation.completed"
    | "counterfactual.completed"
    | "ledger.completed"
    | "run.error";
  phase: "init" | "recall" | "policy" | "search" | "inference" | "evaluation" | "ledger";
  progress: number;
  message: string;
  data?: unknown;
};

export type RunRequest = {
  scenarioId: string;
  objective: string;
  constraints: RunConstraints;
};
