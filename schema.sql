-- FacilitaCR: Esquema de base de datos compartida para Cloudflare D1
-- Ejecutar con:
--   wrangler d1 execute facilita-cr --remote --file=..\schema.sql

CREATE TABLE IF NOT EXISTS pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT DEFAULT (datetime('now')),
  cliente TEXT NOT NULL,
  producto TEXT NOT NULL,
  tienda TEXT,
  talla TEXT,
  costo_usd REAL,
  total_crc REAL,
  abono_crc REAL DEFAULT 0,
  estado TEXT DEFAULT 'Cotizado',
  detalles_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS historial_ofertas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT DEFAULT (datetime('now')),
  tienda TEXT NOT NULL,
  producto TEXT NOT NULL,
  precio_usd REAL,
  url_hash TEXT UNIQUE,
  detalles_json TEXT DEFAULT '{}'
);

-- Tabla de configuración general dinámica (actualizable por IA o SQL)
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
