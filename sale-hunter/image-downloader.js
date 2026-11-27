import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_DIMENSION = 1600;
const MAX_REDIRECTS = 5;

function isPublicIPv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => part < 0 || part > 255)) return false;

  const [a, b, c] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isPublicIPv6(address) {
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return false;
  const firstGroup = Number.parseInt(normalized.split(':')[0] || '0', 16);
  return firstGroup >= 0x2000 &&
    firstGroup <= 0x3fff &&
    !normalized.startsWith('2001:db8:');
}

async function validatePublicHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('La URL de imagen no es valida.');
  }

  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Solo se aceptan URLs HTTPS sin credenciales.');
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('La URL debe apuntar a un host publico.');
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    if (!isPublicIPv4(hostname)) throw new Error('La URL debe apuntar a una IP publica.');
  } else if (ipVersion === 6) {
    if (!isPublicIPv6(hostname)) throw new Error('La URL debe apuntar a una IP publica.');
  } else {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (
      addresses.length === 0 ||
      addresses.some(({ address, family }) =>
        family === 4 ? !isPublicIPv4(address) : !isPublicIPv6(address)
      )
    ) {
      throw new Error('El host debe resolver unicamente a IPs publicas.');
    }
  }

  return url;
}

function imageFormat(buffer, contentType) {
  if (
    contentType === 'image/jpeg' &&
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { extension: '.jpg', contentType };
  }
  if (
    contentType === 'image/png' &&
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { extension: '.png', contentType };
  }
  if (
    contentType === 'image/gif' &&
    buffer.length >= 6 &&
    (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a')
  ) {
    return { extension: '.gif', contentType };
  }
  if (
    contentType === 'image/webp' &&
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { extension: '.webp', contentType };
  }
  if (
    contentType === 'image/avif' &&
    buffer.length >= 12 &&
    buffer.toString('ascii', 4, 8) === 'ftyp' &&
    /^(avif|avis)$/.test(buffer.toString('ascii', 8, 12))
  ) {
    return { extension: '.avif', contentType };
  }
  throw new Error('La respuesta no contiene una imagen rasterizada valida.');
}

async function readImageBody(response, maxBytes) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error(`La imagen excede el limite de ${maxBytes} bytes.`);
  }
  if (!response.body) throw new Error('La respuesta de imagen esta vacia.');

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`La imagen excede el limite de ${maxBytes} bytes.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

function safeFileBaseName(value) {
  const baseName = path.basename(String(value || 'image'), path.extname(String(value || 'image')));
  const safeName = baseName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
  return safeName || 'image';
}

function validateFormat(format) {
  const normalized = String(format).toLowerCase();
  if (normalized === 'jpg' || normalized === 'jpeg') return 'jpg';
  if (normalized === 'png') return 'png';
  throw new Error('El formato de salida debe ser jpg o png.');
}

function validatePositiveOption(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} debe ser un entero positivo.`);
  }
}

