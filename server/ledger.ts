import type { LedgerStatus, RunResult } from "../shared/contracts.ts";

type SqlApiResponse = {
  code?: string;
  message?: string;
  statementHandle?: string;
  statementStatusUrl?: string;
};

type SqlRequest = {
  statement: string;
  bindings?: Record<string, { type: "TEXT"; value: string }>;
};

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function configured(value: string | undefined) {
  return Boolean(value && value.trim() && !value.includes("your-account"));
}

function requiredIdentifier(value: string | undefined, fallback?: string) {
  const identifier = (value || fallback || "").trim();
  if (!identifierPattern.test(identifier)) {
    throw new Error(`Invalid Snowflake identifier: ${identifier || "missing value"}`);
  }
  return identifier;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sqlHeaders(pat: string) {
  return {
    Authorization: `Bearer ${pat}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "TokenOS/1.0",
    "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN",
  };
}

async function readSqlResponse(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as SqlApiResponse;
  if (!response.ok && response.status !== 202) {
    throw new Error(payload.message || `Snowflake SQL API returned ${response.status}`);
  }
  return payload;
}

async function submitStatement(request: SqlRequest) {
  const accountUrl = process.env.SNOWFLAKE_ACCOUNT_URL!;
  const pat = process.env.SNOWFLAKE_PAT!;
  const database = requiredIdentifier(process.env.SNOWFLAKE_DATABASE);
  const schema = requiredIdentifier(process.env.SNOWFLAKE_SCHEMA);
  const warehouse = process.env.SNOWFLAKE_WAREHOUSE?.trim();
  const role = process.env.SNOWFLAKE_ROLE?.trim();

  const response = await fetch(`${accountUrl.replace(/\/$/, "")}/api/v2/statements`, {
    method: "POST",
    headers: sqlHeaders(pat),
    body: JSON.stringify({
      ...request,
      timeout: 45,
      database,
      schema,
      ...(warehouse ? { warehouse } : {}),
      ...(role ? { role } : {}),
    }),
    signal: AbortSignal.timeout(50_000),
  });
  let payload = await readSqlResponse(response);

  for (let attempt = 0; response.status === 202 && attempt < 8; attempt += 1) {
    await wait(350 + attempt * 150);
    const statusPath = payload.statementStatusUrl ||
      (payload.statementHandle ? `/api/v2/statements/${payload.statementHandle}` : "");
    if (!statusPath) throw new Error("Snowflake returned an async query without a status URL.");
    const statusUrl = statusPath.startsWith("http")
      ? statusPath
      : `${accountUrl.replace(/\/$/, "")}${statusPath.startsWith("/") ? "" : "/"}${statusPath}`;
    const statusResponse = await fetch(statusUrl, {
      headers: sqlHeaders(pat),
      signal: AbortSignal.timeout(10_000),
    });
    payload = await readSqlResponse(statusResponse);
    if (statusResponse.status !== 202) return payload;
  }

  if (response.status === 202) {
    throw new Error("Snowflake ledger statement is still running.");
  }
  return payload;
}

export async function persistRunToSnowflake(
  run: Omit<RunResult, "ledger">,
): Promise<LedgerStatus> {
  const accountUrl = process.env.SNOWFLAKE_ACCOUNT_URL;
  const pat = process.env.SNOWFLAKE_PAT;
  const database = process.env.SNOWFLAKE_DATABASE;
  const schema = process.env.SNOWFLAKE_SCHEMA;

  if (!configured(accountUrl) || !configured(pat) || !configured(database) || !configured(schema)) {
    return {
      mode: "local",
      detail: "Run retained in the in-process ledger. Configure Snowflake database and schema to persist it.",
    };
  }

  try {
    const table = requiredIdentifier(process.env.SNOWFLAKE_LEDGER_TABLE, "TOKENOS_RUN_LEDGER");
    const fullyQualifiedTable = [
      requiredIdentifier(database),
      requiredIdentifier(schema),
      table,
    ].join(".");

    await submitStatement({
      statement: `CREATE TABLE IF NOT EXISTS ${fullyQualifiedTable} (
        RUN_ID STRING PRIMARY KEY,
        CREATED_AT TIMESTAMP_TZ,
        SCENARIO_ID STRING,
        OBJECTIVE STRING,
        MODEL_NAME STRING,
        MEMORY_COUNT NUMBER,
        TOOL_COUNT NUMBER,
        ESTIMATED_COST FLOAT,
        ACTUAL_COST FLOAT,
        SUCCESS_PROBABILITY FLOAT,
        EVALUATION_SCORE FLOAT,
        PROMPT_TOKENS NUMBER,
        COMPLETION_TOKENS NUMBER,
        BASELINE_COST FLOAT,
        BASELINE_PROMPT_TOKENS NUMBER,
        OPTIMIZED_PROMPT_TOKENS NUMBER,
        TOKEN_REDUCTION FLOAT,
        COST_REDUCTION FLOAT,
        REQUIRED_FACTS_PRESERVED BOOLEAN,
        PROVIDER_MODE STRING,
        PLAN_JSON VARIANT,
        COUNTERFACTUAL_JSON VARIANT
      )`,
    });

    const payload = JSON.stringify({
      runId: run.runId,
      createdAt: run.createdAt,
      scenarioId: run.scenarioId,
      objective: run.objective,
      modelName: run.compile.selected.modelName,
      memoryCount: run.compile.selected.memoryIds.length,
      toolCount: run.compile.selected.toolIds.length,
      estimatedCost: run.compile.selected.estimatedCost,
      actualCost: run.usage.actualCost,
      successProbability: run.compile.selected.successProbability,
      evaluationScore: run.evaluation.score,
      promptTokens: run.usage.promptTokens,
      completionTokens: run.usage.completionTokens,
      baselineCost: run.compile.baseline.estimatedCost,
      baselinePromptTokens: run.comparison.baseline.usage.promptTokens,
      optimizedPromptTokens: run.comparison.optimized.usage.promptTokens,
      tokenReduction: run.comparison.tokenReduction,
      costReduction: run.comparison.costReduction,
      requiredFactsPreserved: run.comparison.requiredFactsPreserved,
      providerMode: run.providers.snowflake,
      plan: run.compile.selected,
      counterfactuals: run.counterfactuals,
    });

    await submitStatement({
      statement: `INSERT INTO ${fullyQualifiedTable} (
        RUN_ID, CREATED_AT, SCENARIO_ID, OBJECTIVE, MODEL_NAME, MEMORY_COUNT, TOOL_COUNT,
        ESTIMATED_COST, ACTUAL_COST, SUCCESS_PROBABILITY, EVALUATION_SCORE, PROMPT_TOKENS,
        COMPLETION_TOKENS, BASELINE_COST, BASELINE_PROMPT_TOKENS, OPTIMIZED_PROMPT_TOKENS,
        TOKEN_REDUCTION, COST_REDUCTION, REQUIRED_FACTS_PRESERVED, PROVIDER_MODE, PLAN_JSON,
        COUNTERFACTUAL_JSON
      )
      SELECT
        value:runId::STRING,
        TO_TIMESTAMP_TZ(value:createdAt::STRING),
        value:scenarioId::STRING,
        value:objective::STRING,
        value:modelName::STRING,
        value:memoryCount::NUMBER,
        value:toolCount::NUMBER,
        value:estimatedCost::FLOAT,
        value:actualCost::FLOAT,
        value:successProbability::FLOAT,
        value:evaluationScore::FLOAT,
        value:promptTokens::NUMBER,
        value:completionTokens::NUMBER,
        value:baselineCost::FLOAT,
        value:baselinePromptTokens::NUMBER,
        value:optimizedPromptTokens::NUMBER,
        value:tokenReduction::FLOAT,
        value:costReduction::FLOAT,
        value:requiredFactsPreserved::BOOLEAN,
        value:providerMode::STRING,
        value:plan::VARIANT,
        value:counterfactuals::VARIANT
      FROM (SELECT PARSE_JSON(?) AS value)`,
      bindings: { "1": { type: "TEXT", value: payload } },
    });

    return {
      mode: "snowflake",
      detail: `Run persisted to ${fullyQualifiedTable}.`,
    };
  } catch (error) {
    return {
      mode: "fallback",
      detail: `Snowflake ledger fallback: ${error instanceof Error ? error.message : "request failed"}`,
    };
  }
}
