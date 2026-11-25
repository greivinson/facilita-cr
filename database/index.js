/**
 * FacilitaCR — Database Client Helper
 * Gestiona el almacenamiento de ofertas, variaciones de precio histórico
 * y tipo de cambio diario en Cloudflare D1 en transacciones batch de alta velocidad.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { OPERATIONAL_CONFIG_KEYS, parseOperationalSettings } from './config.js';

const execAsync = promisify(exec);
const DB_NAME = 'facilita-cr';
const WRANGLER_BIN = 'C:\\workspace\\facilita\\facilita-cr\\telegram-worker\\node_modules\\.bin\\wrangler.cmd';
const DB_DIR = 'C:\\workspace\\facilita\\facilita-cr\\database';

/**
 * Ejecuta una sentencia SQL en Cloudflare D1 mediante wrangler CLI.
 */
export async function executeSql(sqlQuery) {
  try {
    const escapedQuery = sqlQuery.replace(/"/g, '\\"');
    const command = `"${WRANGLER_BIN}" d1 execute ${DB_NAME} --remote --command="${escapedQuery}" --json --yes`;
    
    const { stdout } = await execAsync(command, { cwd: DB_DIR });
    const jsonStart = stdout.search(/^\s*\[/m);
    if (jsonStart === -1) {
      throw new Error('Wrangler D1 query did not return JSON output.');
    }
    const parsed = JSON.parse(stdout.slice(jsonStart));
    if (!Array.isArray(parsed)) {
      throw new Error('Wrangler D1 query returned an unexpected JSON shape.');
    }
    return parsed[0]?.results || [];
  } catch (err) {
    console.error('❌ Error ejecutando SQL en D1:', err.message);
    throw err;
  }
}

export async function executeSqlFile(sqlScript, fileName = 'temp_d1.sql') {
  const filePath = `${DB_DIR}\\${process.pid}_${Date.now()}_${fileName}`;
  await fs.writeFile(filePath, sqlScript, 'utf-8');

  try {
    const command = `"${WRANGLER_BIN}" d1 execute ${DB_NAME} --remote --file="${filePath}" --yes`;
    await execAsync(command, { cwd: DB_DIR });
  } catch (err) {
    console.error('❌ Error ejecutando script SQL en D1:', err.message);
    throw err;
  } finally {
    try { await fs.unlink(filePath); } catch (_) {}
  }
}

export async function getOperationalSettings() {
  const keys = OPERATIONAL_CONFIG_KEYS.map((key) => `'${key}'`).join(', ');
  const rows = await executeSql(
    `SELECT clave, valor FROM configuracion WHERE clave IN (${keys})`
  );
  return parseOperationalSettings(rows);
}

/**
 * Sincroniza ofertas cazadas en un solo batch atómico:
 * - Detecta si el producto ya existe (tienda + producto_id_tienda).
 * - Si es nuevo, lo inserta y el trigger de D1 registra automáticamente 'INICIO_SALE' en el historial.
 * - Si ya existe, actualiza precios, calcula días acumulados en sale y el trigger registra
 *   automáticamente 'BAJA_PRECIO' o 'SUBE_PRECIO' solo si el precio cambió.
 */
export async function syncHuntedDeals(deals = []) {
  if (!deals.length) return { total: 0 };

  const statements = [];

  for (const deal of deals) {
    const tienda = (deal.brand || 'Adidas').replace(/'/g, "''");
    const productoId = String(deal.id || deal.modelNumber || deal.title).trim().replace(/'/g, "''");
    const titulo = (deal.title || '').replace(/'/g, "''");
    const categoria = (deal.category || deal.subtitle || '').replace(/'/g, "''");
    const url = (deal.url || '').replace(/'/g, "''");
    const imagen = (deal.image || '').replace(/'/g, "''");
    const origPrice = deal.originalPriceUsd || 0;
    const salePrice = deal.salePriceUsd || 0;
    const discount = deal.discountPercentage || 0;
    const tallasJson = JSON.stringify(deal.sizes || []).replace(/'/g, "''");
    const detallesJson = JSON.stringify({
      badge: deal.badge || '',
      totalCrcEstimado: deal.totalCrcEstimado || 0,
    }).replace(/'/g, "''");

    statements.push(`
      INSERT INTO ofertas (
        tienda, producto_id_tienda, titulo, categoria, url, imagen_url,
        precio_original_usd, precio_sale_actual_usd, descuento_actual_pct,
        primera_deteccion, ultima_deteccion, dias_en_sale, veces_escaneado,
        estado, tallas_disponibles, detalles_json
      ) VALUES (
        '${tienda}', '${productoId}', '${titulo}', '${categoria}', '${url}', '${imagen}',
        ${origPrice}, ${salePrice}, ${discount},
        datetime('now'), datetime('now'), 1, 1,
        'ACTIVA', '${tallasJson}', '${detallesJson}'
      )
      ON CONFLICT(tienda, producto_id_tienda) DO UPDATE SET
        precio_sale_actual_usd = excluded.precio_sale_actual_usd,
        descuento_actual_pct = excluded.descuento_actual_pct,
        ultima_deteccion = datetime('now'),
        dias_en_sale = CAST(ROUND(julianday('now') - julianday(primera_deteccion)) + 1 AS INTEGER),
        veces_escaneado = veces_escaneado + 1,
        estado = 'ACTIVA',
        tallas_disponibles = excluded.tallas_disponibles,
        detalles_json = excluded.detalles_json;
    `.trim());
  }

  const batchSql = statements.join('\n\n');
  const tempFile = 'C:\\workspace\\facilita\\facilita-cr\\database\\temp_sync.sql';
  await fs.writeFile(tempFile, batchSql, 'utf-8');

  try {
    const command = `"${WRANGLER_BIN}" d1 execute ${DB_NAME} --remote --file=temp_sync.sql --yes`;
    await execAsync(command, { cwd: DB_DIR });
    return { total: deals.length, exito: true };
  } catch (err) {
    console.error('❌ Error en sincronización batch:', err.message);
    return { total: deals.length, exito: false, error: err.message };
  } finally {
    try { await fs.unlink(tempFile); } catch (_) {}
  }
}

/**
 * Registra o actualiza el tipo de cambio del día (para congelar cotizaciones).
 * @param {number} rate - Valor en colones (ej. 528.5)
 * @param {string} fuente - Fuente de la cotización (ej. 'BCCR', 'Google AI')
 */
export async function recordDailyExchangeRate(rate, fuente = 'AI') {
  const today = new Date().toISOString().split('T')[0];

  const sql = `
    INSERT INTO tipo_cambio_diario (fecha, tipo_cambio_crc, fuente, actualizado_el)
    VALUES ('${today}', ${rate}, '${fuente}', datetime('now'))
    ON CONFLICT(fecha) DO UPDATE SET
      tipo_cambio_crc = excluded.tipo_cambio_crc,
      fuente = excluded.fuente,
      actualizado_el = datetime('now');

    INSERT INTO configuracion (clave, valor, descripcion, actualizado_el)
    VALUES ('tipo_cambio_crc', '${rate}', 'Tipo de cambio diario vigente', datetime('now'))
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_el = datetime('now');

    INSERT INTO configuracion (clave, valor, descripcion, actualizado_el)
    VALUES ('tipo_cambio_ultima_fecha', '${today}', 'Fecha del tipo de cambio diario', datetime('now'))
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_el = datetime('now');
  `.trim().replace(/\n/g, ' ');

  const tempFile = 'C:\\workspace\\facilita\\facilita-cr\\database\\temp_rate.sql';
  await fs.writeFile(tempFile, sql, 'utf-8');

  try {
    const command = `"${WRANGLER_BIN}" d1 execute ${DB_NAME} --remote --file=temp_rate.sql --yes`;
    await execAsync(command, { cwd: DB_DIR });
    return { fecha: today, tipo_cambio: rate };
  } finally {
    try { await fs.unlink(tempFile); } catch (_) {}
  }
}