async function convertImage(imageBuffer, { format, quality, maxWidth, maxHeight }) {
  const image = sharp(imageBuffer, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({
      width: maxWidth,
      height: maxHeight,
      fit: 'inside',
      withoutEnlargement: true,
    });

  if (format === 'jpg') {
    return image
      .flatten({ background: '#ffffff' })
      .jpeg({ quality, mozjpeg: true, progressive: true })
      .toBuffer();
  }

  return image
    .png({ compressionLevel: 9, palette: true, quality, effort: 8 })
    .toBuffer();
}

/**
 * Descarga una imagen rasterizada y la convierte a JPG o PNG.
 * @returns {Promise<{filePath: string, url: string, contentType: string, sourceContentType: string, bytes: number}>}
 */
export async function downloadImage(
  imageUrl,
  destinationDirectory,
  {
    fileName = 'image',
    format = 'jpg',
    quality = 80,
    maxWidth = DEFAULT_MAX_DIMENSION,
    maxHeight = DEFAULT_MAX_DIMENSION,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
  } = {}
) {
  if (!destinationDirectory) throw new Error('Debes indicar la carpeta de destino.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs debe ser positivo.');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('maxBytes debe ser positivo.');
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new Error('quality debe ser un entero entre 1 y 100.');
  }
  validatePositiveOption(maxWidth, 'maxWidth');
  validatePositiveOption(maxHeight, 'maxHeight');
  const outputFormat = validateFormat(format);

  let currentUrl = await validatePublicHttpsUrl(imageUrl);
  let imageBuffer;
  let sourceFormat;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('La redireccion no incluye una URL de destino.');
        if (redirectCount === MAX_REDIRECTS) throw new Error('La imagen excede el limite de redirecciones.');
        currentUrl = await validatePublicHttpsUrl(new URL(location, currentUrl).href);
        continue;
      }

      if (!response.ok) throw new Error(`El servidor respondio HTTP ${response.status}.`);
      const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      imageBuffer = await readImageBody(response, maxBytes);
      sourceFormat = imageFormat(imageBuffer, contentType);
      break;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`La descarga excedio el timeout de ${timeoutMs} ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  if (!imageBuffer || !sourceFormat) throw new Error('No se pudo completar la descarga de la imagen.');

  const outputBuffer = await convertImage(imageBuffer, {
    format: outputFormat,
    quality,
    maxWidth,
    maxHeight,
  });
  const outputDirectory = path.resolve(destinationDirectory);
  const extension = outputFormat === 'jpg' ? '.jpg' : '.png';
  const outputFile = path.join(outputDirectory, `${safeFileBaseName(fileName)}${extension}`);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputFile, outputBuffer, { flag: 'wx' });

  return {
    filePath: outputFile,
    url: currentUrl.href,
    contentType: outputFormat === 'jpg' ? 'image/jpeg' : 'image/png',
    sourceContentType: sourceFormat.contentType,
    bytes: outputBuffer.length,
  };
}

/**
 * Descarga un array de URLs con concurrencia limitada.
 * Los fallos se devuelven en su posición como { ok: false, url, error }.
 */
export async function downloadImages(
  imageUrls,
  destinationDirectory,
  {
    fileNamePrefix = 'image',
    concurrency = 2,
    ...downloadOptions
  } = {}
) {
  if (!Array.isArray(imageUrls)) throw new Error('imageUrls debe ser un array.');
  if (!destinationDirectory) throw new Error('Debes indicar la carpeta de destino.');
  validatePositiveOption(concurrency, 'concurrency');
  if (imageUrls.length === 0) return [];

  const results = new Array(imageUrls.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, imageUrls.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < imageUrls.length) {
      const index = nextIndex++;
      const item = imageUrls[index];
      const url = typeof item === 'string' ? item : item?.url;
      const fileName = typeof item === 'object' && item?.fileName
        ? item.fileName
        : `${fileNamePrefix}-${String(index + 1).padStart(3, '0')}`;

      try {
        results[index] = {
          ok: true,
          ...(await downloadImage(url, destinationDirectory, {
            ...downloadOptions,
            fileName,
          })),
        };
      } catch (error) {
        results[index] = {
          ok: false,
          url: typeof url === 'string' ? url : '',
          error: error.message,
        };
      }
    }
  });

  await Promise.all(workers);
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , firstArgument, ...args] = process.argv;
  if (firstArgument === '--batch') {
    const [format, destinationDirectory, ...imageUrls] = args;
    if (!format || !destinationDirectory || imageUrls.length === 0) {
      console.error('Uso: node image-downloader.js --batch <jpg|png> <carpeta-destino> <url1> [url2 ...]');
      process.exitCode = 1;
    } else {
      downloadImages(imageUrls, destinationDirectory, { format })
        .then((results) => {
          for (const result of results) {
            console.log(result.ok
              ? `Guardada: ${result.filePath} (${result.bytes} bytes)`
              : `Error para ${result.url || '(URL invalida)'}: ${result.error}`);
          }
          if (results.some((result) => !result.ok)) process.exitCode = 1;
        })
        .catch((error) => {
          console.error(`No se pudo completar la descarga: ${error.message}`);
          process.exitCode = 1;
        });
    }
  } else if (!firstArgument) {
    console.error('Uso: node image-downloader.js <url-imagen> [carpeta-destino] [nombre] [jpg|png]');
    process.exitCode = 1;
  } else {
    const [destinationDirectory = path.resolve('downloads'), fileName, format = 'jpg'] = args;
    downloadImage(firstArgument, destinationDirectory, { fileName, format })
      .then(({ filePath, bytes, contentType }) => {
        console.log(`Imagen guardada: ${filePath} (${contentType}, ${bytes} bytes)`);
      })
      .catch((error) => {
        console.error(`No se pudo descargar la imagen: ${error.message}`);
        process.exitCode = 1;
      });
  }
}
