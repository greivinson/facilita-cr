CREATE TABLE ai_model_catalog_rebuilt (
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

INSERT INTO ai_model_catalog_rebuilt (
  provider, model_id, display_name, supports_text, is_free, context_length,
  input_price, output_price, catalog_order, metadata_json, active, discovered_at,
  updated_at, priority_rank, ranking_status, functional_status, functional_error
)
SELECT
  provider, model_id, display_name, supports_text, is_free, context_length,
  input_price, output_price, catalog_order, metadata_json, active, discovered_at,
  updated_at,
  CASE WHEN priority_rank BETWEEN 1 AND 5 THEN priority_rank ELSE NULL END,
  CASE WHEN priority_rank BETWEEN 6 AND 7 THEN 'standby' ELSE ranking_status END,
  'unknown',
  NULL
FROM ai_model_catalog;

DROP INDEX IF EXISTS idx_ai_model_catalog_active;
DROP TABLE ai_model_catalog;
ALTER TABLE ai_model_catalog_rebuilt RENAME TO ai_model_catalog;

CREATE INDEX idx_ai_model_catalog_active
  ON ai_model_catalog (provider, active, supports_text, is_free, priority_rank, functional_status);
