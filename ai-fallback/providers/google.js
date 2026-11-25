import { callCatalogModels } from "../provider-call.js";
import { recordModelFunctionalityFailure } from "../model-functionality.js";

export async function callGoogleAI(prompt, systemInstruction = "", apiKey, models) {
  if (!apiKey) throw new Error("GEMINI_API_KEY no configurada");

  const promptPayload = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: systemInstruction
              ? `[INSTRUCCIONES]\n${systemInstruction}\n\n[TAREA]\n${prompt}`
              : prompt,
          },
        ],
      },
    ],
    generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
  };

  return callCatalogModels({
    provider: "google",
    models,
    apiKey,
    onModelFailure: ({ provider, model, ...details }) =>
      recordModelFunctionalityFailure(provider, model, details),
    request: (model) =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(promptPayload),
      }),
    extractText: (data) => data.candidates?.[0]?.content?.parts?.[0]?.text,
  });
}
