import { callCatalogModels } from "../provider-call.js";
import { recordModelFunctionalityFailure } from "../model-functionality.js";

export async function callGroq(prompt, systemInstruction = "", apiKey, models) {
  if (!apiKey) throw new Error("GROQ_API_KEY no configurada");

  const messages = [];
  if (systemInstruction) messages.push({ role: "system", content: systemInstruction });
  messages.push({ role: "user", content: prompt });

  return callCatalogModels({
    provider: "groq",
    models,
    apiKey,
    onModelFailure: ({ provider, model, ...details }) =>
      recordModelFunctionalityFailure(provider, model, details),
    request: (model) =>
      fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 1024 }),
      }),
    extractText: (data) => data.choices?.[0]?.message?.content,
  });
}
