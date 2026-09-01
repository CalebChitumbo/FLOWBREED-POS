-- ============================================================================
-- Flowbreeds POS — order planning (migration 002)
--
-- Lets the owner preset what each item COSTS TO BUY (the order/purchase cost,
-- not the shelf price), each saved under a short typed CODE, then build an
-- order plan by entering codes + quantities. The plan is a budget/shopping
-- list: planned spend, cash taken, what was actually paid, and the change
-- returned. Closed plans are permanent records (see the triggers below).
--
-- Same conventions as 001: UUID TEXT keys, money as INTEGER minor units
-- (ngwee), ISO-8601 UTC timestamps, quantities REAL, booleans INTEGER 0/1.
-- ============================================================================

-- ===== Order price list: the preset cost of each orderable item =====
CREATE TABLE order_catalogue (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL COLLATE NOCASE,  -- the shorthand typed when ordering, e.g. "BF01"
  name          TEXT NOT NULL,
  supplier      TEXT,
  unit_of_order TEXT NOT NULL,                 -- how it is bought: 'kg' | 'each' | 'box' | 'crate' ...
  unit_cost     INTEGER NOT NULL,              -- minor units per unit_of_order
  pack_size     REAL,                          -- optional: sell-units per order-unit (informational)
  product_id    TEXT REFERENCES products(id),  -- optional link to the POS product it stocks
  notes         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,    -- deactivate, never hard-delete
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  sync_status   TEXT NOT NULL DEFAULT 'pending'
);
-- The typed-code hot path. NOCASE so "bf01" and "BF01" are the same item.
CREATE UNIQUE INDEX idx_order_cat_code ON order_catalogue(code COLLATE NOCASE);
CREATE INDEX idx_order_cat_active ON order_catalogue(active);
CREATE INDEX idx_order_cat_product ON order_catalogue(product_id);

-- ===== Order cost history (APPEND-ONLY; immutable, like price_history) =====
CREATE TABLE order_cost_history (
  id           TEXT PRIMARY KEY,
  catalogue_id TEXT NOT NULL REFERENCES order_catalogue(id),
  old_cost     INTEGER NOT NULL,
  new_cost     INTEGER NOT NULL,
  changed_by   TEXT NOT NULL,
  datetime     TEXT NOT NULL
);
CREATE INDEX idx_order_cost_hist ON order_cost_history(catalogue_id, datetime);
CREATE TRIGGER order_cost_history_no_update BEFORE UPDATE ON order_cost_history
  BEGIN SELECT RAISE(ABORT, 'order_cost_history is append-only'); END;
CREATE TRIGGER order_cost_history_no_delete BEFORE DELETE ON order_cost_history
  BEGIN SELECT RAISE(ABORT, 'order_cost_history is append-only'); END;

