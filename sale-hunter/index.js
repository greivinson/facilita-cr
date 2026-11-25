/**
 * FacilitaCR — Sale Hunter Orchestrator
 * Punto de entrada para cazar ofertas en tiendas soportadas y calcular precios en CRC.
 */

import { huntAdidasDeals } from './hunters/adidas.js';
import { getOperationalSettings, syncHuntedDeals } from '../database/index.js';

/**
 * Calcula el precio final en colones costarricenses (CRC)
 */
export function calculatePriceCRC(priceUsd, config, weightLbs = config.peso_default_lbs) {
  const costoTotalUsd = priceUsd + (weightLbs * config.flete_libra_usd);
  const totalCrc = Math.round(
    costoTotalUsd * (1 + config.margen_ganancia) * config.tipo_cambio_crc
  );
  return totalCrc;
}

/**
 * Caza ofertas de todas las tiendas configuradas y las sincroniza con Cloudflare D1
 */
export async function runSaleHunter(options = {}) {
  const config = await getOperationalSettings();

  console.log('🏹 =========================================');
  console.log('   FACILITACR - SALE HUNTER v1.0');
  console.log('   Monitoreo Inteligente USA -> Costa Rica');
  console.log('=========================================\n');

  const results = {
    timestamp: new Date().toISOString(),
    stores: {},
  };

  // 1. Adidas Hunter
  try {
    const adidasDeals = await huntAdidasDeals({
      minDiscount: options.minDiscount || 45,
      maxPages: options.maxPages || 1,
      checkSizes: options.checkSizes !== false,
    });

    results.stores.adidas = adidasDeals.map(d => ({
      ...d,
      totalCrcEstimado: calculatePriceCRC(d.salePriceUsd, config),
    }));

    console.log(`\n✅ Adidas: ${adidasDeals.length} ofertas calificadas.`);
    
    // Guardar en la base de datos centralizada Cloudflare D1
    if (results.stores.adidas.length > 0) {
      console.log('💾 Sincronizando ofertas e historial en Cloudflare D1...');
      const { nuevos, actualizados, cambiosPrecio } = await syncHuntedDeals(results.stores.adidas);
      console.log(`✨ D1 Actualizado: ${nuevos} nuevas | ${actualizados} actualizadas | ${cambiosPrecio} cambios de precio.`);
    }

  } catch (err) {
    console.error('❌ Error en Adidas Hunter:', err.message);
  }

  // Resumen visual de las mejores ofertas
  const allDeals = (results.stores.adidas || []);
  if (allDeals.length > 0) {
    console.log('\n🔥 TOP MEJORES OFERTAS ENCONTRADAS:');
    console.table(
      allDeals.slice(0, 8).map(d => ({
        Tienda: d.brand,
        Producto: d.title.substring(0, 26),
        'USA $': `$${d.salePriceUsd}`,
        'Desc.': `-${d.discountPercentage}%`,
        'Total CRC': `₡${d.totalCrcEstimado.toLocaleString('es-CR')}`,
        Tallas: d.sizes.slice(0, 5).join(',') + (d.sizes.length > 5 ? '...' : ''),
      }))
    );
  }

  return results;
}

// Ejecución directa si se llama con `node index.js`
if (process.argv[1]?.endsWith('index.js')) {
  runSaleHunter();
}
