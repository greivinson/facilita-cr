function sanitizeMessage(message, apiKey) {
  return String(message || "Error sin detalle")
    .replace(/[\r\n\t]+/g, " ")
    .replace(apiKey, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|gsk_[0-9A-Za-z_-]{16,}|sk-or-[0-9A-Za-z_-]{16,})\b/g, "[REDACTED]")
    .slice(0, 300);
}

async function getErrorDetails(response, apiKey) {
  let body = {};
  try {
    body = await response.json();
  } catch {}
  const error = body.error || body;
  return {
    code: error.code || error.type || null,
    message: sanitizeMessage(error.message || response.statusText, apiKey),
  };
}

export class ProviderCallError extends Error {
  constructor({ provider, model, status, code, message, fallbackAction }) {
    super(`${provider} ${model} failed${status ? ` (${status})` : ""}: ${message}`);
    this.name = "ProviderCallError";
    this.provider = provider;
    this.model = model;
    this.status = status;
    this.code = code;
    this.fallbackAction = fallbackAction;
    this.fallbackable = fallbackAction !== "stop";
  }
}

export async function callCatalogModels({
  provider,
  models,
  apiKey,
  request,
  extractText,
  onModelFailure = async () => {},
  logger = console,
}) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new ProviderCallError({
      provider,
      model: "(catalog)",
      message: "no active text models in D1 catalog",
      fallbackAction: "next-provider",
    });
  }

  let lastUnavailable;
  for (const model of models) {
    let response;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await request(model);
      } catch (error) {
        if (attempt === 0) continue;
        const message = sanitizeMessage(error.message, apiKey);
        logger.warn("Provider request failed", {
          provider,
          model,
          error_code: error.code || error.name || "network_error",
          message,
          fallback_action: "next-provider",
        });
        throw new ProviderCallError({
          provider,
          model,
          code: error.code || error.name || "network_error",
          message,
          fallbackAction: "next-provider",
        });
      }

      if (response.ok) {
        try {
          const text = extractText(await response.json());
          if (typeof text === "string" && text.trim()) return { text, provider, model };
          throw new Error("Successful response did not contain non-empty text output.");
        } catch (error) {
          const message = sanitizeMessage(error.message, apiKey);
          await onModelFailure({
            provider,
            model,
            status: response.status,
            code: "empty_or_malformed_output",
            message,
          });
          logger.warn("Provider model returned unusable output", {
            provider,
            model,
            status: response.status,
            error_code: "empty_or_malformed_output",
            message,
            fallback_action: "next-model",
          });
          lastUnavailable = {
            status: response.status,
            code: "empty_or_malformed_output",
            message,
          };
          break;
        }
      }

      const { code, message } = await getErrorDetails(response, apiKey);
      const status = response.status;
      if (status === 404) {
        logger.warn("Provider model unavailable", {
          provider, model, status, error_code: code, message, fallback_action: "next-model",
        });
        await onModelFailure({ provider, model, status, code, message });
        lastUnavailable = { status, code, message };
        break;
      }
      if (status === 429 || status === 401 || status === 403) {
        const fallbackAction = status === 429 ? "next-provider_rate_limited" : "next-provider_auth";
        logger.warn("Provider unavailable", {
          provider, model, status, error_code: code, message, fallback_action: fallbackAction,
        });
        throw new ProviderCallError({ provider, model, status, code, message, fallbackAction });
      }
      if ((status === 408 || status >= 500) && attempt === 0) continue;

      const transient = status === 408 || status >= 500;
      const fallbackAction = transient ? "next-provider" : "stop";
      logger.warn("Provider request rejected", {
        provider, model, status, error_code: code, message, fallback_action: fallbackAction,
      });
      throw new ProviderCallError({ provider, model, status, code, message, fallbackAction });
    }
  }

  throw new ProviderCallError({
    provider,
    model: "(catalog)",
    status: lastUnavailable?.status,
    code: lastUnavailable?.code,
    message: lastUnavailable?.message || "all catalog models returned 404 or were unavailable",
    fallbackAction: "next-provider",
  });
}
