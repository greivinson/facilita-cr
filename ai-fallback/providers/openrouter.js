import { callCatalogModels } from "../provider-call.js";
import { recordModelFunctionalityFailure } from "../model-functionality.js";

export async function callOpenRouter(prompt, systemInstruction = "", apiKey, models) {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY no configurada");

  const messages = [];
  if (systemInstruction) messages.push({ role: "system", content: systemInstruction });
  messages.push({ role: "user", content: prompt });

  return callCatalogModels({
    provider: "openrouter",
    models,
    apiKey,
    onModelFailure: ({ provider, model, ...details }) =>
      recordModelFunctionalityFailure(provider, model, details),
    request: (model) =>
      fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://facilita.cr",
          "X-Title": "FacilitaCR Sale Hunter",
        },
        body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 1024 }),
      }),
    extractText: (data) => data.choices?.[0]?.message?.content,
  });
}
