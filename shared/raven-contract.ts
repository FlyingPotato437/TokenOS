import type {
  CompileResult,
  CounterfactualResult,
  Evaluation,
  MemoryCandidate,
  ProviderMode,
  Strategy,
} from "./contracts.js";

export type MemoryGovernorConstraints = {
  maxMemoryTokens: number;
  minSuccess: number;
  strategy: Strategy;
};

export type RavenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimated: boolean;
};

export type RavenExecutionContract = {
  runtime: "raven";
  model: string;
  tools: string[];
  taskFingerprint: string;
  generationConfig: {
    temperature: number;
    maxOutputTokens: number;
  };
};

export type RavenExecutionVariant = {
  kind: "uncontrolled" | "governed";
  answer: string;
  memoryIds: string[];
  memoriesLoaded: number;
  memoryTokens: number;
  usage: RavenUsage;
  evaluation: Evaluation;
  executionContract: RavenExecutionContract;
};

export type RavenComparison = {
  uncontrolled: RavenExecutionVariant;
  governed: RavenExecutionVariant;
  tokenReduction: number;
  memoryTokenReduction: number;
  requiredFactsPreserved: boolean;
  sameRuntime: boolean;
  sameModel: boolean;
  sameTask: boolean;
  sameTools: boolean;
  sameSettings: boolean;
  executionContract: RavenExecutionContract;
  measurementMode: "live" | "replay";
};

export type RavenProviderStatus = {
  everos: ProviderMode;
  raven: "live" | "replay";
  message: string;
};

export type LearningReceipt = {
  mode: "everos" | "local" | "mixed";
  written: boolean;
  agentCaseId: string;
  lesson: string;
  historicalLiftApplied: boolean;
  detail: string;
};

export type LocalRunLedgerStatus = {
  mode: "disk" | "memory";
  entryId: string;
  path: string;
  detail: string;
};

export type RavenRunResult = {
  kind: "completed";
  runId: string;
  scenarioId: string;
  objective: string;
  answer: string;
  compile: CompileResult;
  comparison: RavenComparison;
  counterfactuals: CounterfactualResult[];
  providers: RavenProviderStatus;
  ledger: LocalRunLedgerStatus;
  learning: LearningReceipt;
  createdAt: string;
};

export type SafeBudgetRefusal = {
  kind: "safe_budget_refusal";
  runId: string;
  scenarioId: string;
  objective: string;
  requestedBudget: number;
  minimumSafeBudget: number;
  minimumSafeMemoryIds: string[];
  missingPolicyMemoryIds: string[];
  missingRequiredFacts: string[];
  message: string;
  createdAt: string;
};

export type RavenRunOutcome = RavenRunResult | SafeBudgetRefusal;

export type RavenRunRequest = {
  scenarioId: string;
  objective: string;
  constraints: MemoryGovernorConstraints;
};

export type RavenPipelinePhase = "init" | "recall" | "price" | "connect" | "compile" | "execute" | "learn";

export type RavenRunEventType =
  | "run.started"
  | "recall.started"
  | "recall.completed"
  | "price.completed"
  | "connect.completed"
  | "compile.started"
  | "compile.completed"
  | "compile.refused"
  | "raven.started"
  | "uncontrolled.completed"
  | "governed.completed"
  | "comparison.completed"
  | "learn.started"
  | "learn.completed"
  | "run.completed"
  | "run.error";

export type RavenRunEvent = {
  type: RavenRunEventType;
  phase: RavenPipelinePhase;
  progress: number;
  message: string;
  data?: unknown;
};

export type MemoryAuctionCandidate = MemoryCandidate & {
  historicalOutcomeLift?: number;
  learnedCaseId?: string;
};

export const RAVEN_SUCCESS_EVENT_ORDER: RavenRunEventType[] = [
  "run.started",
  "recall.started",
  "recall.completed",
  "price.completed",
  "connect.completed",
  "compile.started",
  "compile.completed",
  "raven.started",
  "uncontrolled.completed",
  "governed.completed",
  "comparison.completed",
  "learn.started",
  "learn.completed",
  "run.completed",
];
