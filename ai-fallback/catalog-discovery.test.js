import test from "node:test";
import assert from "node:assert/strict";
import { discoverProviderCatalog, normalizeProviderModels } from "./catalog-discovery.js";

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? "OK" : "Unavailable",
  json: async () => body,
});

test("discovers text models and keeps only explicitly free OpenRouter entries", async () => {
  const calls = [];
  const results = await discoverProviderCatalog({
    keys: {
      GEMINI_API_KEY: "test-google-key",
      GROQ_API_KEY: "test-groq-key",
      OPENROUTER_API_KEY: "test-router-key",
    },
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("generativelanguage")) {
        return response({
          models: [
            { name: "models/text-one", supportedGenerationMethods: ["generateContent"] },
            { name: "models/embed-one", supportedGenerationMethods: ["embedContent"] },
          ],
        });
      }
      if (url.includes("groq.com")) {
        return response({
          data: [
            { id: "text-model", context_window: 8192 },
            { id: "whisper-audio" },
          ],
        });
      }
      return response({
        data: [
          {
            id: "free-model",
            name: "Free text model",
            architecture: { modality: "text->text" },
            pricing: { prompt: "0", completion: "0" },
          },
          {
            id: "paid-model",
            architecture: { modality: "text->text" },
            pricing: { prompt: "0.01", completion: "0.02" },
          },
          {
            id: "image-model",
            architecture: { modality: "image->text" },
            pricing: { prompt: "0", completion: "0" },
          },
        ],
      });
    },
  });

  assert.deepEqual(calls, [
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100",
    "https://api.groq.com/openai/v1/models",
    "https://openrouter.ai/api/v1/models",
  ]);
  assert.deepEqual(results.map((result) => result.models.map((model) => model.model_id)), [
    ["text-one"],
    ["text-model"],
    ["free-model"],
  ]);
  assert.equal(results[2].models[0].is_free, 1);
  assert.equal(results[0].models[0].is_free, null);
  assert.equal(results[1].models[0].is_free, null);
});

test("marks Google and Groq models free only when explicitly allowlisted", () => {
  const google = normalizeProviderModels(
    "google",
    { models: [{ name: "models/google-text", supportedGenerationMethods: ["generateContent"] }] },
    ["google-text"]
  );
  const groq = normalizeProviderModels(
    "groq",
    { data: [{ id: "groq-text" }] },
    ["groq-text"]
  );
  assert.equal(google[0].is_free, 1);
  assert.equal(groq[0].is_free, 1);
  assert.match(JSON.parse(groq[0].metadata_json).freeTierPolicy, /operator_allowlist/);
});

test("records provider errors without exposing credentials", async () => {
  const result = await discoverProviderCatalog({
    keys: { GEMINI_API_KEY: "test-google-key" },
    fetchImpl: async () =>
      response({ error: { code: 403, message: "denied test-google-key" } }, 403),
  });

  assert.equal(result[0].status, "failed");
  assert.equal(result[0].http_status, 403);
  assert.equal(result[0].error_message.includes("test-google-key"), false);
  assert.equal(result[1].status, "skipped_missing_credentials");
});

test("does not fabricate model entries when providers return none", async () => {
  const results = await discoverProviderCatalog({
    keys: { GEMINI_API_KEY: "test-google-key" },
    fetchImpl: async () => response({ models: [] }),
  });
  assert.equal(results[0].status, "success");
  assert.deepEqual(results[0].models, []);
});
