-- ============================================================================
-- Flowbreeds POS — initial schema (migration 001)
-- Conventions:
--   * Primary keys are client-generated UUID TEXT (idempotent cloud sync).
--   * Money is INTEGER minor units (ngwee); never floats.
--   * Timestamps are TEXT ISO-8601 UTC.
--   * Booleans are INTEGER 0/1. Quantities are REAL (support weight).
--   * Syncable tables carry `sync_status`; EXCEPT append-only ledgers
--     (audit_log, price_history) which are immutable — their sync is tracked
--     solely via sync_queue rows so the tables stay 100% UPDATE/DELETE-proof.
-- ============================================================================

-- ===== Users =====
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,                 -- argon2id
  role          TEXT NOT NULL CHECK(role IN ('cashier','manager','administrator')),
  active        INTEGER NOT NULL DEFAULT 1,
  last_login    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  sync_status   TEXT NOT NULL DEFAULT 'pending'
);

-- ===== Branches (this install is tagged to one via app_config) =====
CREATE TABLE branches (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  details     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pending'
);

-- ===== Products =====
CREATE TABLE products (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  category            TEXT NOT NULL,
  unit_price          INTEGER NOT NULL,            -- minor units (per unit OR per kg)
  unit_of_measure     TEXT NOT NULL,               -- 'each' | 'kg' | 'g' ...
  is_weight_based     INTEGER NOT NULL DEFAULT 0,  -- price = weight * unit_price
  low_stock_threshold INTEGER NOT NULL DEFAULT 0,
  active              INTEGER NOT NULL DEFAULT 1,   -- deactivate, never hard-delete
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  sync_status         TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX idx_products_name ON products(name);
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_active ON products(active);

-- ===== Barcodes (multi-barcode per product) =====
CREATE TABLE barcodes (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id),
  barcode     TEXT NOT NULL UNIQUE,
  pack_label  TEXT,
  created_at  TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pending'
);
CREATE UNIQUE INDEX idx_barcodes_barcode ON barcodes(barcode);  -- the <500ms scan hot path

-- ===== Inventory: stock per product PER BRANCH =====
CREATE TABLE inventory (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id),
  branch_id   TEXT NOT NULL REFERENCES branches(id),
  quantity    REAL NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  UNIQUE(product_id, branch_id)
);
CREATE INDEX idx_inventory_branch ON inventory(branch_id);

-- ===== Till Sessions =====
CREATE TABLE till_sessions (
  id             TEXT PRIMARY KEY,
  cashier_id     TEXT NOT NULL REFERENCES users(id),
  branch_id      TEXT NOT NULL REFERENCES branches(id),
  open_time      TEXT NOT NULL,
  close_time     TEXT,
  opening_float  INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  total_sales    INTEGER,
  total_cash     INTEGER,
  total_card     INTEGER,
  total_mobile   INTEGER,
  txn_count      INTEGER,
  discount_total INTEGER,
  void_count     INTEGER,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  sync_status    TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX idx_sessions_status ON till_sessions(status);

-- ===== Transactions =====
CREATE TABLE transactions (
  id              TEXT PRIMARY KEY,
  reference       TEXT NOT NULL UNIQUE,
  branch_id       TEXT NOT NULL REFERENCES branches(id),
  cashier_id      TEXT NOT NULL REFERENCES users(id),
  session_id      TEXT NOT NULL REFERENCES till_sessions(id),
  datetime        TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'sale' CHECK(type IN ('sale','refund')),
  original_txn_id TEXT REFERENCES transactions(id),
  payment_method  TEXT NOT NULL,
  subtotal        INTEGER NOT NULL,
  discount_total  INTEGER NOT NULL DEFAULT 0,
  grand_total     INTEGER NOT NULL,
  tendered        INTEGER,
  change_due      INTEGER,
  status          TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed','voided','held')),
  authorised_by   TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  sync_status     TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX idx_txn_datetime ON transactions(datetime);
CREATE INDEX idx_txn_branch_date ON transactions(branch_id, datetime);
CREATE INDEX idx_txn_session ON transactions(session_id);
CREATE INDEX idx_txn_status ON transactions(status);

-- ===== Transaction Items (snapshots name + price; history preserved) =====
CREATE TABLE transaction_items (
  id                 TEXT PRIMARY KEY,
  transaction_id     TEXT NOT NULL REFERENCES transactions(id),
  product_id         TEXT NOT NULL REFERENCES products(id),
  product_name       TEXT NOT NULL,
  quantity           REAL NOT NULL,
  unit_price_at_sale INTEGER NOT NULL,
  line_discount      INTEGER NOT NULL DEFAULT 0,
  line_total         INTEGER NOT NULL,
  is_weight_based    INTEGER NOT NULL DEFAULT 0,
  sync_status        TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX idx_items_txn ON transaction_items(transaction_id);
CREATE INDEX idx_items_product ON transaction_items(product_id);

-- ===== Stock Movements (signed ledger) =====
CREATE TABLE stock_movements (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL REFERENCES products(id),
  branch_id    TEXT NOT NULL REFERENCES branches(id),
  type         TEXT NOT NULL CHECK(type IN ('sale','return','adjustment','stock_in')),
  quantity     REAL NOT NULL,                   -- signed: -sale, +stock_in/return
  reason       TEXT,
  reference_id TEXT,
  user_id      TEXT NOT NULL REFERENCES users(id),
  datetime     TEXT NOT NULL,
  notes        TEXT,
  sync_status  TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX idx_movements_product_date ON stock_movements(product_id, datetime);
CREATE INDEX idx_movements_branch_date ON stock_movements(branch_id, datetime);

-- ===== Price History (APPEND-ONLY; no sync_status; immutable) =====
CREATE TABLE price_history (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  old_price  INTEGER NOT NULL,
  new_price  INTEGER NOT NULL,
  changed_by TEXT NOT NULL,
  datetime   TEXT NOT NULL
);
CREATE INDEX idx_price_hist_product ON price_history(product_id, datetime);
CREATE TRIGGER price_history_no_update BEFORE UPDATE ON price_history
  BEGIN SELECT RAISE(ABORT, 'price_history is append-only'); END;
CREATE TRIGGER price_history_no_delete BEFORE DELETE ON price_history
  BEGIN SELECT RAISE(ABORT, 'price_history is append-only'); END;

-- ===== Audit Log (APPEND-ONLY; no sync_status; immutable — NS-04) =====
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  old_value   TEXT,
  new_value   TEXT,
  datetime    TEXT NOT NULL
);
CREATE INDEX idx_audit_datetime ON audit_log(datetime);
CREATE INDEX idx_audit_user ON audit_log(user_id);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- ===== Sync Queue (transactional outbox) =====
CREATE TABLE sync_queue (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL CHECK(action IN ('create','update','delete')),
  payload     TEXT NOT NULL,                    -- JSON snapshot at enqueue time
  status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','synced','failed')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_syncq_status ON sync_queue(status, updated_at);

-- ===== App config (key-value settings) =====
CREATE TABLE app_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
