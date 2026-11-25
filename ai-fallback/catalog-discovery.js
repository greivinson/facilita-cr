export const PROVIDERS = Object.freeze([
  {
    id: "google",
    keyName: "GEMINI_API_KEY",
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100",
  },
  {
    id: "groq",
    keyName: "GROQ_API_KEY",
    url: "https://api.groq.com/openai/v1/models",
  },
  {
    id: "openrouter",
    keyName: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai/api/v1/models",
  },
]);

const NON_TEXT_MODEL = /embedding|whisper|speech|audio|transcri|tts|moderation|guard|safety/i;

function isTextModelId(modelId) {
  return typeof modelId === "string" && modelId.length > 0 && !NON_TEXT_MODEL.test(modelId);
}

function numericPrice(value) {
  if (value === undefined || value === null || value === "") return null;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : null;
}

export function normalizeProviderModels(provider, payload, freeModelIds = []) {
  const rawModels = provider === "google" ? payload.models : payload.data;
  if (!Array.isArray(rawModels)) {
    throw new Error("Respuesta de catálogo inválida: falta la lista de modelos.");
  }

  const explicitlyFree = new Set(freeModelIds);
  const models = [];
  for (const model of rawModels) {
    if (!model || typeof model !== "object") continue;

    if (provider === "google") {
      const modelId = String(model.name || "").replace(/^models\//, "");
      if (!model.supportedGenerationMethods?.includes("generateContent") || !isTextModelId(modelId)) continue;
      models.push({
        provider,
        model_id: modelId,
        display_name: String(model.displayName || modelId),
        supports_text: 1,
        is_free: explicitlyFree.has(modelId) ? 1 : null,
        context_length: Number.isInteger(model.inputTokenLimit) ? model.inputTokenLimit : null,
        input_price: null,
        output_price: null,
        catalog_order: models.length,
        metadata_json: JSON.stringify({
          outputTokenLimit: Number.isInteger(model.outputTokenLimit) ? model.outputTokenLimit : null,
          supportedGenerationMethods: model.supportedGenerationMethods,
          freeTierPolicy: explicitlyFree.has(modelId) ? "operator_allowlist" : "unverified",
        }),
      });
      continue;
    }

    const modelId = model.id;
    if (!isTextModelId(modelId)) continue;

    if (provider === "groq") {
      models.push({
        provider,
        model_id: modelId,
        display_name: String(model.name || modelId),
        supports_text: 1,
        is_free: explicitlyFree.has(modelId) ? 1 : null,
        context_length: Number.isInteger(model.context_window) ? model.context_window : null,
        input_price: null,
        output_price: null,
        catalog_order: models.length,
        metadata_json: JSON.stringify({
          ownedBy: model.owned_by || null,
          active: model.active ?? null,
          freeTierPolicy: explicitlyFree.has(modelId) ? "operator_allowlist" : "unverified",
        }),
      });
      continue;
    }

    const modality = model.architecture?.modality;
    if (
      typeof modality !== "string" ||
      !modality.split("->")[0].includes("text") ||
      !modality.split("->")[1]?.includes("text")
    ) {
      continue;
    }

    const inputPrice = numericPrice(model.pricing?.prompt);
    const outputPrice = numericPrice(model.pricing?.completion);
    if (inputPrice !== 0 || outputPrice !== 0) continue;

    models.push({
      provider,
      model_id: modelId,
      display_name: String(model.name || modelId),
      supports_text: 1,
      is_free: 1,
      context_length: Number.isInteger(model.context_length) ? model.context_length : null,
      input_price: inputPrice,
      output_price: outputPrice,
      catalog_order: models.length,
      metadata_json: JSON.stringify({ modality, freeTierPolicy: "zero-priced-catalog" }),
    });
  }

  return models;
}

function sanitizeErrorMessage(message, secrets = []) {
  let safe = String(message || "Error sin detalle").replace(/[\r\n\t]+/g, " ").slice(0, 300);
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join("[REDACTED]");
  }
  return safe
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|gsk_[0-9A-Za-z_-]{16,}|sk-or-[0-9A-Za-z_-]{16,})\b/g, "[REDACTED]");
}

async function fetchProviderModels(provider, apiKey, fetchImpl, freeModelIds) {
  const headers = {};
  if (provider.id === "google") headers["x-goog-api-key"] = apiKey;
  else headers.Authorization = `Bearer ${apiKey}`;
  if (provider.id === "openrouter") {
    headers["HTTP-Referer"] = "https://facilita.cr";
    headers["X-Title"] = "FacilitaCR";
  }

  const response = await fetchImpl(provider.url, { headers });
  if (!response.ok) {
    let detail = {};
    try {
      detail = await response.json();
    } catch {}
    const error = detail.error || detail;
    return {
      ok: false,
      status: response.status,
      code: error.code || error.type || null,
      message: sanitizeErrorMessage(error.message || response.statusText, [apiKey]),
    };
  }

  return {
    ok: true,
    models: normalizeProviderModels(provider.id, await response.json(), freeModelIds),
  };
}

export async function discoverProviderCatalog({
  keys,
  freeModelIds = {},
  fetchImpl = fetch,
}) {
  const results = [];
  for (const provider of PROVIDERS) {
    const apiKey = keys[provider.keyName];
    if (!apiKey) {
      results.push({
        provider: provider.id,
        status: "skipped_missing_credentials",
        error_code: "credential_missing",
        error_message: `${provider.keyName} is not configured.`,
        models: [],
      });
      continue;
    }

    try {
      const result = await fetchProviderModels(
        provider,
        apiKey,
        fetchImpl,
        freeModelIds[provider.id] || []
      );
      results.push(
        result.ok
          ? { provider: provider.id, status: "success", models: result.models }
          : {
              provider: provider.id,
              status: "failed",
              http_status: result.status,
              error_code: result.code,
              error_message: result.message,
              models: [],
            }
      );
    } catch (error) {
      results.push({
        provider: provider.id,
        status: "failed",
        error_code: error.code || error.name || "discovery_error",
        error_message: sanitizeErrorMessage(error.message, [apiKey]),
        models: [],
      });
    }
  }
  return results;
}
