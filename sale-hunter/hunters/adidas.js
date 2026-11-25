/**
 * Adidas Deal Hunter
 * Consulta el endpoint Next.js PLP y la API de inventario de tallas en tiempo real.
 */

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.adidas.com/us/sale',
  'x-nextjs-data': '1',
};

/**
 * Obtiene el buildId dinámico de Next.js de Adidas si no se proporciona uno.
 */
export async function getAdidasBuildId() {
  try {
    const res = await fetch('https://www.adidas.com/us/sale', {
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    
    // Buscar buildId en el HTML de Next.js
    const match = html.match(/"buildId":"([^"]+)"/) || html.match(/\/_next\/static\/([a-zA-Z0-9_-]+)\/_buildManifest\.js/);
    if (match && match[1]) {
      return match[1];
    }
  } catch (err) {
    console.warn('⚠️ No se pudo obtener buildId dinámico, usando fallback:', err.message);
  }
  return '6bS-8OUb6ysDfiA5qHelc'; // Fallback observado en inspección
}

/**
 * Consulta la disponibilidad y tallas exactas de un producto por su ID/SKU.
 */
export async function getProductAvailability(productId) {
  try {
    const url = `https://www.adidas.com/api/products/${productId}/availability?sitePath=us`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    
    const sizes = (data.variation_list || [])
      .filter(v => v.availability_status === 'IN_STOCK')
      .map(v => ({
        size: v.size,
        stock: v.availability,
        sku: v.sku,
      }));

    return {
      status: data.availability_status,
      inStock: sizes.length > 0,
      sizes: sizes,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Caza ofertas en Adidas US.
 * @param {Object} options
 * @param {number} options.minDiscount - Descuento mínimo en porcentaje (ej: 40 para 40% o más)
 * @param {number} options.maxPages - Cuántas páginas consultar (48 items por página)
 * @param {string} options.sort - 'price-low-to-high' | 'top-sellers'
 * @param {boolean} options.checkSizes - Si debe verificar stock de tallas en tiempo real
 */
export async function huntAdidasDeals(options = {}) {
  const {
    minDiscount = 40,
    maxPages = 2,
    sort = 'price-low-to-high',
    checkSizes = true,
  } = options;

  console.log(`🔍 [Adidas Hunter] Iniciando escaneo... (Mínimo: -${minDiscount}%, Páginas: ${maxPages})`);
  const buildId = await getAdidasBuildId();
  console.log(`🔑 [Adidas Hunter] Build ID activo: ${buildId}`);

  const deals = [];

  for (let page = 0; page < maxPages; page++) {
    const start = page * 48;
    const url = `https://www.adidas.com/plp-app/_next/data/${buildId}/us/sale.json?path=us&taxonomy=sale&start=${start}&sort=${sort}&grid=true`;

    console.log(`📡 Consultando página ${page + 1} (items ${start} a ${start + 48})...`);
    
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) {
        console.warn(`⚠️ Error HTTP ${res.status} en página ${page + 1}`);
        continue;
      }
      const data = await res.json();
      const products = data?.pageProps?.products || [];

      for (const prod of products) {
        const prices = prod.priceData?.prices || [];
        const salePriceObj = prices.find(p => p.type === 'sale') || prices[0];
        const origPriceObj = prices.find(p => p.type === 'original');

        const salePrice = salePriceObj?.value;
        const origPrice = origPriceObj?.value || salePrice;
        let discount = Math.abs(origPriceObj?.discountPercentage || 0);

        if (!discount && origPrice && salePrice && origPrice > salePrice) {
          discount = Math.round(((origPrice - salePrice) / origPrice) * 100);
        }

        if (discount >= minDiscount && !prod.priceData?.isSoldOut) {
          const dealItem = {
            id: prod.id,
            brand: 'Adidas',
            title: prod.title,
            subtitle: prod.subTitle || '',
            category: prod.category || '',
            url: prod.url?.startsWith('http') ? prod.url : `https://www.adidas.com${prod.url}`,
            image: prod.image,
            originalPriceUsd: origPrice,
            salePriceUsd: salePrice,
            discountPercentage: discount,
            badge: prod.badges?.[0]?.text || '',
            sizes: [],
          };

          if (checkSizes) {
            const avail = await getProductAvailability(prod.id);
            if (avail && avail.inStock) {
              dealItem.sizes = avail.sizes.map(s => s.size);
              dealItem.availableSizesCount = avail.sizes.length;
            } else if (avail && !avail.inStock) {
              continue; // Descartar si no hay tallas disponibles
            }
          }

          deals.push(dealItem);
        }
      }
    } catch (err) {
      console.error(`❌ Error escaneando página ${page + 1}:`, err.message);
    }
  }

  // Ordenar por mayor porcentaje de descuento
  deals.sort((a, b) => b.discountPercentage - a.discountPercentage);

  return deals;
}

// Ejecución directa de prueba
if (process.argv[1]?.endsWith('adidas.js')) {
  console.log('⚡ Ejecutando prueba directa de Adidas Deal Hunter...\n');
  huntAdidasDeals({ minDiscount: 50, maxPages: 1, checkSizes: true })
    .then(deals => {
      console.log(`\n🎉 ¡Se encontraron ${deals.length} súper ofertas con 50%+ OFF!\n`);
      console.table(
        deals.slice(0, 10).map(d => ({
          Producto: d.title.substring(0, 24),
          'Original $': `$${d.originalPriceUsd}`,
          'Sale $': `$${d.salePriceUsd}`,
          'Desc.': `-${d.discountPercentage}%`,
          Tallas: d.sizes.slice(0, 6).join(', ') + (d.sizes.length > 6 ? '...' : ''),
        }))
      );
    })
    .catch(console.error);
}
