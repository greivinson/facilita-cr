-- Aplicar despues de las migraciones 20261124 existentes.
-- Renombra las tablas del catalogo IA sin recrearlas ni perder sus datos.
ALTER TABLE ai_model_catalog RENAME TO catalogo_modelos_ia;
ALTER TABLE ai_model_catalog_status RENAME TO estado_catalogo_modelos_ia;

DROP INDEX IF EXISTS idx_ai_model_catalog_active;
CREATE INDEX idx_catalogo_modelos_ia_activos
  ON catalogo_modelos_ia (provider, active, supports_text, is_free, priority_rank, functional_status);

-- Compatibilidad de lectura con una version del Worker que aun consulte los nombres anteriores.
CREATE VIEW ai_model_catalog AS
  SELECT * FROM catalogo_modelos_ia;

CREATE VIEW ai_model_catalog_status AS
  SELECT * FROM estado_catalogo_modelos_ia;

CREATE TABLE IF NOT EXISTS corridas_escaneo (
  id TEXT PRIMARY KEY,
  proveedor TEXT NOT NULL,
  mercado TEXT NOT NULL,
  iniciado_el TEXT NOT NULL DEFAULT (datetime('now')),
  finalizado_el TEXT,
  estado TEXT NOT NULL DEFAULT 'iniciada'
    CHECK (estado IN ('iniciada', 'completada', 'fallida')),
  total_productos INTEGER NOT NULL DEFAULT 0,
  detalles_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS productos_tienda (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proveedor TEXT NOT NULL,
  mercado TEXT NOT NULL,
  producto_id_tienda TEXT NOT NULL,
  titulo TEXT NOT NULL,
  categoria TEXT,
  url TEXT NOT NULL,
  imagen_url TEXT,
  creado_el TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_el TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (proveedor, mercado, producto_id_tienda)
);

CREATE TABLE IF NOT EXISTS variantes_producto (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id INTEGER NOT NULL REFERENCES productos_tienda(id) ON DELETE CASCADE,
  variante_id_tienda TEXT,
  sku TEXT,
  gtin TEXT,
  talla TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '',
  disponible INTEGER NOT NULL DEFAULT 1,
  detalles_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (producto_id, talla, color)
);

CREATE TABLE IF NOT EXISTS observaciones_producto (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  corrida_id TEXT NOT NULL REFERENCES corridas_escaneo(id) ON DELETE CASCADE,
  producto_id INTEGER NOT NULL REFERENCES productos_tienda(id) ON DELETE CASCADE,
  observado_el TEXT NOT NULL DEFAULT (datetime('now')),
  moneda TEXT NOT NULL DEFAULT 'USD',
  precio_original REAL,
  precio_oferta REAL,
  descuento_pct REAL,
  solo_miembros INTEGER NOT NULL DEFAULT 0,
  disponible INTEGER,
  tallas_verificadas INTEGER NOT NULL DEFAULT 0,
  tallas_json TEXT NOT NULL DEFAULT '[]',
  detalles_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (corrida_id, producto_id)
);

CREATE INDEX IF NOT EXISTS idx_observaciones_producto_recientes
  ON observaciones_producto (producto_id, observado_el DESC);

CREATE INDEX IF NOT EXISTS idx_observaciones_corrida
  ON observaciones_producto (corrida_id, producto_id);
