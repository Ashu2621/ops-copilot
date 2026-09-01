-- Operational domain for a small orders/payments service.
-- Deliberately narrow: enough shape for realistic on-call questions,
-- small enough that a reviewer can hold the whole schema in their head.

CREATE TABLE customers (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  email       TEXT    NOT NULL,
  phone       TEXT    NOT NULL,
  tier        TEXT    NOT NULL CHECK (tier IN ('free', 'pro', 'enterprise')),
  created_at  TEXT    NOT NULL
);

CREATE TABLE orders (
  id           INTEGER PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  status       TEXT    NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled')),
  total_cents  INTEGER NOT NULL,
  created_at   TEXT    NOT NULL
);

CREATE TABLE payments (
  id            INTEGER PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES orders(id),
  status        TEXT    NOT NULL CHECK (status IN ('succeeded', 'failed', 'pending')),
  amount_cents  INTEGER NOT NULL,
  -- NULL whenever status <> 'failed'
  failure_code  TEXT,
  created_at    TEXT    NOT NULL
);

CREATE TABLE refunds (
  id            INTEGER PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES orders(id),
  amount_cents  INTEGER NOT NULL,
  reason        TEXT    NOT NULL,
  approved_by   TEXT    NOT NULL,
  created_at    TEXT    NOT NULL
);

CREATE TABLE service_metrics (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  value        REAL    NOT NULL,
  recorded_at  TEXT    NOT NULL
);

CREATE INDEX idx_orders_status     ON orders(status);
CREATE INDEX idx_orders_created    ON orders(created_at);
CREATE INDEX idx_payments_status   ON payments(status);
CREATE INDEX idx_payments_created  ON payments(created_at);
CREATE INDEX idx_metrics_name_time ON service_metrics(name, recorded_at);
