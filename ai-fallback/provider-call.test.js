import test from "node:test";
import assert from "node:assert/strict";
import { callCatalogModels, ProviderCallError } from "./provider-call.js";

const reply = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: "test response",
  json: async () => body,
});

const quietLogger = { warn() {} };

test("skips 404 models and uses the next catalog entry", async () => {
  const tried = [];
  const result = await callCatalogModels({
    provider: "groq",
    models: ["old-model", "active-model"],
    apiKey: "test-key",
    logger: quietLogger,
    request: async (model) => {
      tried.push(model);
      return model === "old-model"
        ? reply(404, { error: { message: "not found" } })
        : reply(200, { choices: [{ message: { content: "ok" } }] });
    },
    extractText: (body) => body.choices?.[0]?.message?.content,
  });
  assert.deepEqual(tried, ["old-model", "active-model"]);
  assert.equal(result.text, "ok");
});

test("skips the rest of a provider after rate limiting", async () => {
  let calls = 0;
  await assert.rejects(
    callCatalogModels({
      provider: "google",
      models: ["first", "second"],
      apiKey: "test-key",
      logger: quietLogger,
      request: async () => {
        calls += 1;
        return reply(429, { error: { status: "RESOURCE_EXHAUSTED", message: "slow down" } });
      },
      extractText: () => "",
    }),
    (error) => error instanceof ProviderCallError && error.status === 429
  );
  assert.equal(calls, 1);
});

test("treats auth and malformed requests distinctly from model fallback", async () => {
  for (const [status, fallbackAction] of [[401, "next-provider_auth"], [400, "stop"]]) {
    await assert.rejects(
      callCatalogModels({
        provider: "google",
        models: ["only-model"],
        apiKey: "test-key",
        logger: quietLogger,
        request: async () => reply(status, { error: { code: status, message: "rejected" } }),
        extractText: () => "",
      }),
      (error) => error.fallbackAction === fallbackAction
    );
  }
});

test("retries a transient server response once", async () => {
  let calls = 0;
  const result = await callCatalogModels({
    provider: "google",
    models: ["model"],
    apiKey: "test-key",
    logger: quietLogger,
    request: async () => {
      calls += 1;
      return calls === 1
        ? reply(503, { error: { message: "temporary" } })
        : reply(200, { candidates: [{ content: { parts: [{ text: "ready" }] } }] });
    },
    extractText: (body) => body.candidates?.[0]?.content?.parts?.[0]?.text,
  });
  assert.equal(calls, 2);
  assert.equal(result.text, "ready");
});

test("redacts credentials from provider logs", async () => {
  const logs = [];
  await assert.rejects(
    callCatalogModels({
      provider: "groq",
      models: ["model"],
      apiKey: "test-key",
      logger: { warn: (...args) => logs.push(args) },
      request: async () => reply(401, { error: { message: "bad test-key" } }),
      extractText: () => "",
    })
  );
  assert.equal(JSON.stringify(logs).includes("test-key"), false);
});
