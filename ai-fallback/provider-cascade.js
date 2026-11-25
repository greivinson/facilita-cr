function redact(message, keys) {
  let safe = String(message || "Provider failed");
  for (const key of Object.values(keys)) {
    if (key) safe = safe.split(key).join("[REDACTED]");
  }
  return safe
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|gsk_[0-9A-Za-z_-]{16,}|sk-or-[0-9A-Za-z_-]{16,})\b/g, "[REDACTED]");
}

export async function runProviderCascade({ prompt, systemInstruction, keys, catalog, providers, logger = console }) {
  const errors = [];

  for (const provider of providers) {
    const apiKey = keys[provider.keyName];
    if (!apiKey) continue;

    const models = catalog
      .filter(
        (entry) =>
          entry.provider === provider.id &&
          Number(entry.active) === 1 &&
          Number(entry.supports_text) === 1 &&
          Number(entry.is_free) === 1 &&
          entry.functional_status !== "failed" &&
          ((Number(entry.priority_rank) >= 1 && Number(entry.priority_rank) <= 5) ||
            entry.ranking_status === "standby")
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
      .map((entry) => entry.model_id);
    if (!models.length) {
      errors.push({ provider: provider.id, error: "No active text models in D1 catalog." });
      continue;
    }

    try {
      return await provider.call(prompt, systemInstruction, apiKey, models);
    } catch (error) {
      const message = redact(error.message, keys);
      logger.warn("AI provider fallback", {
        provider: error.provider || provider.id,
        model: error.model || null,
        status: error.status || null,
        error_code: error.code || error.name || "provider_error",
        message,
        fallback_action: error.fallbackAction || "next-provider",
      });
      if (error.fallbackable === false) {
        const safeError = new Error(message);
        safeError.provider = error.provider || provider.id;
        safeError.model = error.model || null;
        safeError.status = error.status || null;
        safeError.code = error.code || error.name || "provider_error";
        safeError.fallbackAction = error.fallbackAction || "stop";
        safeError.fallbackable = false;
        throw safeError;
      }
      errors.push({ provider: provider.id, error: message });
    }
  }

  throw new Error(`All configured AI providers failed: ${JSON.stringify(errors)}`);
}
