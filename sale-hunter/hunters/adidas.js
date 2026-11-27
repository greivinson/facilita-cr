/**
 * Adidas Deal Hunter
 * Consulta el endpoint Next.js PLP y la API de inventario de tallas.
 *
 * Reglas de buen comportamiento:
 *  - Pausas entre requests y timeout que cubre tambien la lectura del cuerpo.
 *  - Si Adidas responde 403/429 se DETIENE el escaneo (no se reintenta ni se evade).
 *  - Las imagenes no se descargan; se exportan sus URLs oficiales.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeFailureLog } from '../failure-logger.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.adidas.com/us/sale',
  'x-nextjs-data': '1',
};

const TIMEOUT_MS = 10_000;
const MAX_DIAGNOSTIC_BODY_BYTES = 4096;
const DIAGNOSTIC_HEADERS = [
  'content-type',
  'date',
  'server',
  'via',
  'retry-after',
  'cf-ray',
  'x-request-id',
  'x-cache',
];
const PAGE_SIZE = 48;
const DEFAULT_MAX_PAGES = 4;
const DEFAULT_SIZE_CHECK_LIMIT = 30;
const DEFAULT_EXPORT_ROOT =
  process.env.ADIDAS_EXPORT_DIR || 'C:\\Users\\angec\\OneDrive\\Documents\\Facilita-CR';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pause = (min = 300, max = 800) => sleep(min + Math.random() * (max - min));

function sanitizeUrl(value) {
  const url = new URL(value);
  for (const key of url.searchParams.keys()) {
    if (/(token|key|auth|session|cookie|secret|signature)/i.test(key)) {
      url.searchParams.set(key, '[REDACTED]');
    }
  }
  return url.toString();
}

async function getResponseDiagnostics(response, requestUrl) {
  const headers = {};
  for (const name of DIAGNOSTIC_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers[name] = value.slice(0, 256);
  }

  let body = '';
  let bytesRead = 0;
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (bytesRead < MAX_DIAGNOSTIC_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, MAX_DIAGNOSTIC_BODY_BYTES - bytesRead);
      body += decoder.decode(chunk, { stream: true });
      bytesRead += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
    if (bytesRead >= MAX_DIAGNOSTIC_BODY_BYTES) {
      try {
        await reader.cancel();
      } catch (err) {
        console.warn('⚠️ No se pudo cancelar la lectura del cuerpo diagnóstico:', err.message);
      }
    }
    body += decoder.decode();
  }

  return {
    status: response.status,
    statusText: response.statusText,
    url: sanitizeUrl(response.url || requestUrl),
    headers,
    body,
    bodyTruncated: bytesRead >= MAX_DIAGNOSTIC_BODY_BYTES,
  };
}

export class AdidasRequestError extends Error {
  constructor(message, { url, response, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AdidasRequestError';
    this.url = url;
    this.response = response;
  }
}

/** Error que indica que Adidas nos esta bloqueando: hay que parar. */
export class AdidasBlockedError extends AdidasRequestError {
  constructor(status, url, response) {
    super(`Adidas respondio HTTP ${status}`, { url, response });
    this.name = 'AdidasBlockedError';
    this.status = status;
  }
}

