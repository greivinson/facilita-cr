import test from "node:test";
import assert from "node:assert/strict";
import { createModelCatalogCache } from "./model-catalog.js";
import { selectRankedFreeTextModels } from "../database/model-catalog.js";

test("caches the D1 model catalog for the configured interval", async () => {
  let now = 100;
  let reads = 0;
  const getModels = createModelCatalogCache({
    load: async () => {
      reads += 1;
      return [{
        provider: "google",
        model_id: "text-model",
        supports_text: 1,
        active: 1,
        is_free: 1,
        priority_rank: 1,
      }];
    },
    now: () => now,
    ttlMs: 1000,
  });

  await getModels();
  await getModels();
  assert.equal(reads, 1);
  now += 1001;
  await getModels();
  assert.equal(reads, 2);
});

test("rejects an empty catalog instead of using a local model list", async () => {
  const getModels = createModelCatalogCache({ load: async () => [] });
  await assert.rejects(getModels, /catálogo D1 no tiene modelos/);
});

test("selects only active text models from the requested provider", () => {
  assert.deepEqual(
    selectRankedFreeTextModels(
      [
        { provider: "google", model_id: "later", active: 1, is_free: 1, supports_text: 1, priority_rank: 2 },
        { provider: "google", model_id: "off", active: 0, is_free: 1, supports_text: 1, priority_rank: 1 },
        { provider: "groq", model_id: "other", active: 1, is_free: 1, supports_text: 1, priority_rank: 1 },
        { provider: "google", model_id: "unverified", active: 1, is_free: null, supports_text: 1, priority_rank: null },
        { provider: "google", model_id: "first", active: 1, is_free: 1, supports_text: 1, priority_rank: 1 },
      ],
      "google"
    ),
    ["first", "later"]
  );
});
