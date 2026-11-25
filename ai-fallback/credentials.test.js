import test from "node:test";
import assert from "node:assert/strict";
import { askAI } from "./index.js";

test("reports missing provider credentials without attempting a provider", async () => {
  const names = ["GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY"];
  const previousValues = new Map(names.map((name) => [name, process.env[name]]));

  for (const name of names) delete process.env[name];

  try {
    await assert.rejects(
      askAI("test"),
      /No AI provider credentials configured\. Set GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY\./
    );
  } finally {
    for (const name of names) {
      const value = previousValues.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
