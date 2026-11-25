export const MODEL_CATALOG_PROVIDERS = Object.freeze(["google", "groq", "openrouter"]);

export function selectRankedFreeTextModels(rows, provider) {
  if (!Array.isArray(rows)) {
    throw new Error("La consulta del catálogo de modelos no devolvió filas válidas.");
  }

  return rows
    .filter(
      (row) =>
        row.provider === provider &&
        Number(row.active) === 1 &&
        Number(row.supports_text) === 1 &&
        Number(row.is_free) === 1 &&
        row.functional_status !== "failed" &&
        Number(row.priority_rank) >= 1 &&
        Number(row.priority_rank) <= 5
    )
    .sort((a, b) => Number(a.priority_rank) - Number(b.priority_rank))
    .map((row) => row.model_id);
}

export function selectInferenceFreeTextModels(rows, provider) {
  if (!Array.isArray(rows)) {
    throw new Error("La consulta del catálogo de modelos no devolvió filas válidas.");
  }

  return rows
    .filter(
      (row) =>
        row.provider === provider &&
        Number(row.active) === 1 &&
        Number(row.supports_text) === 1 &&
        Number(row.is_free) === 1 &&
        row.functional_status !== "failed" &&
        ((Number(row.priority_rank) >= 1 && Number(row.priority_rank) <= 5) ||
          row.ranking_status === "standby")
    )
    .sort((a, b) => {
      const aRank = Number(a.priority_rank);
      const bRank = Number(b.priority_rank);
      const aRanked = aRank >= 1 && aRank <= 5;
      const bRanked = bRank >= 1 && bRank <= 5;
      if (aRanked && bRanked) return aRank - bRank;
      if (aRanked !== bRanked) return aRanked ? -1 : 1;
      return Number(a.catalog_order) - Number(b.catalog_order);
    })
    .slice(0, 7)
    .map((row) => row.model_id);
}
