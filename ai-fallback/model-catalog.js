import { executeSql } from "../database/index.js";
import { MODEL_CATALOG_PROVIDERS } from "../database/model-catalog.js";

const CACHE_TTL_MS = 60 * 60 * 1000;

export function createModelCatalogCache({ load, now = Date.now, ttlMs = CACHE_TTL_MS }) {
  let cachedModels;
  let expiresAt = 0;

  const getModels = async function getModels() {
    if (cachedModels && now() < expiresAt) return cachedModels;

    const models = await load();
    if (!Array.isArray(models) || !models.length) {
      throw new Error("El catálogo D1 no tiene modelos de texto activos; actualízalo antes de usar ai-fallback.");
    }

    cachedModels = models;
    expiresAt = now() + ttlMs;
    return cachedModels;
  };
  getModels.invalidate = () => {
    cachedModels = undefined;
    expiresAt = 0;
  };
  return getModels;
}

const loadCatalog = async () => {
  const rows = await executeSql(
    `SELECT provider, model_id, supports_text, active, is_free, priority_rank,
            ranking_status, functional_status, catalog_order
     FROM ai_model_catalog
     WHERE active = 1 AND supports_text = 1 AND is_free = 1
       AND functional_status != 'failed'
       AND (priority_rank BETWEEN 1 AND 5 OR ranking_status = 'standby')
     ORDER BY CASE provider WHEN 'google' THEN 1 WHEN 'groq' THEN 2 ELSE 3 END,
              CASE WHEN priority_rank BETWEEN 1 AND 5 THEN 0 ELSE 1 END,
              priority_rank, catalog_order`
  );
  return rows.filter((row) => MODEL_CATALOG_PROVIDERS.includes(row.provider));
};

export const getModelCatalog = createModelCatalogCache({ load: loadCatalog });
export const invalidateModelCatalogCache = () => getModelCatalog.invalidate();
