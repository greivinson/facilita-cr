import { fileURLToPath } from "node:url";
import { executeSql, executeSqlFile } from "../database/index.js";
import { discoverProviderCatalog, PROVIDERS } from "./catalog-discovery.js";
import { rankProviderModels } from "./model-ranking.js";
import { appendCatalogHistory } from "./model-history.js";
import { callOpenRouter } from "./providers/openrouter.js";
import { recordModelFunctionalityPass } from "./model-functionality.js";

const FUNCTIONALITY_PROBE_MODEL = "google/gemma-4-26b-a4b-it:free";

function catalogCandidates(result) {
  const models = result.models.slice(0, 7);
  if (result.provider === "openrouter") {
    const probeCandidate = result.models.find((model) => model.model_id === FUNCTIONALITY_PROBE_MODEL);
    if (probeCandidate && !models.includes(probeCandidate)) models[6] = probeCandidate;
  }
  return models;
}

function quote(value) {
  return value === null || value === undefined ? "NULL" : `'${String(value).replace(/'/g, "''")}'`;
}

function sanitizeErrorMessage(message, secrets = []) {
  let safe = String(message || "Refresh failed").replace(/[\r\n\t]+/g, " ").slice(0, 300);
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join("[REDACTED]");
  }
  return safe
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|gsk_[0-9A-Za-z_-]{16,}|sk-or-[0-9A-Za-z_-]{16,})\b/g, "[REDACTED]");
}

function readProviderKeys(env = process.env) {
  return Object.fromEntries(
    PROVIDERS.map(({ keyName }) => {
      const value = env[keyName];
      return [keyName, typeof value === "string" && value.trim() ? value.trim() : undefined];
    })
  );
}

