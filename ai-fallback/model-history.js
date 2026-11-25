import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HISTORY_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "history",
  "model-catalog-history.jsonl"
);
const MAX_HISTORY_RECORDS = 2000;

export async function appendCatalogHistory(snapshot) {
  await mkdir(dirname(HISTORY_FILE), { recursive: true });
  await appendFile(HISTORY_FILE, `${JSON.stringify(snapshot)}\n`, "utf8");

  const lines = (await readFile(HISTORY_FILE, "utf8")).split(/\r?\n/).filter(Boolean);
  if (lines.length > MAX_HISTORY_RECORDS) {
    await writeFile(
      HISTORY_FILE,
      `${lines.slice(-MAX_HISTORY_RECORDS).join("\n")}\n`,
      "utf8"
    );
  }
}
