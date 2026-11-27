/**
 * FacilitaCR — D1 Runtime Adapter
 * Gestiona el almacenamiento de ofertas, variaciones de precio histórico
 * y tipo de cambio diario en Cloudflare D1 en transacciones batch de alta velocidad.
 */

import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { OPERATIONAL_CONFIG_KEYS, parseOperationalSettings } from './config.js';

const execAsync = promisify(exec);
const DB_NAME = 'facilita-cr';
const WRANGLER_BIN = 'C:\\workspace\\facilita\\facilita-cr\\telegram-worker\\node_modules\\.bin\\wrangler.cmd';
const DB_DIR = 'C:\\workspace\\facilita\\facilita-cr\\database';

function quoteSql(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function sqlNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : 'NULL';
}

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
 * Sincroniza ofertas e historial de observaciones para una corrida:
 * - Detecta si el producto ya existe (tienda + producto_id_tienda).
 * - Si es nuevo, lo inserta y el trigger de D1 registra automáticamente 'INICIO_SALE' en el historial.
 * - Si ya existe, actualiza precios, calcula días acumulados en sale y el trigger registra
 *   automáticamente 'BAJA_PRECIO' o 'SUBE_PRECIO' solo si el precio cambió.
 */
export async function syncHuntedDeals(
  deals = [],
  {
    scanRunId = randomUUID(),
    provider = 'Adidas',
    market = 'US',
    scanStatus = 'completada',
    scanDetails = {},
  } = {}
) {
  if (!Array.isArray(deals)) throw new Error('deals debe ser un array.');
  const runId = String(scanRunId);
  const providerKey = String(provider || '').trim().toLowerCase();
  const marketKey = String(market || '').trim().toUpperCase();
  if (!runId || !providerKey || !marketKey) {
    throw new Error('La corrida requiere ID, proveedor y mercado.');
  }
  if (!['completada', 'fallida'].includes(scanStatus)) {
    throw new Error('scanStatus debe ser completada o fallida.');
  }
  const statements = [
    `INSERT INTO corridas_escaneo (id, proveedor, mercado, iniciado_el, estado, total_productos)
     VALUES (${quoteSql(runId)}, ${quoteSql(providerKey)}, ${quoteSql(marketKey)}, datetime('now'), 'iniciada', ${deals.length})
     ON CONFLICT(id) DO NOTHING;`,
  ];

  for (const deal of deals) {
    const tienda = String(deal.brand || provider);
    const productoIdValue = String(deal.id || deal.modelNumber || '').trim();
    if (!productoIdValue) throw new Error('Cada oferta debe incluir un ID externo de producto.');
    const productoId = quoteSql(productoIdValue);
    const tituloValue = String(deal.title || '');
    const categoriaValue = String(deal.category || deal.subtitle || '');
    const urlValue = String(deal.url || '');
    const imagenValue = String(deal.image || '');
    if (!tituloValue || !urlValue) {
      throw new Error(`La oferta ${productoIdValue} debe incluir titulo y URL.`);
    }
    if (
      !Number.isFinite(Number(deal.originalPriceUsd)) ||
      !Number.isFinite(Number(deal.salePriceUsd)) ||
      !Number.isFinite(Number(deal.discountPercentage))
    ) {
      throw new Error(`La oferta ${productoIdValue} tiene precios o descuento invalidos.`);
    }
    const origPrice = sqlNumber(deal.originalPriceUsd);
    const salePrice = sqlNumber(deal.salePriceUsd);
    const discount = sqlNumber(deal.discountPercentage);
    const tallas = Array.isArray(deal.sizes) ? deal.sizes : [];
    const tallasJson = quoteSql(JSON.stringify(tallas));
    const detalles = {
      badge: deal.badge || '',
      totalCrcEstimado: deal.totalCrcEstimado ?? null,
      membersOnly: deal.membersOnly === true,
      sizesChecked: deal.sizesChecked === true,
    };
    const detallesJson = quoteSql(JSON.stringify(detalles));
    const tiendaSql = quoteSql(tienda);
    const tituloSql = quoteSql(tituloValue);
    const categoriaSql = quoteSql(categoriaValue);
    const urlSql = quoteSql(urlValue);
    const imagenSql = quoteSql(imagenValue);
    const proveedorSql = quoteSql(providerKey);
    const mercadoSql = quoteSql(marketKey);

    statements.push(`
      INSERT INTO ofertas (
        tienda, producto_id_tienda, titulo, categoria, url, imagen_url,
        precio_original_usd, precio_sale_actual_usd, descuento_actual_pct,
        primera_deteccion, ultima_deteccion, dias_en_sale, veces_escaneado,
        estado, tallas_disponibles, detalles_json
      ) VALUES (
        ${tiendaSql}, ${productoId}, ${tituloSql}, ${categoriaSql}, ${urlSql}, ${imagenSql},
        ${origPrice}, ${salePrice}, ${discount},
        datetime('now'), datetime('now'), 1, 1,
        'ACTIVA', ${tallasJson}, ${detallesJson}
      )
      ON CONFLICT(tienda, producto_id_tienda) DO UPDATE SET
        titulo = excluded.titulo,
        categoria = excluded.categoria,
        url = excluded.url,
        imagen_url = excluded.imagen_url,
        precio_original_usd = excluded.precio_original_usd,
        precio_sale_actual_usd = excluded.precio_sale_actual_usd,
        descuento_actual_pct = excluded.descuento_actual_pct,
        ultima_deteccion = datetime('now'),
        dias_en_sale = CAST(ROUND(julianday('now') - julianday(primera_deteccion)) + 1 AS INTEGER),
        veces_escaneado = veces_escaneado + 1,
        estado = 'ACTIVA',
        tallas_disponibles = excluded.tallas_disponibles,
        detalles_json = excluded.detalles_json;
    `.trim());

    statements.push(`
      INSERT INTO productos_tienda (
        proveedor, mercado, producto_id_tienda, titulo, categoria, url, imagen_url
      ) VALUES (
        ${proveedorSql}, ${mercadoSql}, ${productoId}, ${tituloSql},
        ${categoriaSql}, ${urlSql}, ${imagenSql}
      )
      ON CONFLICT(proveedor, mercado, producto_id_tienda) DO UPDATE SET
        titulo = excluded.titulo,
        categoria = excluded.categoria,
        url = excluded.url,
        imagen_url = excluded.imagen_url,
        actualizado_el = datetime('now');

      INSERT INTO observaciones_producto (
        corrida_id, producto_id, moneda, precio_original, precio_oferta, descuento_pct,
        solo_miembros, disponible, tallas_verificadas, tallas_json, detalles_json
      )
      SELECT
        ${quoteSql(runId)}, id, 'USD', ${origPrice}, ${salePrice}, ${discount},
        ${deal.membersOnly === true ? 1 : 0},
        ${deal.sizesChecked === true ? (tallas.length > 0 ? 1 : 0) : 'NULL'},
        ${deal.sizesChecked === true ? 1 : 0}, ${tallasJson}, ${detallesJson}
      FROM productos_tienda
      WHERE proveedor = ${proveedorSql}
        AND mercado = ${mercadoSql}
        AND producto_id_tienda = ${productoId}
      ON CONFLICT(corrida_id, producto_id) DO UPDATE SET
        observado_el = datetime('now'),
        precio_original = excluded.precio_original,
        precio_oferta = excluded.precio_oferta,
        descuento_pct = excluded.descuento_pct,
        solo_miembros = excluded.solo_miembros,
        disponible = excluded.disponible,
        tallas_verificadas = excluded.tallas_verificadas,
        tallas_json = excluded.tallas_json,
        detalles_json = excluded.detalles_json;
    `.trim());

    const sizeVariants = Array.isArray(deal.sizeVariants)
      ? deal.sizeVariants
      : tallas.map((size) => ({ size }));
    if (deal.sizesChecked === true) {
      statements.push(`
        UPDATE variantes_producto
        SET disponible = 0
        WHERE producto_id = (
          SELECT id FROM productos_tienda
          WHERE proveedor = ${proveedorSql}
            AND mercado = ${mercadoSql}
            AND producto_id_tienda = ${productoId}
        );
      `.trim());
    }
    for (const variant of sizeVariants) {
      if (!variant?.size) continue;
      const sizeSql = quoteSql(variant.size);
      const skuSql = variant.sku ? quoteSql(variant.sku) : 'NULL';
      const variantDetails = quoteSql(JSON.stringify({ stock: variant.stock ?? null }));
      statements.push(`
        INSERT INTO variantes_producto (
          producto_id, variante_id_tienda, sku, talla, color, disponible, detalles_json
        )
        SELECT id, ${skuSql}, ${skuSql}, ${sizeSql}, '', 1, ${variantDetails}
        FROM productos_tienda
        WHERE proveedor = ${proveedorSql}
          AND mercado = ${mercadoSql}
          AND producto_id_tienda = ${productoId}
        ON CONFLICT(producto_id, talla, color) DO UPDATE SET
          variante_id_tienda = COALESCE(excluded.variante_id_tienda, variantes_producto.variante_id_tienda),
          sku = COALESCE(excluded.sku, variantes_producto.sku),
          detalles_json = excluded.detalles_json,
          disponible = 1;
      `.trim());
    }
  }

  statements.push(`
    UPDATE corridas_escaneo
    SET estado = ${quoteSql(scanStatus)}, finalizado_el = datetime('now'),
        detalles_json = ${quoteSql(JSON.stringify(scanDetails))}
    WHERE id = ${quoteSql(runId)};
  `);
  const batchSql = statements.join('\n\n');
  const tempFile = path.join(DB_DIR, `temp_sync_${process.pid}_${Date.now()}.sql`);
  await fs.writeFile(tempFile, batchSql, 'utf-8');

  try {
    const command = `"${WRANGLER_BIN}" d1 execute ${DB_NAME} --remote --file="${tempFile}" --yes`;
    await execAsync(command, { cwd: DB_DIR });
    return { total: deals.length, exito: true, scanRunId: runId };
  } catch (err) {
    console.error('❌ Error en sincronización batch:', err.message);
    throw new Error(`No se pudo persistir la corrida ${runId} en D1: ${err.message}`, { cause: err });
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
