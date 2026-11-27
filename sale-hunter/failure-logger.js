import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'logs');

function sanitizeUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  for (const key of url.searchParams.keys()) {
    if (/(token|key|auth|session|cookie|secret|signature)/i.test(key)) {
      url.searchParams.set(key, '[REDACTED]');
    }
  }
  return url.toString();
}

export async function writeFailureLog({ scanRunId, startedAt, failures }) {
  if (failures.length === 0) return null;

  await mkdir(LOG_DIRECTORY, { recursive: true });
  const failedAt = new Date().toISOString();
  const filename = `sale-hunter-${failedAt.replace(/[:.]/g, '-')}-${scanRunId}.json`;
  const logPath = path.join(LOG_DIRECTORY, filename);
  const normalizedFailures = failures.map((failure) => ({
    hunter: failure.hunter || 'Unknown',
    stage: failure.stage || 'unknown',
    message: String(failure.message || 'Unknown error'),
    url: sanitizeUrl(failure.url ?? failure.response?.url),
    response: failure.response ?? null,
    cause: failure.cause ?? null,
  }));

  await writeFile(logPath, `${JSON.stringify({
    logVersion: 1,
    scanRunId,
    startedAt,
    failedAt,
    nodeVersion: process.version,
    failures: normalizedFailures,
  }, null, 2)}\n`, 'utf8');

  return logPath;
}