function readFreeModelPolicies(env = process.env) {
  return {
    google: (env.GEMINI_FREE_MODEL_IDS || "")
      .split(",")
      .map((modelId) => modelId.trim().replace(/^models\//, ""))
      .filter(Boolean),
    groq: (env.GROQ_FREE_MODEL_IDS || "")
      .split(",")
      .map((modelId) => modelId.trim())
      .filter(Boolean),
  };
}

function statusStatement(result) {
  const status = quote(result.status);
  const count = result.status === "success" ? result.models.length : null;
  const errorCode = result.error_code ? quote(result.error_code) : "NULL";
  const errorMessage = result.error_message ? quote(result.error_message) : "NULL";
  const rankingStatus = quote(result.ranking_status || "not_attempted");
  const rankerProvider = result.ranker_provider ? quote(result.ranker_provider) : "NULL";
  const rankerModel = result.ranker_model_id ? quote(result.ranker_model_id) : "NULL";
  const rankingError = result.ranking_error ? quote(result.ranking_error) : "NULL";
  return `INSERT INTO ai_model_catalog_status
    (provider, status, last_attempt_at, last_success_at, model_count, error_code, error_message,
     ranking_status, ranker_provider, ranker_model_id, ranking_error)
    VALUES (${quote(result.provider)}, ${status}, datetime('now'),
      CASE WHEN ${status} = 'success' THEN datetime('now') ELSE NULL END,
      ${count === null ? "NULL" : count}, ${errorCode}, ${errorMessage},
      ${rankingStatus}, ${rankerProvider}, ${rankerModel}, ${rankingError})
    ON CONFLICT(provider) DO UPDATE SET
      status = excluded.status,
      last_attempt_at = datetime('now'),
      last_success_at = CASE WHEN excluded.status = 'success'
        THEN datetime('now') ELSE ai_model_catalog_status.last_success_at END,
      model_count = CASE WHEN excluded.status = 'success'
        THEN excluded.model_count ELSE ai_model_catalog_status.model_count END,
      error_code = excluded.error_code,
      error_message = excluded.error_message,
      ranking_status = excluded.ranking_status,
      ranker_provider = excluded.ranker_provider,
      ranker_model_id = excluded.ranker_model_id,
      ranking_error = excluded.ranking_error;`;
}

export function buildProviderCatalogSql(result, ranking = null) {
  if (result.status !== "success") {
    return statusStatement({
      ...result,
      ranking_status: "not_attempted_discovery_failed",
      ranker_provider: ranking?.provider,
      ranker_model_id: ranking?.model_id,
      ranking_error: result.error_message || null,
    });
  }

  const currentModels = catalogCandidates(result);
  const rankedIds = ranking?.status === "ranked" ? ranking.rankings[result.provider] || [] : null;
  const statements = [
    `UPDATE ai_model_catalog SET active = 0, updated_at = datetime('now') WHERE provider = ${quote(result.provider)};`,
  ];

  if (rankedIds) {
    statements.push(
      `UPDATE ai_model_catalog SET priority_rank = NULL, ranking_status = 'standby'
       WHERE provider = ${quote(result.provider)};`
    );
  }

  for (const model of currentModels) {
    const functionalFailure = model.functional_status === "failed";
    const rank = rankedIds && !functionalFailure ? rankedIds.indexOf(model.model_id) : -1;
    const rankValue = rank >= 0 && rank < 5 ? rank + 1 : "NULL";
    const rankingState = functionalFailure
      ? "excluded_functional_failure"
      : rankedIds
      ? model.is_free === 1
        ? rank >= 0 && rank < 5 ? "ranked" : "standby"
        : "excluded_not_free"
      : model.is_free === 1
        ? "ranking_skipped"
        : "excluded_not_free";
    statements.push(`INSERT INTO ai_model_catalog
      (provider, model_id, display_name, supports_text, is_free, context_length,
       input_price, output_price, catalog_order, metadata_json, active, discovered_at, updated_at,
      priority_rank, ranking_status, functional_status, functional_error)
      VALUES (${quote(model.provider)}, ${quote(model.model_id)}, ${quote(model.display_name)},
       ${model.supports_text}, ${model.is_free === null ? "NULL" : model.is_free},
       ${model.context_length === null ? "NULL" : model.context_length},
       ${model.input_price === null ? "NULL" : model.input_price},
       ${model.output_price === null ? "NULL" : model.output_price},
       ${model.catalog_order}, ${quote(model.metadata_json)}, 1, datetime('now'), datetime('now'),
       ${rankValue}, ${quote(rankingState)}, ${quote(model.functional_status || "unknown")},
       ${model.functional_error ? quote(sanitizeErrorMessage(model.functional_error)) : "NULL"})
      ON CONFLICT(provider, model_id) DO UPDATE SET
       display_name = excluded.display_name, supports_text = excluded.supports_text,
       is_free = excluded.is_free, context_length = excluded.context_length,
       input_price = excluded.input_price, output_price = excluded.output_price,
       catalog_order = excluded.catalog_order, metadata_json = excluded.metadata_json,
       active = 1, discovered_at = datetime('now'), updated_at = datetime('now'),
       functional_status = CASE WHEN excluded.functional_status != 'unknown'
         THEN excluded.functional_status ELSE ai_model_catalog.functional_status END,
       functional_error = CASE WHEN excluded.functional_status != 'unknown'
         THEN excluded.functional_error ELSE ai_model_catalog.functional_error END,
       priority_rank = CASE WHEN excluded.functional_status = 'failed' THEN NULL
         WHEN ${rankedIds ? "1" : "0"} = 1
         THEN excluded.priority_rank
         WHEN excluded.is_free = 1 AND
           (ai_model_catalog.priority_rank IS NOT NULL OR ai_model_catalog.ranking_status = 'standby')
           THEN ai_model_catalog.priority_rank
         ELSE NULL END,
       ranking_status = CASE WHEN excluded.functional_status = 'failed'
         THEN 'excluded_functional_failure'
         WHEN ${rankedIds ? "1" : "0"} = 1
         THEN excluded.ranking_status
         WHEN excluded.is_free = 1 AND
           (ai_model_catalog.priority_rank IS NOT NULL OR ai_model_catalog.ranking_status = 'standby')
         THEN ai_model_catalog.ranking_status
         ELSE excluded.ranking_status END;`);
  }

  statements.push(statusStatement({
    ...result,
    models: currentModels,
    ranking_status: ranking?.status || "not_attempted",
    ranker_provider: ranking?.provider,
    ranker_model_id: ranking?.model_id,
    ranking_error: ranking?.error_message,
  }));
  return statements.join("\n");
}

export async function refreshModelCatalog({
  keys = readProviderKeys(),
  freeModelIds = readFreeModelPolicies(),
  fetchImpl = fetch,
  executeSqlFileFn = executeSqlFile,
  rankModelsFn = rankProviderModels,
  appendHistoryFn = appendCatalogHistory,
  loadFunctionalFailuresFn = executeSql,
} = {}) {
  const results = await discoverProviderCatalog({ keys, freeModelIds, fetchImpl });
  const failedRows = await loadFunctionalFailuresFn(
    "SELECT provider, model_id, functional_error FROM ai_model_catalog WHERE functional_status = 'failed'"
  );
  const knownFailures = new Map(
    failedRows.map((row) => [`${row.provider}\u0000${row.model_id}`, row.functional_error])
  );
  for (const result of results) {
    for (const model of result.models) {
      const key = `${result.provider}\u0000${model.model_id}`;
      if (knownFailures.has(key)) {
        model.functional_status = "failed";
        model.functional_error = knownFailures.get(key);
      }
    }
  }
  let probeResult = { status: "skipped_model_not_in_catalog" };
  const openRouter = results.find((result) => result.provider === "openrouter");
  const probeModel = openRouter?.status === "success"
    ? openRouter.models.find((model) => model.model_id === FUNCTIONALITY_PROBE_MODEL)
    : null;

  if (probeModel && keys.OPENROUTER_API_KEY) {
    try {
      await callOpenRouter(
        "Reply with exactly: OK",
        "Return only the requested short response.",
        keys.OPENROUTER_API_KEY,
        [FUNCTIONALITY_PROBE_MODEL]
      );
      await recordModelFunctionalityPass("openrouter", FUNCTIONALITY_PROBE_MODEL);
      probeModel.functional_status = "passed";
      probeModel.functional_error = null;
      probeResult = { status: "passed" };
    } catch (error) {
      const message = sanitizeErrorMessage(error.message, Object.values(keys));
      const status = Number(error.status) || null;
      const functionalFailure = status === 404 || error.code === "empty_or_malformed_output";
      if (functionalFailure) {
        probeModel.functional_status = "failed";
        probeModel.functional_error = message;
      }
      probeResult = {
        status: status === 429
          ? "provider_rate_limited"
          : functionalFailure
            ? "failed"
            : "provider_error",
        status_code: status,
        error_code: error.code || error.name || "functionality_probe_error",
        error_message: message,
      };
    }
  }

  const candidates = Object.fromEntries(
    results.map((result) => [
      result.provider,
      result.status === "success"
        ? catalogCandidates(result)
            .filter((model) => model.is_free === 1 && model.functional_status !== "failed")
        : [],
    ])
  );
  const rankerProvider = process.env.MODEL_RANKER_PROVIDER;
  const ranking = probeResult.status === "provider_rate_limited" && rankerProvider === "openrouter"
    ? {
        status: "skipped_provider_rate_limited",
        provider: "openrouter",
        model_id: FUNCTIONALITY_PROBE_MODEL,
        rankings: {},
        error_message: probeResult.error_message,
      }
    : await rankModelsFn({ candidates, keys });
  const sql = results.map((result) => buildProviderCatalogSql(result, ranking)).join("\n");

  let d1WriteStatus = "success";
  let d1WriteError = null;
  try {
    await executeSqlFileFn(sql, "temp_model_catalog.sql");
  } catch (error) {
    d1WriteStatus = "failed";
    d1WriteError = sanitizeErrorMessage(error.message, Object.values(keys));
  }

  const snapshot = {
    timestamp: new Date().toISOString(),
    ranking: {
      status: ranking.status,
      provider: ranking.provider,
      model_id: ranking.model_id,
      error_message: ranking.error_message,
    },
    functionality_probe: {
      model_id: FUNCTIONALITY_PROBE_MODEL,
      ...probeResult,
    },
    d1_write: { status: d1WriteStatus, error_message: d1WriteError },
    providers: results.map((result) => {
      const rankedIds = ranking.status === "ranked" ? ranking.rankings[result.provider] || [] : [];
      const providerRankingStatus = result.status === "success"
        ? ranking.status
        : "not_attempted_discovery_failed";
      const models = (result.status === "success" ? catalogCandidates(result) : []).map((model) => {
        const index = rankedIds.indexOf(model.model_id);
        return {
          model_id: model.model_id,
          functional_status: model.functional_status || "unknown",
          functional_error: model.functional_error || null,
          free_eligibility: {
            is_free: model.is_free === 1,
            evidence: model.is_free === 1
              ? JSON.parse(model.metadata_json).freeTierPolicy
              : "unverified_or_not_free",
          },
          priority: index >= 0 ? index + 1 : null,
          disposition: model.is_free !== 1
            ? "excluded_not_free"
            : model.functional_status === "failed"
              ? "excluded_functional_failure"
            : index >= 0
              ? "ranked"
              : ranking.status === "ranked"
                ? "standby"
                : "ranking_skipped",
        };
      });
      return {
        provider: result.provider,
        discovery_status: result.status,
        ranking_status: providerRankingStatus,
        ranking_error: result.status === "success" ? ranking.error_message : result.error_message || null,
        candidates: models,
        error_code: result.error_code || null,
        error_message: result.error_message || null,
      };
    }),
  };
  await appendHistoryFn(snapshot);

  for (const result of results) {
    console.log(
      `${result.provider}: ${result.status}; ` +
      `${result.status === "success" ? Math.min(result.models.length, 7) : "previous catalog preserved"} candidates; ` +
      `${result.status === "success" ? candidates[result.provider].length : "existing"} free-approved; ` +
      `probe=${probeResult.status}; ranking=${ranking.status}` +
      (result.error_code ? `; ${result.error_code}: ${result.error_message}` : "")
    );
  }
  if (d1WriteStatus === "failed") throw new Error(`D1 catalog write failed: ${d1WriteError}`);
  if (!results.some((result) => result.status === "success")) {
    throw new Error("No provider catalog refreshed successfully; previous catalogs remain active.");
  }
  return results;
}

async function main() {
  if (typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  await refreshModelCatalog();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`Model catalog refresh failed: ${error.message}`);
    process.exitCode = 1;
  });
}
