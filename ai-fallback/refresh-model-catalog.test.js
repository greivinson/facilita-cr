import test from "node:test";
import assert from "node:assert/strict";
import { buildProviderCatalogSql, refreshModelCatalog } from "./refresh-model-catalog.js";

test("upserts successful catalogs and preserves prior rows after provider failure", async () => {
  const writes = [];
  const previousLog = console.log;
  console.log = () => {};
  try {
    const results = await refreshModelCatalog({
      keys: { GEMINI_API_KEY: "test-google-key", GROQ_API_KEY: "test-groq-key" },
      freeModelIds: { google: ["actual-model"] },
      fetchImpl: async (url) => {
        if (url.includes("generativelanguage")) {
          return {
            ok: true,
            json: async () => ({
              models: [{ name: "models/actual-model", supportedGenerationMethods: ["generateContent"] }],
            }),
          };
        }
        return {
          ok: false,
          status: 503,
          statusText: "Unavailable",
          json: async () => ({ error: { code: "busy", message: "try later" } }),
        };
      },
      executeSqlFileFn: async (sql) => writes.push(sql),
    });

    assert.equal(results[0].models.length, 1);
    assert.equal(results[1].status, "failed");
    assert.equal(results[2].status, "skipped_missing_credentials");
  } finally {
    console.log = previousLog;
  }

  assert.equal(writes.length, 1);
  assert.match(writes[0], /UPDATE catalogo_modelos_ia SET active = 0/);
  assert.match(writes[0], /'actual-model'/);
  assert.match(writes[0], /'actual-model',\s*1,\s*1,/);
  assert.doesNotMatch(writes[0], /WHERE provider = 'groq'/);
  assert.match(writes[0], /last_success_at/);
  assert.doesNotMatch(writes.join("\n"), /test-google-key|test-groq-key/);
});

test("escapes catalog values in SQL and does not add fake models", () => {
  const sql = buildProviderCatalogSql({
    provider: "groq",
    status: "success",
    models: [],
  });
  assert.match(sql, /UPDATE catalogo_modelos_ia SET active = 0/);
  assert.doesNotMatch(sql, /INSERT INTO catalogo_modelos_ia\s*\(/);
});

test("fails explicitly when no provider catalog can be refreshed", async () => {
  const writes = [];
  const previousLog = console.log;
  console.log = () => {};
  try {
    await assert.rejects(
      refreshModelCatalog({
        keys: {},
        fetchImpl: async () => assert.fail("must not call providers without credentials"),
        executeSqlFileFn: async (sql) => writes.push(sql),
      }),
      /No provider catalog refreshed successfully/
    );
  } finally {
    console.log = previousLog;
  }
  assert.equal(writes.length, 1);
  assert.match(writes[0], /credential_missing/);
});
