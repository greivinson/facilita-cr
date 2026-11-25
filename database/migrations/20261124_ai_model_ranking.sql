-- Apply once to D1 databases that already have the initial ai_model_catalog tables.
ALTER TABLE ai_model_catalog
  ADD COLUMN priority_rank INTEGER CHECK (priority_rank BETWEEN 1 AND 7);

ALTER TABLE ai_model_catalog
  ADD COLUMN ranking_status TEXT NOT NULL DEFAULT 'unranked';

ALTER TABLE ai_model_catalog_status
  ADD COLUMN ranking_status TEXT NOT NULL DEFAULT 'not_attempted';

ALTER TABLE ai_model_catalog_status
  ADD COLUMN ranker_provider TEXT;

ALTER TABLE ai_model_catalog_status
  ADD COLUMN ranker_model_id TEXT;

ALTER TABLE ai_model_catalog_status
  ADD COLUMN ranking_error TEXT;

DROP INDEX IF EXISTS idx_ai_model_catalog_active;
CREATE INDEX idx_ai_model_catalog_active
  ON ai_model_catalog (provider, active, supports_text, is_free, priority_rank);
