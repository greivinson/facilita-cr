import { executeSql } from "../shared/d1.js";
import { invalidateModelCatalogCache } from "./model-catalog.js";

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sanitize(message) {
  return String(message || "Model functionality failure")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|gsk_[0-9A-Za-z_-]{16,}|sk-or-[0-9A-Za-z_-]{16,})\b/g, "[REDACTED]")
    .slice(0, 300);
}

export async function recordModelFunctionalityFailure(provider, model, details, executeSqlFn = executeSql) {
  await executeSqlFn(
    `UPDATE catalogo_modelos_ia
     SET functional_status = 'failed',
         functional_error = ${quote(sanitize(details.message))},
         priority_rank = NULL,
         ranking_status = 'excluded_functional_failure',
         updated_at = datetime('now')
     WHERE provider = ${quote(provider)} AND model_id = ${quote(model)}`
  );
  invalidateModelCatalogCache();
}

export async function recordModelFunctionalityPass(provider, model, executeSqlFn = executeSql) {
  await executeSqlFn(
    `UPDATE catalogo_modelos_ia
     SET functional_status = 'passed', functional_error = NULL, updated_at = datetime('now')
     WHERE provider = ${quote(provider)} AND model_id = ${quote(model)}`
  );
  invalidateModelCatalogCache();
}
