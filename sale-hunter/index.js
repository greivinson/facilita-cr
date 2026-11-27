/**
 * FacilitaCR — Sale Hunter Orchestrator
 * Punto de entrada para cazar ofertas en tiendas soportadas y calcular precios en CRC.
 */

import { exportAdidasDailyPromos, huntAdidasDeals } from './hunters/adidas.js';
import { randomUUID } from 'node:crypto';
import { getOperationalSettings, syncHuntedDeals } from '../shared/d1.js';
import { writeFailureLog } from './failure-logger.js';

function sanitizeLogUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  for (const key of url.searchParams.keys()) {
    if (/(token|key|auth|session|cookie|secret|signature)/i.test(key)) {
      url.searchParams.set(key, '[REDACTED]');
    }
  }
  return url.toString();
}

function summarizeResponse(response) {
  if (!response) return null;
  return {
    status: response.status,
    statusText: response.statusText,
    url: sanitizeLogUrl(response.url),
    headers: response.headers,
    bodyTruncated: response.bodyTruncated ?? null,
  };
}

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
  const scanRunId = randomUUID();
  const results = {
    timestamp: new Date().toISOString(),
    scanRunId,
    errors: [],
    stores: {},
  };

  let config;
  try {
    config = await getOperationalSettings();
  } catch (err) {
    results.errors.push({ step: 'configuration', message: err.message, cause: err.cause?.message ?? null });
    try {
      results.failureLogPath = await writeFailureLog({
        scanRunId,
        startedAt: results.timestamp,
        failures: results.errors.map((error) => ({
          hunter: error.hunter || (error.step?.startsWith('adidas') ? 'Adidas' : 'Sale Hunter'),
          stage: error.step,
          ...error,
        })),
      });
      console.error(`📝 Log de error guardado en: ${results.failureLogPath}`);
    } catch (logErr) {
      console.error('❌ No se pudo guardar el log de error:', logErr.message);
    }
    return results;
  }

  console.log('🏹 =========================================');
  console.log('   FACILITACR - SALE HUNTER v1.0');
  console.log('   Monitoreo Inteligente USA -> Costa Rica');
  console.log('=========================================\n');

  // 1. Adidas Hunter
  try {
    const adidasDeals = await huntAdidasDeals({
      minDiscount: options.minDiscount ?? 45,
      maxPages: options.maxPages ?? 4,
      sort: options.sort ?? 'top-sellers',
      checkSizes: options.checkSizes !== false,
      maxSizeChecks: options.maxSizeChecks ?? 30,
      includeMembersOnly: options.includeMembersOnly === true,
    });

    results.scan = {
      provider: 'Adidas',
      blocked: adidasDeals.meta?.blocked === true,
      blockedStatus: adidasDeals.meta?.blockedStatus ?? null,
      pagesScanned: adidasDeals.meta?.pagesScanned ?? 0,
      sizesChecked: adidasDeals.meta?.sizesChecked ?? 0,
      error: adidasDeals.meta?.error ?? null,
      cause: adidasDeals.meta?.cause ?? null,
      response: summarizeResponse(adidasDeals.meta?.response),
      failureUrl: adidasDeals.meta?.failureUrl ?? null,
      failures: (adidasDeals.meta?.failures ?? []).map((failure) => ({
        stage: failure.stage,
        productId: failure.productId ?? null,
        message: failure.message,
        httpStatus: failure.response?.status ?? null,
        url: sanitizeLogUrl(failure.url ?? failure.response?.url),
      })),
    };
    if (adidasDeals.meta?.blocked) {
      results.errors.push({
        step: 'adidas-scan',
        message: `Adidas bloqueo la corrida con HTTP ${adidasDeals.meta.blockedStatus}.`,
        url: adidasDeals.meta.failureUrl,
        response: adidasDeals.meta.response,
      });
    } else if (adidasDeals.meta?.error) {
      results.errors.push({
        step: 'adidas-scan',
        message: adidasDeals.meta.error,
        url: adidasDeals.meta.failureUrl,
        response: adidasDeals.meta.response,
        cause: adidasDeals.meta.cause,
      });
    }
    for (const failure of adidasDeals.meta?.failures || []) {
      results.errors.push({
        step: `adidas-${failure.stage}`,
        hunter: 'Adidas',
        message: failure.message,
        url: failure.url ?? failure.response?.url ?? null,
        response: failure.response ?? null,
        cause: failure.cause ?? null,
      });
    }

    results.stores.adidas = adidasDeals.map(d => ({
      ...d,
      totalCrcEstimado: calculatePriceCRC(d.salePriceUsd, config),
    }));

    if (adidasDeals.meta?.blocked) {
      console.error(`\n⛔ Adidas: corrida bloqueada (HTTP ${adidasDeals.meta.blockedStatus}); no se muestra como exitosa.`);
    } else if (adidasDeals.meta?.error) {
      console.error(`\n⚠️ Adidas: corrida incompleta: ${adidasDeals.meta.error}`);
    } else if (adidasDeals.meta?.failures?.length) {
      console.error(`\n⚠️ Adidas: corrida incompleta; ${adidasDeals.meta.failures.length} consulta(s) fallaron.`);
    } else {
      console.log(`\n✅ Adidas: ${adidasDeals.length} ofertas calificadas.`);
    }

    try {
      const manifestPath = await exportAdidasDailyPromos(results.stores.adidas, {
        scanRunId,
        scanMeta: adidasDeals.meta,
      });
      results.manifestPath = manifestPath;
      console.log(`🖼️ URLs de las mejores ofertas guardadas en: ${manifestPath}`);
    } catch (err) {
      results.errors.push({ step: 'manifest', message: err.message });
      console.error('❌ No se pudo guardar el manifiesto diario de Adidas:', err.message);
    }

    try {
      console.log('💾 Sincronizando ofertas, historial y observaciones en Cloudflare D1...');
      await syncHuntedDeals(results.stores.adidas, {
        scanRunId,
        provider: 'Adidas',
        market: 'US',
        scanStatus: results.scan?.blocked || adidasDeals.meta?.error || adidasDeals.meta?.failures?.length
          ? 'fallida'
          : 'completada',
        scanDetails: results.scan,
      });
      console.log(`✨ D1 actualizado para la corrida ${scanRunId}.`);
    } catch (err) {
      results.errors.push({ step: 'database', message: err.message });
      console.error('❌ No se pudo sincronizar Adidas con D1:', err.message);
    }

  } catch (err) {
    results.errors.push({
      step: 'adidas-scan',
      message: err.message,
      url: err.url ?? null,
      response: err.response ?? null,
      cause: err.cause?.message ?? null,
    });
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

  try {
    results.failureLogPath = await writeFailureLog({
      scanRunId,
      startedAt: results.timestamp,
      failures: results.errors.map((error) => ({
        hunter: error.hunter || (error.step?.startsWith('adidas') ? 'Adidas' : 'Sale Hunter'),
        stage: error.step,
        ...error,
      })),
    });
    if (results.failureLogPath) {
      console.error(`📝 Log de error guardado en: ${results.failureLogPath}`);
    }
  } catch (err) {
    results.errors.push({ step: 'failure-log', message: err.message });
    console.error('❌ No se pudo guardar el log de error:', err.message);
  }

  return results;
}

// Ejecución directa si se llama con `node index.js`
if (process.argv[1]?.endsWith('index.js')) {
  runSaleHunter()
    .then((results) => {
      if (results.errors.length > 0) process.exitCode = 1;
    })
    .catch((err) => {
      console.error('❌ Error ejecutando Sale Hunter:', err.message);
      process.exitCode = 1;
    });
}
