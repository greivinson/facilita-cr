/**
 * Adidas Deal Hunter
 * Consulta el endpoint Next.js PLP y la API de inventario de tallas.
 *
 * Reglas de buen comportamiento:
 *  - Pausas entre requests, timeout por request.
 *  - Si Adidas responde 403/429 se DETIENE el escaneo (no se reintenta ni se evade).
 *  - Las imagenes NO se descargan: solo se guarda la URL.
 */

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.adidas.com/us/sale',
  'x-nextjs-data': '1',
};

const FALLBACK_BUILD_ID = '6bS-8OUb6ysDfiA5qHelc'; // Observado en inspeccion; puede caducar
const TIMEOUT_MS = 10_000;
const PAGE_SIZE = 48;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pause = (min = 800, max = 1800) => sleep(min + Math.random() * (max - min));

/** Error que indica que Adidas nos esta bloqueando: hay que parar. */
export class AdidasBlockedError extends Error {
  constructor(status, url) {
    super(`Adidas respondio HTTP ${status}`);
    this.name = 'AdidasBlockedError';
    this.status = status;
    this.url = url;
  }
}

/** fetch con timeout. Lanza AdidasBlockedError en 403/429. */
async function fetchWithTimeout(url, headers = HEADERS, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (res.status === 403 || res.status === 429) {
      throw new AdidasBlockedError(res.status, url);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Obtiene el buildId dinamico de Next.js. Si falla usa el fallback.
 */
export async function getAdidasBuildId() {
  try {
    const res = await fetchWithTimeout('https://www.adidas.com/us/sale', {
      'User-Agent': HEADERS['User-Agent'],
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const match =
      html.match(/"buildId":"([^"]+)"/) ||
      html.match(/\/_next\/static\/([a-zA-Z0-9_-]+)\/_buildManifest\.js/);
    if (match?.[1]) return match[1];
  } catch (err) {
    if (err instanceof AdidasBlockedError) throw err;
    console.warn('⚠️ No se pudo obtener buildId dinamico, usando fallback:', err.message);
  }
  return FALLBACK_BUILD_ID;
}

/**
 * Disponibilidad y tallas de un producto.
 * Devuelve { status, inStock, sizes } o null si no se pudo consultar
 * (el llamador debe tratar null como "tallas sin verificar", no como agotado).
 * Lanza AdidasBlockedError en 403/429.
 */
export async function getProductAvailability(productId) {
  try {
    const url = `https://www.adidas.com/api/products/${productId}/availability?sitePath=us`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = await res.json();

    const sizes = (data.variation_list || [])
      .filter((v) => v.availability_status === 'IN_STOCK')
      .map((v) => ({ size: v.size, stock: v.availability, sku: v.sku }));

    return { status: data.availability_status, inStock: sizes.length > 0, sizes };
  } catch (err) {
    if (err instanceof AdidasBlockedError) throw err;
    return null;
  }
}

/** Extrae precios y descuento de un producto del PLP. */
function parsePricing(prod) {
  const prices = prod.priceData?.prices || [];
  const memberPriceObj = prices.find((p) => /member/i.test(p.type || ''));
  const salePriceObj = prices.find((p) => p.type === 'sale') || prices.find((p) => p !== memberPriceObj) || prices[0];
  const origPriceObj = prices.find((p) => p.type === 'original');

  const salePrice = salePriceObj?.value;
  const origPrice = origPriceObj?.value || salePrice;
  let discount = Math.abs(origPriceObj?.discountPercentage || 0);
  if (!discount && origPrice && salePrice && origPrice > salePrice) {
    discount = Math.round(((origPrice - salePrice) / origPrice) * 100);
  }

  const badgeText = (prod.badges || []).map((b) => b.text || '').join(' ');
  // Precio solo para miembros: no es el precio que ve un comprador normal.
  const membersOnly = Boolean(memberPriceObj) || /member/i.test(badgeText);

  return { salePrice, origPrice, discount, membersOnly };
}

/**
 * Caza ofertas en Adidas US.
 * @param {Object} options
 * @param {number}  options.minDiscount - Descuento minimo en % (ej: 40)
 * @param {number}  options.maxPages    - Paginas a consultar (48 items c/u)
 * @param {string}  options.sort        - 'top-sellers' (default) | 'price-low-to-high' | ...
 * @param {boolean} options.checkSizes  - Verificar tallas en tiempo real
 * @param {boolean} options.includeMembersOnly - Incluir precios solo-miembros (default false)
 * @returns {Promise<Array>} ofertas; el arreglo trae `.meta` con { blocked, blockedStatus, pagesScanned }
 */
export async function huntAdidasDeals(options = {}) {
  const {
    minDiscount = 40,
    maxPages = 2,
    sort = 'top-sellers',
    checkSizes = true,
    includeMembersOnly = false,
  } = options;

  console.log(`🔍 [Adidas Hunter] Iniciando escaneo... (Minimo: -${minDiscount}%, Paginas: ${maxPages})`);

  const meta = { blocked: false, blockedStatus: null, pagesScanned: 0 };
  const deals = [];
  let sizesBlocked = false;
  const seen = new Set();

  let buildId;
  try {
    buildId = await getAdidasBuildId();
  } catch (err) {
    if (err instanceof AdidasBlockedError) {
      console.error(`⛔ [Adidas Hunter] Bloqueado al obtener buildId (HTTP ${err.status}). Se detiene.`);
      meta.blocked = true;
      meta.blockedStatus = err.status;
      deals.meta = meta;
      return deals;
    }
    throw err;
  }
  console.log(`🔑 [Adidas Hunter] Build ID activo: ${buildId}`);

  const plpUrl = (id, start) =>
    `https://www.adidas.com/plp-app/_next/data/${id}/us/sale.json?path=us&taxonomy=sale&start=${start}&sort=${sort}&grid=true`;

  let refetchedBuildId = false;

  for (let page = 0; page < maxPages; page++) {
    const start = page * PAGE_SIZE;
    console.log(`📡 Pagina ${page + 1} (items ${start} a ${start + PAGE_SIZE})...`);

    try {
      let res = await fetchWithTimeout(plpUrl(buildId, start));

      // buildId caducado: Next.js responde 404. Se refresca UNA vez por corrida.
      if (res.status === 404 && !refetchedBuildId) {
        refetchedBuildId = true;
        console.warn('♻️ 404 en PLP: refrescando buildId una vez...');
        await pause();
        buildId = await getAdidasBuildId();
        res = await fetchWithTimeout(plpUrl(buildId, start));
      }

      if (!res.ok) {
        console.warn(`⚠️ HTTP ${res.status} en pagina ${page + 1}; se detiene el escaneo.`);
        break;
      }

      const data = await res.json();
      const products = data?.pageProps?.products || [];
      meta.pagesScanned++;
      if (products.length === 0) break;

      for (const prod of products) {
        if (!prod?.id || seen.has(prod.id)) continue;
        seen.add(prod.id);

        const { salePrice, origPrice, discount, membersOnly } = parsePricing(prod);
        if (discount < minDiscount || prod.priceData?.isSoldOut) continue;
        if (membersOnly && !includeMembersOnly) continue;

        const dealItem = {
          id: prod.id,
          brand: 'Adidas',
          title: prod.title,
          subtitle: prod.subTitle || '',
          category: prod.category || '',
          url: prod.url?.startsWith('http') ? prod.url : `https://www.adidas.com${prod.url}`,
          image: prod.image, // solo URL; no se descarga (Adidas bloquea con 403)
          originalPriceUsd: origPrice,
          salePriceUsd: salePrice,
          discountPercentage: discount,
          badge: prod.badges?.[0]?.text || '',
          membersOnly,
          sizes: [],
          sizesChecked: false,
        };

        if (checkSizes && !sizesBlocked) {
          try {
            await pause(500, 1200);
            const avail = await getProductAvailability(prod.id);
            if (avail && !avail.inStock) continue; // agotado de verdad
            if (avail) {
              dealItem.sizes = avail.sizes.map((s) => s.size);
              dealItem.availableSizesCount = avail.sizes.length;
              dealItem.sizesChecked = true;
            }
            // avail === null: no se pudo verificar; se conserva con sizesChecked=false
          } catch (err) {
            if (err instanceof AdidasBlockedError) {
              sizesBlocked = true;
              console.warn(`⛔ Tallas bloqueadas (HTTP ${err.status}); se deja de consultar tallas en esta corrida.`);
            } else {
              throw err;
            }
          }
        }

        deals.push(dealItem);
      }

      if (page < maxPages - 1) await pause();
    } catch (err) {
      if (err instanceof AdidasBlockedError) {
        console.error(`⛔ [Adidas Hunter] HTTP ${err.status} en pagina ${page + 1}. Se detiene sin reintentar.`);
        meta.blocked = true;
        meta.blockedStatus = err.status;
        break;
      }
      console.error(`❌ Error escaneando pagina ${page + 1}:`, err.name === 'AbortError' ? 'timeout' : err.message);
      break;
    }
  }

  deals.sort((a, b) => b.discountPercentage - a.discountPercentage);
  deals.meta = meta;
  return deals;
}

// Ejecucion directa de prueba
if (process.argv[1]?.endsWith('adidas.js')) {
  console.log('⚡ Ejecutando prueba directa de Adidas Deal Hunter...\n');
  huntAdidasDeals({ minDiscount: 50, maxPages: 1, checkSizes: true })
    .then((deals) => {
      console.log(`\n🎉 ${deals.length} ofertas con 50%+ OFF${deals.meta?.blocked ? ` (bloqueado HTTP ${deals.meta.blockedStatus})` : ''}\n`);
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
    .catch(console.error);
}