/** La señal permanece activa hasta terminar de leer el cuerpo de la respuesta. */
async function fetchWithTimeout(url, headers = HEADERS, readBody = async () => null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const diagnostic = await getResponseDiagnostics(res, url);
      if (res.status === 403 || res.status === 429) {
        throw new AdidasBlockedError(res.status, url, diagnostic);
      }
      return { response: res, body: null, diagnostic };
    }
    const body = await readBody(res);
    return { response: res, body, diagnostic: null };
  } catch (err) {
    if (err instanceof AdidasRequestError) throw err;
    throw new AdidasRequestError(`Fallo de solicitud a Adidas: ${err.message}`, {
      url,
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Obtiene el buildId dinamico de Next.js y falla claramente si no esta disponible.
 */
export async function getAdidasBuildId() {
  const url = 'https://www.adidas.com/us/sale';
  try {
    const { response, body: html, diagnostic } = await fetchWithTimeout(
      url,
      {
        'User-Agent': HEADERS['User-Agent'],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      (res) => res.text()
    );
    if (!response.ok) {
      throw new AdidasRequestError(`Adidas respondio HTTP ${response.status} al cargar la pagina de ofertas.`, {
        url,
        response: diagnostic,
      });
    }
    const match =
      html.match(/"buildId":"([^"]+)"/) ||
      html.match(/\/_next\/static\/([a-zA-Z0-9_-]+)\/_buildManifest\.js/);
    if (match?.[1]) return match[1];
    throw new Error('No se encontro el buildId en la pagina de ofertas.');
  } catch (err) {
    if (err instanceof AdidasRequestError) throw err;
    throw new AdidasRequestError(`No se pudo obtener el buildId de Adidas: ${err.message}`, {
      url,
      cause: err,
    });
  }
}

/**
 * Disponibilidad y tallas de un producto.
 * Devuelve { status, inStock, sizes } o lanza AdidasRequestError si falla la peticion.
 * Lanza AdidasBlockedError en 403/429.
 */
export async function getProductAvailability(productId) {
  const url = `https://www.adidas.com/api/products/${productId}/availability?sitePath=us`;
  try {
    const { response, body: data, diagnostic } = await fetchWithTimeout(
      url,
      HEADERS,
      (res) => res.json()
    );
    if (!response.ok) {
      throw new AdidasRequestError(`No se pudieron verificar tallas de ${productId}: HTTP ${response.status}`, {
        url,
        response: diagnostic,
      });
    }

    const variations = Array.isArray(data?.variation_list) ? data.variation_list : [];
    const sizes = variations
      .filter((v) => v.availability_status === 'IN_STOCK')
      .map((v) => ({ size: v.size, stock: v.availability, sku: v.sku }));

    return { status: data?.availability_status, inStock: sizes.length > 0, sizes };
  } catch (err) {
    if (err instanceof AdidasRequestError) throw err;
    throw new AdidasRequestError(`No se pudieron verificar tallas de ${productId}: ${err.message}`, {
      url,
      cause: err,
    });
  }
}

/** Extrae precios y descuento de un producto del PLP. */
function parsePricing(prod, includeMembersOnly) {
  const prices = Array.isArray(prod.priceData?.prices) ? prod.priceData.prices : [];
  const isMemberPrice = (price) => /member|exclusive/i.test(String(price?.type || ''));
  const memberPriceObj = prices.find((price) => isMemberPrice(price));
  const origPriceObj = prices.find((price) => price?.type === 'original');
  const publicPrices = prices.filter((price) =>
    !isMemberPrice(price) && Number.isFinite(Number(price?.value))
  );
  const publicSalePriceObj = publicPrices.find((price) => price.type === 'sale');
  const otherPublicPriceObj = publicPrices.find((price) => price !== origPriceObj);
  const selectedPriceObj = publicSalePriceObj || otherPublicPriceObj ||
    (includeMembersOnly ? memberPriceObj : undefined);
  const salePrice = Number(selectedPriceObj?.value);
  const origPrice = Number(origPriceObj?.value) || salePrice;
  let discount = Math.abs(Number(origPriceObj?.discountPercentage) || 0);
  if (!discount && origPrice && salePrice && origPrice > salePrice) {
    discount = Math.round(((origPrice - salePrice) / origPrice) * 100);
  }

  const badgeText = (prod.badges || []).map((b) => b.text || '').join(' ');
  const membersOnly = !publicSalePriceObj && !otherPublicPriceObj &&
    Boolean(memberPriceObj || /member/i.test(badgeText));

  return {
    salePrice: Number.isFinite(salePrice) ? salePrice : undefined,
    origPrice: Number.isFinite(origPrice) ? origPrice : undefined,
    discount,
    membersOnly,
  };
}

function absoluteAdidasUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (value.startsWith('//')) return `https:${value}`;
  if (/^https?:\/\//i.test(value)) return value;
  return `https://www.adidas.com${value.startsWith('/') ? '' : '/'}${value}`;
}

function localDateStamp(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Guarda un manifiesto de las mejores ofertas y sus URLs oficiales, sin copiar imagenes.
 */
export async function exportAdidasDailyPromos(
  deals,
  {
    rootDirectory = DEFAULT_EXPORT_ROOT,
    date = new Date(),
    limit = DEFAULT_SIZE_CHECK_LIMIT,
    scanRunId = randomUUID(),
    scanMeta = deals.meta || {},
  } = {}
) {
  const outputDirectory = path.join(rootDirectory, 'adidas', localDateStamp(date));
  const outputFile = path.join(outputDirectory, 'promos.json');
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_SIZE_CHECK_LIMIT;
  const promos = deals.slice(0, safeLimit).map((deal) => ({
    id: deal.id,
    title: deal.title,
    category: deal.category,
    productUrl: deal.url,
    imageUrl: deal.image || null,
    originalPriceUsd: deal.originalPriceUsd,
    salePriceUsd: deal.salePriceUsd,
    discountPercentage: deal.discountPercentage,
    membersOnly: deal.membersOnly,
    sizes: deal.sizes,
    sizeVariants: deal.sizeVariants || [],
    sizesChecked: deal.sizesChecked,
  }));
  const scanStatus = {
    status: scanMeta.blocked
      ? 'bloqueada'
      : scanMeta.error || scanMeta.failures?.length
        ? 'incompleta'
        : 'completada',
    blockedStatus: scanMeta.blockedStatus ?? null,
    pagesScanned: scanMeta.pagesScanned ?? 0,
    sizesChecked: scanMeta.sizesChecked ?? 0,
    error: scanMeta.error ?? null,
    failures: scanMeta.failures ?? [],
  };

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    outputFile,
    `${JSON.stringify({
      manifestVersion: 1,
      scanRunId,
      generatedAt: date.toISOString(),
      provider: 'Adidas',
      market: 'US',
      scanStatus,
      promos,
    }, null, 2)}\n`,
    'utf8'
  );
  return outputFile;
}

/**
 * Caza ofertas en Adidas US.
 * @param {Object} options
 * @param {number}  options.minDiscount - Descuento minimo en % (ej: 40)
 * @param {number}  options.maxPages    - Paginas a consultar (48 items c/u)
 * @param {string}  options.sort        - 'top-sellers' (default) | 'price-low-to-high' | ...
 * @param {boolean} options.checkSizes  - Verificar tallas en tiempo real
 * @param {number}  options.maxSizeChecks - Maximo de productos con consulta de tallas
 * @param {boolean} options.includeMembersOnly - Incluir precios solo-miembros (default false)
 * @returns {Promise<Array>} ofertas; el arreglo trae `.meta` con { blocked, blockedStatus, pagesScanned }
 */
export async function huntAdidasDeals(options = {}) {
  const {
    minDiscount = 40,
    maxPages = DEFAULT_MAX_PAGES,
    sort = 'top-sellers',
    checkSizes = true,
    maxSizeChecks = DEFAULT_SIZE_CHECK_LIMIT,
    includeMembersOnly = false,
  } = options;
  const pageLimit = Number.isFinite(maxPages) ? Math.max(0, Math.floor(maxPages)) : DEFAULT_MAX_PAGES;
  const sizeCheckLimit = Number.isFinite(maxSizeChecks)
    ? Math.max(0, Math.floor(maxSizeChecks))
    : DEFAULT_SIZE_CHECK_LIMIT;

  console.log(`🔍 [Adidas Hunter] Iniciando escaneo... (Minimo: -${minDiscount}%, Paginas: ${pageLimit})`);

  const meta = {
    blocked: false,
    blockedStatus: null,
    pagesScanned: 0,
    sizesChecked: 0,
    failures: [],
  };
  const candidates = [];
  const seen = new Set();

  let buildId;
  try {
    buildId = await getAdidasBuildId();
  } catch (err) {
    if (err instanceof AdidasBlockedError) {
      console.error(`⛔ [Adidas Hunter] Bloqueado al obtener buildId (HTTP ${err.status}). Se detiene.`);
      meta.blocked = true;
      meta.blockedStatus = err.status;
    } else {
      meta.error = err.message;
    }
    meta.response = err.response ?? null;
    meta.failureUrl = err.url ?? null;
    meta.cause = err.cause?.message ?? null;
    candidates.meta = meta;
    return candidates;
  }
  console.log(`🔑 [Adidas Hunter] Build ID activo: ${buildId}`);

  const plpUrl = (id, start) =>
    `https://www.adidas.com/plp-app/_next/data/${id}/us/sale.json?path=us&taxonomy=sale&start=${start}&sort=${encodeURIComponent(sort)}&grid=true`;

  let refetchedBuildId = false;

  for (let page = 0; page < pageLimit; page++) {
    const start = page * PAGE_SIZE;
    console.log(`📡 Pagina ${page + 1} (items ${start} a ${start + PAGE_SIZE})...`);

    try {
      let { response: res, body: data, diagnostic } = await fetchWithTimeout(
        plpUrl(buildId, start),
        HEADERS,
        (response) => response.json()
      );

      // buildId caducado: Next.js responde 404. Se refresca UNA vez por corrida.
      if (res.status === 404 && !refetchedBuildId) {
        refetchedBuildId = true;
        console.warn('♻️ 404 en PLP: refrescando buildId una vez...');
        await pause();
        buildId = await getAdidasBuildId();
        ({ response: res, body: data, diagnostic } = await fetchWithTimeout(
          plpUrl(buildId, start),
          HEADERS,
          (response) => response.json()
        ));
      }

      if (!res.ok) {
        console.warn(`⚠️ HTTP ${res.status} en pagina ${page + 1}; se detiene el escaneo.`);
        meta.error = `HTTP ${res.status} al consultar la pagina ${page + 1}.`;
        meta.response = diagnostic ?? null;
        meta.failureUrl = diagnostic?.url ?? null;
        break;
      }

      const products = data?.pageProps?.products;
      if (!Array.isArray(products)) {
        throw new Error('La respuesta del listado no contiene pageProps.products.');
      }
      meta.pagesScanned++;
      if (products.length === 0) break;

      for (const prod of products) {
        const productId = String(prod?.id || '');
        if (!productId || seen.has(productId)) continue;
        seen.add(productId);

        const { salePrice, origPrice, discount, membersOnly } = parsePricing(prod, includeMembersOnly);
        if (discount < minDiscount || prod.priceData?.isSoldOut) continue;
        if (membersOnly && !includeMembersOnly) continue;
        if (!Number.isFinite(salePrice)) {
          console.warn(`⚠️ Se omite ${productId}: el listado no incluye un precio publico valido.`);
          continue;
        }

        const productUrl = absoluteAdidasUrl(prod.url);
        if (!productUrl) {
          console.warn(`⚠️ Se omite ${productId}: el listado no incluye URL de producto.`);
          continue;
        }

        const dealItem = {
          id: productId,
          brand: 'Adidas',
          title: prod.title,
          subtitle: prod.subTitle || '',
          category: prod.category || '',
          url: productUrl,
          image: absoluteAdidasUrl(prod.image),
          originalPriceUsd: origPrice,
          salePriceUsd: salePrice,
          discountPercentage: discount,
          badge: prod.badges?.[0]?.text || '',
          membersOnly,
          sizes: [],
          sizesChecked: false,
        };

        candidates.push(dealItem);
      }

      if (page < pageLimit - 1) await pause();
    } catch (err) {
      if (err instanceof AdidasBlockedError) {
        console.error(`⛔ [Adidas Hunter] HTTP ${err.status} en pagina ${page + 1}. Se detiene sin reintentar.`);
        meta.blocked = true;
        meta.blockedStatus = err.status;
        meta.response = err.response ?? null;
        meta.failureUrl = err.url ?? null;
        break;
      }
      meta.error = err.message;
      meta.response = err.response ?? null;
      meta.failureUrl = err.url ?? null;
      meta.cause = err.cause?.message ?? null;
      console.error(
        `❌ Error escaneando pagina ${page + 1}:`,
        err.cause?.name === 'AbortError' ? 'timeout de 10 segundos' : err.message
      );
      break;
    }
  }

  candidates.sort((a, b) =>
    b.discountPercentage - a.discountPercentage || a.salePriceUsd - b.salePriceUsd
  );

  const unavailableIds = new Set();
  const sizeCheckCandidates = checkSizes && !meta.blocked
    ? candidates.slice(0, sizeCheckLimit)
    : [];
  for (const deal of sizeCheckCandidates) {
    if (meta.sizesChecked > 0) await pause();
    try {
      const availability = await getProductAvailability(deal.id);
      meta.sizesChecked++;
      if (!availability.inStock) {
        unavailableIds.add(deal.id);
        continue;
      }
      deal.sizes = availability.sizes.map((size) => size.size);
      deal.sizeVariants = availability.sizes.map(({ size, sku, stock }) => ({ size, sku, stock }));
      deal.availableSizesCount = availability.sizes.length;
      deal.sizesChecked = true;
    } catch (err) {
      if (err instanceof AdidasBlockedError) {
        meta.blocked = true;
        meta.blockedStatus = err.status;
        meta.response = err.response ?? null;
        meta.failureUrl = err.url ?? null;
        meta.failures.push({
          stage: 'availability',
          productId: deal.id,
          message: err.message,
          response: err.response ?? null,
        });
        console.error(`⛔ [Adidas Hunter] Tallas bloqueadas (HTTP ${err.status}). Se detiene la corrida.`);
        break;
      }
      if (err instanceof AdidasRequestError) {
        meta.failures.push({
          stage: 'availability',
          productId: deal.id,
          message: err.message,
          url: err.url ?? null,
          response: err.response ?? null,
          cause: err.cause?.message ?? null,
        });
        console.warn(`⚠️ Tallas de ${deal.id} sin verificar: ${err.message}`);
        continue;
      }
      throw err;
    }
  }

  const deals = candidates.filter((deal) => !unavailableIds.has(deal.id));
  deals.sort((a, b) => b.discountPercentage - a.discountPercentage);
  deals.meta = meta;
  return deals;
}

// Ejecucion directa de prueba
if (process.argv[1]?.endsWith('adidas.js')) {
  const startedAt = new Date().toISOString();
  const scanRunId = randomUUID();
  console.log('⚡ Ejecutando prueba directa de Adidas Deal Hunter...\n');
  huntAdidasDeals({ minDiscount: 50, maxPages: 1, checkSizes: true })
    .then(async (deals) => {
      const meta = deals.meta || {};
      const manifestPath = await exportAdidasDailyPromos(deals, { scanRunId, scanMeta: meta });
      const failures = [];
      if (meta.blocked) {
        console.error(`⛔ Corrida incompleta: Adidas respondió HTTP ${meta.blockedStatus}; no se reintentó.`);
        failures.push({
          hunter: 'Adidas',
          stage: 'scan',
          message: `Adidas respondio HTTP ${meta.blockedStatus}.`,
          url: meta.failureUrl,
          response: meta.response,
        });
      } else if (meta.error) {
        console.error(`❌ Corrida incompleta: ${meta.error}`);
        failures.push({
          hunter: 'Adidas',
          stage: 'scan',
          message: meta.error,
          url: meta.failureUrl,
          response: meta.response,
          cause: meta.cause,
        });
      }
      for (const failure of meta.failures || []) {
        failures.push({
          hunter: 'Adidas',
          stage: failure.stage,
          message: failure.message,
          url: failure.url ?? failure.response?.url,
          response: failure.response,
          cause: failure.cause,
        });
      }
      if (failures.length > 0) {
        process.exitCode = 1;
        const logPath = await writeFailureLog({ scanRunId, startedAt, failures });
        console.error(`📝 Log de error guardado en: ${logPath}`);
      } else {
        console.log(`\n🎉 ${deals.length} ofertas con 50%+ OFF\n`);
      }
      console.log(`🖼️ URLs de las mejores ofertas guardadas en: ${manifestPath}`);
      console.table(
        deals.slice(0, 10).map((d) => ({
          Producto: d.title.substring(0, 24),
          'Original $': `$${d.originalPriceUsd}`,
          'Sale $': `$${d.salePriceUsd}`,
          'Desc.': `-${d.discountPercentage}%`,
          Tallas: d.sizesChecked ? d.sizes.slice(0, 6).join(', ') + (d.sizes.length > 6 ? '...' : '') : '(sin verificar)',
        }))
      );
    })
    .catch(async (err) => {
      console.error('❌ Error ejecutando Adidas Deal Hunter:', err.message);
      process.exitCode = 1;
      try {
        const logPath = await writeFailureLog({
          scanRunId,
          startedAt,
          failures: [{
            hunter: 'Adidas',
            stage: 'scan',
            message: err.message,
            url: err.url,
            response: err.response,
            cause: err.cause?.message,
          }],
        });
        console.error(`📝 Log de error guardado en: ${logPath}`);
      } catch (logErr) {
        console.error('❌ No se pudo guardar el log de error:', logErr.message);
      }
    });
}
