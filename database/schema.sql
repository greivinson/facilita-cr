-- ==============================================================================
-- FacilitaCR — Esquema Oficial de Base de Datos (Cloudflare D1)
-- Base de datos: facilita-cr (ID: b2a73693-048c-401f-a4f9-816ff3a10d32)
-- ==============================================================================

-- 1. Snapshot Maestro de Ofertas Cazadas
CREATE TABLE IF NOT EXISTS ofertas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tienda TEXT NOT NULL,                          -- 'Adidas', 'Nike', 'Puma', etc.
  producto_id_tienda TEXT NOT NULL,             -- ID único asignado por la tienda (ej. 'JR7190')
  titulo TEXT NOT NULL,
  categoria TEXT,
  url TEXT NOT NULL,
  imagen_url TEXT,
  precio_original_usd REAL NOT NULL,
  precio_sale_actual_usd REAL NOT NULL,
  descuento_actual_pct INTEGER NOT NULL,
  primera_deteccion TEXT DEFAULT (datetime('now')), -- Fecha en que se vio en sale por 1ra vez
  ultima_deteccion TEXT DEFAULT (datetime('now')),  -- Fecha de la última corrida que la detectó
  dias_en_sale INTEGER DEFAULT 1,                  -- Días consecutivos/acumulados en sale
  veces_escaneado INTEGER DEFAULT 1,              -- Veces totales que el cazador la ha encontrado
  estado TEXT DEFAULT 'ACTIVA',                   -- 'ACTIVA', 'FINALIZADA', 'AGOTADA'
  tallas_disponibles TEXT DEFAULT '[]',           -- JSON array de tallas en stock
  detalles_json TEXT DEFAULT '{}',                -- Atributos adicionales (badges, peso, etc.)
  UNIQUE(tienda, producto_id_tienda)              -- Evita duplicados y permite detectar reingresos
);

-- 2. Historial de Variaciones de Precio de Ofertas
CREATE TABLE IF NOT EXISTS ofertas_historial_precios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  oferta_id INTEGER NOT NULL REFERENCES ofertas(id) ON DELETE CASCADE,
  fecha TEXT DEFAULT (datetime('now')),
  precio_sale_usd REAL NOT NULL,
  precio_original_usd REAL,
  descuento_pct INTEGER,
  tipo_cambio TEXT NOT NULL                       -- 'INICIO_SALE', 'BAJA_PRECIO', 'SUBE_PRECIO', 'REINGRESO'
);

-- Triggers automáticos para historial de precios
CREATE TRIGGER IF NOT EXISTS trg_ofertas_nuevo_registro
AFTER INSERT ON ofertas
BEGIN
  INSERT INTO ofertas_historial_precios (
    oferta_id, precio_sale_usd, precio_original_usd, descuento_pct, tipo_cambio, fecha
  ) VALUES (
    NEW.id, NEW.precio_sale_actual_usd, NEW.precio_original_usd, NEW.descuento_actual_pct,
    'INICIO_SALE',
    datetime('now')
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_ofertas_cambio_precio
AFTER UPDATE OF precio_sale_actual_usd ON ofertas
WHEN OLD.precio_sale_actual_usd != NEW.precio_sale_actual_usd
BEGIN
  INSERT INTO ofertas_historial_precios (
    oferta_id, precio_sale_usd, precio_original_usd, descuento_pct, tipo_cambio, fecha
  ) VALUES (
    NEW.id, NEW.precio_sale_actual_usd, NEW.precio_original_usd, NEW.descuento_actual_pct,
    CASE WHEN NEW.precio_sale_actual_usd < OLD.precio_sale_actual_usd THEN 'BAJA_PRECIO' ELSE 'SUBE_PRECIO' END,
    datetime('now')
  );
END;

-- 3. Registro Histórico Diario del Tipo de Cambio
CREATE TABLE IF NOT EXISTS tipo_cambio_diario (
  fecha TEXT PRIMARY KEY,                         -- Formato ISO 'YYYY-MM-DD'
  tipo_cambio_crc REAL NOT NULL,                  -- Valor de referencia (ej. 528.5)
  compra REAL,
  venta REAL,
  fuente TEXT DEFAULT 'BCCR/AI',                  -- Origen del dato (BCCR o estimación IA)
  actualizado_el TEXT DEFAULT (datetime('now'))
);

-- 4. Pedidos y Encargos de Clientes
CREATE TABLE IF NOT EXISTS pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT DEFAULT (datetime('now')),
  cliente TEXT NOT NULL,
  producto TEXT NOT NULL,
  tienda TEXT,
  talla TEXT,
  costo_usd REAL NOT NULL,
  tipo_cambio_aplicado REAL NOT NULL,             -- Tipo de cambio congelado en la fecha del pedido
  total_crc REAL NOT NULL,
  abono_crc REAL DEFAULT 0,
  estado TEXT DEFAULT 'Cotizado',                 -- 'Cotizado', 'Confirmado', 'Enviado', 'Entregado', 'Pagado'
  detalles_json TEXT DEFAULT '{}'
);

-- 5. Configuración General Dinámica
CREATE TABLE IF NOT EXISTS configuracion (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL,
  descripcion TEXT,
  actualizado_el TEXT DEFAULT (datetime('now'))
);

-- Los valores operativos se provisionan directamente en D1 y no se guardan en el repositorio.

CREATE TABLE IF NOT EXISTS ai_model_catalog (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'groq', 'openrouter')),
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  supports_text INTEGER NOT NULL DEFAULT 0,
  is_free INTEGER,
  context_length INTEGER,
  input_price REAL,
  output_price REAL,
  catalog_order INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  priority_rank INTEGER CHECK (priority_rank BETWEEN 1 AND 5),
  ranking_status TEXT NOT NULL DEFAULT 'unranked',
  functional_status TEXT NOT NULL DEFAULT 'unknown',
  functional_error TEXT,
  PRIMARY KEY (provider, model_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_model_catalog_active
  ON ai_model_catalog (provider, active, supports_text, is_free, priority_rank);

CREATE TABLE IF NOT EXISTS ai_model_catalog_status (
  provider TEXT PRIMARY KEY CHECK (provider IN ('google', 'groq', 'openrouter')),
  status TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  model_count INTEGER,
  error_code TEXT,
  error_message TEXT,
  ranking_status TEXT NOT NULL DEFAULT 'not_attempted',
  ranker_provider TEXT,
  ranker_model_id TEXT,
  ranking_error TEXT
);
