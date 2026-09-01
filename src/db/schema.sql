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

-- ── Alert ingestion and background processing ────────────────────────────────
-- Added when the webhook receiver landed. Alerts arrive over HTTP and are
-- processed asynchronously, so the two concerns are stored separately: `alerts`
-- is the immutable record of what arrived, `jobs` is the mutable work queue.

CREATE TABLE alerts (
  -- The delivery id from the sender. PRIMARY KEY is what makes redelivery
  -- idempotent: a retried webhook collides here instead of queueing twice.
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  name         TEXT NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  payload      TEXT NOT NULL,
  received_at  TEXT NOT NULL
);

CREATE TABLE jobs (
  id            INTEGER PRIMARY KEY,
  kind          TEXT    NOT NULL,
  payload       TEXT    NOT NULL,
  status        TEXT    NOT NULL CHECK (status IN ('queued', 'in_flight', 'done', 'dead')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  -- Earliest time this job may be claimed; moved forward on each retry.
  run_after     TEXT    NOT NULL,
  -- Visibility timeout. A worker that dies mid-job leaves this in the past,
  -- which is what allows another worker to reclaim the job instead of it
  -- being lost. This is the difference between a queue and a to-do list.
  locked_until  TEXT,
  last_error    TEXT,
  result        TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE INDEX idx_jobs_claimable ON jobs(status, run_after);
CREATE INDEX idx_alerts_received ON alerts(received_at);
