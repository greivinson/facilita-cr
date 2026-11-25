import test from "node:test";
import assert from "node:assert/strict";
import { runProviderCascade } from "./provider-cascade.js";

const catalog = [
  { provider: "google", model_id: "google-model", supports_text: 1, active: 1, is_free: 1, priority_rank: 1 },
  { provider: "groq", model_id: "groq-model", supports_text: 1, active: 1, is_free: 1, priority_rank: 1 },
  { provider: "openrouter", model_id: "router-model", supports_text: 1, active: 1, is_free: 1, priority_rank: 1 },
];

test("falls through providers in priority order with models from D1", async () => {
  const tried = [];
  const providers = ["google", "groq", "openrouter"].map((id) => ({
    id,
    keyName: `${id}_KEY`,
    call: async (_prompt, _instruction, _key, models) => {
      tried.push({ id, models });
      if (id !== "openrouter") throw new Error("provider unavailable");
      return { provider: id, model: models[0], text: "ok" };
    },
  }));
  const result = await runProviderCascade({
    prompt: "request",
    systemInstruction: "",
    keys: { google_KEY: "test-google", groq_KEY: "test-groq", openrouter_KEY: "test-router" },
    catalog,
    providers,
    logger: { warn() {} },
  });

  assert.deepEqual(tried, [
    { id: "google", models: ["google-model"] },
    { id: "groq", models: ["groq-model"] },
    { id: "openrouter", models: ["router-model"] },
  ]);
  assert.equal(result.text, "ok");
});

test("stops provider fallback for malformed requests and redacts keys in logs", async () => {
  const logs = [];
  const providers = [
    {
      id: "google",
      keyName: "GEMINI_API_KEY",
      call: async () => {
        const error = new Error("invalid request test-google-secret");
        error.fallbackable = false;
        throw error;
      },
    },
    { id: "groq", keyName: "GROQ_API_KEY", call: async () => assert.fail("must not fall back") },
  ];

  await assert.rejects(
    runProviderCascade({
      prompt: "",
      systemInstruction: "",
      keys: { GEMINI_API_KEY: "test-google-secret", GROQ_API_KEY: "test-groq-secret" },
      catalog,
      providers,
      logger: { warn: (...entry) => logs.push(entry) },
    }),
    /invalid request \[REDACTED\]/
  );
  assert.equal(JSON.stringify(logs).includes("test-google-secret"), false);
});

test("never passes models without an explicit free-tier approval to providers", async () => {
  const tried = [];
  const providers = ["google", "groq"].map((id) => ({
    id,
    keyName: `${id}_KEY`,
    call: async (_prompt, _instruction, _key, models) => {
      tried.push({ id, models });
      return { provider: id, model: models[0], text: "ok" };
    },
  }));
  const result = await runProviderCascade({
    prompt: "request",
    systemInstruction: "",
    keys: { google_KEY: "test-google", groq_KEY: "test-groq" },
    catalog: [
      { provider: "google", model_id: "unverified-google", active: 1, supports_text: 1, is_free: null, priority_rank: null },
      { provider: "groq", model_id: "approved-groq", active: 1, supports_text: 1, is_free: 1, priority_rank: 1 },
    ],
    providers,
    logger: { warn() {} },
  });
  assert.deepEqual(tried, [{ id: "groq", models: ["approved-groq"] }]);
  assert.equal(result.provider, "groq");
});
