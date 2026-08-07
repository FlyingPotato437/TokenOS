export type Strategy = "economy" | "balanced" | "quality";
export type MemoryType = "profile" | "episode" | "event" | "agent_case" | "agent_skill" | "policy";
export type ProviderMode = "live" | "replay" | "mixed";
export type MemoryRelationType = "duplicate" | "contradicts" | "depends_on" | "complements";

export type MemoryRelationship = {
  sourceId: string;
  targetId: string;
  type: MemoryRelationType;
  strength: number;
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
  historicalOutcomeLift?: number;
  learnedCaseId?: string;
  recency?: number;
  requiredFacts?: string[];
  relationships?: Array<Omit<MemoryRelationship, "sourceId">>;
  policyCritical?: boolean;
  selected?: boolean;
  utilityPer1k?: number;
  decision?: string;
  decisionCode?:
    | "pinned"
    | "selected"
    | "learned_case"
    | "dependency"
    | "complement"
    | "redundant"
    | "contradiction"
    | "stale"
    | "low_value"
    | "irrelevant";
};

export type ToolOption = {
  id: string;
  name: string;
  description: string;
  required?: boolean;
  estimatedCost?: number;
  latencyMs?: number;
  successLift?: number;
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
  relationshipLift?: number;
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
  expectedRequiredFactsPreserved: boolean;
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
  minimumSafeMemoryIds: string[];
  counterfactualPlans: CounterfactualPlan[];
};

export type CounterfactualResult = {
  memoryId: string;
  memoryContent: string;
  role: CounterfactualPlan["role"];
  inputTokens: number;
  qualityDelta: number;
  policyPassed: boolean;
  requiredFactsPreserved: boolean;
  outcomeChanged: boolean;
  mode: ProviderMode;
  detail: string;
};

export type Evaluation = {
  score: number;
  policyPassed: boolean;
  checks: Array<{ label: string; passed: boolean; detail: string }>;
};
