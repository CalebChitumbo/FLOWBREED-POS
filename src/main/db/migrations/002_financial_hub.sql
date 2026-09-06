-- ============================================================================
-- Flowbreeds POS — migration 002: Financial Hub integration
-- Links this POS to the Flowbreeds Financial app (shared Firebase project).
--   * products.financial_id — the id of the matching product in the Financial
--     app's catalogue, so sale lines and stock movements posted to the hub
--     carry ids the bookkeeping app recognises. NULL = not linked.
--   * finhub_applied_movements — idempotency ledger for HQ deliveries pulled
--     from the Financial app's stockMovements collection: a movement id in
--     here has already been applied to local inventory and is never re-applied.
-- ============================================================================

ALTER TABLE products ADD COLUMN financial_id TEXT;
CREATE UNIQUE INDEX idx_products_financial_id
  ON products(financial_id) WHERE financial_id IS NOT NULL;

CREATE TABLE finhub_applied_movements (
  movement_id TEXT PRIMARY KEY,   -- the Financial app's stockMovements doc id
  applied_at  TEXT NOT NULL,      -- ISO-8601 UTC
  summary     TEXT                -- human-readable note of what was applied/skipped
);
