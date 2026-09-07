-- Baseline schema for a new D1 database. Apply this once, then apply every
-- numbered migration in order. schema.sql is the resulting current snapshot.

CREATE TABLE IF NOT EXISTS licenses (
  key                 TEXT PRIMARY KEY,
  email               TEXT NOT NULL,
  stripe_session_id   TEXT NOT NULL UNIQUE,
  payment_intent_id   TEXT,
  status              TEXT NOT NULL DEFAULT 'active',
  created_at          INTEGER NOT NULL,
  refunded_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_licenses_email ON licenses(email);
CREATE INDEX IF NOT EXISTS idx_licenses_payment_intent ON licenses(payment_intent_id);

CREATE TABLE IF NOT EXISTS activations (
  license_key         TEXT NOT NULL,
  installation_id     TEXT NOT NULL,
  activated_at        INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL,
  PRIMARY KEY (license_key, installation_id),
  FOREIGN KEY (license_key) REFERENCES licenses(key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_activations_license ON activations(license_key);