-- ===== Order plans (one shopping trip / one order) =====
CREATE TABLE order_plans (
  id              TEXT PRIMARY KEY,
  reference       TEXT NOT NULL UNIQUE,          -- e.g. ORD-A1B2-000007
  title           TEXT NOT NULL,
  branch_id       TEXT NOT NULL REFERENCES branches(id),
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK(status IN ('draft','shopping','closed','cancelled')),
  planned_total   INTEGER NOT NULL DEFAULT 0,    -- sum of the line planned totals
  budget          INTEGER,                       -- cash taken / approved budget
  actual_total    INTEGER,                       -- what was really spent (set on close)
  change_returned INTEGER,                       -- budget - actual_total (set on close)
  notes           TEXT,
  created_by      TEXT NOT NULL REFERENCES users(id),
  closed_by       TEXT REFERENCES users(id),
  closed_at       TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  sync_status     TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX idx_order_plans_branch ON order_plans(branch_id, created_at);
CREATE INDEX idx_order_plans_status ON order_plans(status);

-- ===== Order plan lines (code/name/cost snapshotted at planning time) =====
CREATE TABLE order_plan_items (
  id                TEXT PRIMARY KEY,
  plan_id           TEXT NOT NULL REFERENCES order_plans(id),
  catalogue_id      TEXT REFERENCES order_catalogue(id),  -- NULL for a one-off line
  code              TEXT NOT NULL,      -- snapshot
  name              TEXT NOT NULL,      -- snapshot
  unit_of_order     TEXT NOT NULL,      -- snapshot
  quantity          REAL NOT NULL,
  unit_cost         INTEGER NOT NULL,   -- snapshot of the preset cost when planned
  line_total        INTEGER NOT NULL,   -- round(quantity * unit_cost)
  actual_quantity   REAL,               -- what was really bought (NULL = as planned)
  actual_unit_cost  INTEGER,            -- what it really cost (NULL = as planned)
  actual_line_total INTEGER,
  notes             TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  sync_status       TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX idx_order_plan_items_plan ON order_plan_items(plan_id, sort_order);
CREATE INDEX idx_order_plan_items_cat ON order_plan_items(catalogue_id);

-- ===== A closed or cancelled plan is a permanent record =====
-- The service refuses to edit one; these triggers make it impossible at the
-- storage layer too. The UPDATE that performs the close/cancel itself passes
-- (OLD.status is still draft/shopping when it fires).
--
-- `sync_status` is deliberately excluded from the comparisons below: the sync
-- engine marks pushed rows 'synced' long after a plan is closed, and that
-- bookkeeping must not be blocked. Every field that carries meaning is guarded,
-- so no edit can hide behind it.
CREATE TRIGGER order_plans_final_no_update BEFORE UPDATE ON order_plans
  WHEN OLD.status IN ('closed','cancelled')
   AND (NEW.reference       IS NOT OLD.reference
     OR NEW.title           IS NOT OLD.title
     OR NEW.branch_id       IS NOT OLD.branch_id
     OR NEW.status          IS NOT OLD.status
     OR NEW.planned_total   IS NOT OLD.planned_total
     OR NEW.budget          IS NOT OLD.budget
     OR NEW.actual_total    IS NOT OLD.actual_total
     OR NEW.change_returned IS NOT OLD.change_returned
     OR NEW.notes           IS NOT OLD.notes
     OR NEW.created_by      IS NOT OLD.created_by
     OR NEW.closed_by       IS NOT OLD.closed_by
     OR NEW.closed_at       IS NOT OLD.closed_at
     OR NEW.created_at      IS NOT OLD.created_at
     OR NEW.updated_at      IS NOT OLD.updated_at)
  BEGIN SELECT RAISE(ABORT, 'This order plan is closed and can no longer be changed.'); END;

CREATE TRIGGER order_plans_final_no_delete BEFORE DELETE ON order_plans
  WHEN OLD.status IN ('closed','cancelled')
  BEGIN SELECT RAISE(ABORT, 'This order plan is closed and can no longer be deleted.'); END;

CREATE TRIGGER order_plan_items_final_no_update BEFORE UPDATE ON order_plan_items
  WHEN (SELECT status FROM order_plans WHERE id = OLD.plan_id) IN ('closed','cancelled')
   AND (NEW.plan_id           IS NOT OLD.plan_id
     OR NEW.catalogue_id      IS NOT OLD.catalogue_id
     OR NEW.code              IS NOT OLD.code
     OR NEW.name              IS NOT OLD.name
     OR NEW.unit_of_order     IS NOT OLD.unit_of_order
     OR NEW.quantity          IS NOT OLD.quantity
     OR NEW.unit_cost         IS NOT OLD.unit_cost
     OR NEW.line_total        IS NOT OLD.line_total
     OR NEW.actual_quantity   IS NOT OLD.actual_quantity
     OR NEW.actual_unit_cost  IS NOT OLD.actual_unit_cost
     OR NEW.actual_line_total IS NOT OLD.actual_line_total
     OR NEW.notes             IS NOT OLD.notes
     OR NEW.sort_order        IS NOT OLD.sort_order
     OR NEW.created_at        IS NOT OLD.created_at
     OR NEW.updated_at        IS NOT OLD.updated_at)
  BEGIN SELECT RAISE(ABORT, 'This order plan is closed and can no longer be changed.'); END;

CREATE TRIGGER order_plan_items_final_no_delete BEFORE DELETE ON order_plan_items
  WHEN (SELECT status FROM order_plans WHERE id = OLD.plan_id) IN ('closed','cancelled')
  BEGIN SELECT RAISE(ABORT, 'This order plan is closed and can no longer be changed.'); END;
