import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { downloadImages } from '../sale-hunter/image-downloader.js';

function safeFileSegment(value) {
  const sanitized = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return sanitized || 'producto';
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeJsonAtomically(filePath, data) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
}

export async function processImageManifest(
  manifestPath,
  { format = 'jpg', outputDirectory } = {}
) {
  if (!['jpg', 'png'].includes(format)) {
    throw new Error('El formato debe ser jpg o png.');
  }

  const resolvedManifestPath = path.resolve(manifestPath);
  const manifest = JSON.parse(await readFile(resolvedManifestPath, 'utf8'));
  if (
    manifest?.manifestVersion !== 1 ||
    typeof manifest.scanRunId !== 'string' ||
    !Array.isArray(manifest.promos)
  ) {
    throw new Error('El manifiesto no tiene un formato compatible (version 1).');
  }

  const destinationDirectory = path.resolve(
    outputDirectory || path.dirname(resolvedManifestPath)
  );
  await mkdir(destinationDirectory, { recursive: true });

  const records = [];
  const pending = [];
  for (const [index, promo] of manifest.promos.entries()) {
    if (!promo?.imageUrl || typeof promo.imageUrl !== 'string') {
      records.push({
        productId: promo?.id ?? null,
        status: 'sin_imagen',
        imageUrl: promo?.imageUrl ?? null,
      });
      continue;
    }

    const urlHash = createHash('sha256').update(promo.imageUrl).digest('hex').slice(0, 10);
    const productId = safeFileSegment(promo.id || promo.title || `producto-${index + 1}`);
    const fileName = `${productId}-${urlHash}`;
    const filePath = path.join(destinationDirectory, `${fileName}.${format}`);
    if (await fileExists(filePath)) {
      records.push({
        productId: promo.id ?? null,
        status: 'existente',
        imageUrl: promo.imageUrl,
        filePath,
      });
      continue;
    }

    pending.push({ promo, fileName, recordIndex: records.length });
    records.push(null);
  }

  const downloaded = await downloadImages(
    pending.map(({ promo, fileName }) => ({ url: promo.imageUrl, fileName })),
    destinationDirectory,
    { format, concurrency: 2, timeoutMs: 10_000 }
  );

  for (let index = 0; index < pending.length; index++) {
    const { promo, fileName, recordIndex } = pending[index];
    const result = downloaded[index];
    const expectedPath = path.join(destinationDirectory, `${fileName}.${format}`);
    if (result.ok) {
      records[recordIndex] = {
        productId: promo.id ?? null,
        status: 'descargada',
        imageUrl: promo.imageUrl,
        filePath: result.filePath,
        bytes: result.bytes,
        contentType: result.contentType,
      };
    } else if (await fileExists(expectedPath)) {
      records[recordIndex] = {
        productId: promo.id ?? null,
        status: 'existente',
        imageUrl: promo.imageUrl,
        filePath: expectedPath,
      };
    } else {
      records[recordIndex] = {
        productId: promo.id ?? null,
        status: 'error',
        imageUrl: promo.imageUrl,
        error: result.error,
      };
    }
  }

  const report = {
    manifestVersion: 1,
    scanRunId: manifest.scanRunId,
    provider: manifest.provider,
    market: manifest.market,
    scanStatus: manifest.scanStatus || { status: 'desconocido' },
    generatedAt: new Date().toISOString(),
    format,
    results: records,
  };
  const reportName = `image-download-results-${safeFileSegment(manifest.scanRunId)}.json`;
  const reportPath = path.join(destinationDirectory, reportName);
  await writeJsonAtomically(reportPath, report);

  return {
    reportPath,
    results: records,
    failed: records.filter((record) => record.status === 'error').length,
    incompleteScan: Boolean(
      manifest.scanStatus && manifest.scanStatus.status !== 'completada'
    ),
  };
}

async function main(args) {
  const [manifestPath, format = 'jpg', outputDirectory] = args;
  if (!manifestPath || args.length > 3) {
    throw new Error(
      'Uso: npm run download -- <manifiesto.json> [jpg|png] [carpeta-destino]'
    );
  }

  const result = await processImageManifest(manifestPath, { format, outputDirectory });
  console.log(`Resultado de descargas guardado en: ${result.reportPath}`);
  console.log(
    `Descargadas: ${result.results.filter((item) => item.status === 'descargada').length} | ` +
    `existentes: ${result.results.filter((item) => item.status === 'existente').length} | ` +
    `sin imagen: ${result.results.filter((item) => item.status === 'sin_imagen').length} | ` +
    `fallidas: ${result.failed} | corrida incompleta: ${result.incompleteScan ? 'si' : 'no'}`
  );
  if (result.failed > 0 || result.incompleteScan) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`No se pudo procesar el manifiesto: ${error.message}`);
    process.exitCode = 1;
  });
}
