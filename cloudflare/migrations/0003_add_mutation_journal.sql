-- Correlate license/activation mutations without copying raw customer
-- identifiers into operational repair records.
ALTER TABLE licenses ADD COLUMN refunded_event_id TEXT;
ALTER TABLE licenses ADD COLUMN refund_amount INTEGER;
ALTER TABLE licenses ADD COLUMN refund_amount_refunded INTEGER;
ALTER TABLE licenses ADD COLUMN email_delivery_key TEXT;
ALTER TABLE licenses ADD COLUMN email_delivery_claimed_at INTEGER;
ALTER TABLE activations ADD COLUMN created_event_id TEXT;

-- Production was checked for duplicate non-null payment intents before this
-- migration was prepared. Fail the migration rather than permit one refund to
-- mutate multiple license rows if that invariant changes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_payment_intent_unique
  ON licenses(payment_intent_id) WHERE payment_intent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS license_mutation_journal (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  source                   TEXT NOT NULL,
  external_event_id        TEXT NOT NULL,
  license_fingerprint      TEXT NOT NULL,
  installation_fingerprint TEXT,
  mutation_type            TEXT NOT NULL,
  previous_state           TEXT,
  next_state               TEXT,
  occurred_at              INTEGER NOT NULL,
  expires_at               INTEGER NOT NULL,
  metadata_json            TEXT NOT NULL DEFAULT '{}',
  UNIQUE (source, external_event_id, mutation_type)
);

CREATE INDEX IF NOT EXISTS idx_license_mutation_journal_license
  ON license_mutation_journal(license_fingerprint, occurred_at);
CREATE INDEX IF NOT EXISTS idx_license_mutation_journal_expiry
  ON license_mutation_journal(expires_at);

CREATE TABLE IF NOT EXISTS stripe_refund_events (
  event_id          TEXT PRIMARY KEY,
  payment_intent_id TEXT NOT NULL,
  is_full           INTEGER NOT NULL CHECK (is_full IN (0, 1)),
  amount            INTEGER NOT NULL,
  amount_refunded   INTEGER NOT NULL,
  observed_at       INTEGER NOT NULL,
  applied_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_stripe_refund_events_payment_intent
  ON stripe_refund_events(payment_intent_id, is_full, applied_at);

CREATE TABLE IF NOT EXISTS activation_tombstones (
  operation_id      TEXT PRIMARY KEY,
  license_fingerprint TEXT NOT NULL,
  installation_fingerprint TEXT NOT NULL,
  activation_id     TEXT NOT NULL,
  deactivated_at    INTEGER NOT NULL,
  reactivated_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_activation_tombstones_pair
  ON activation_tombstones(
    license_fingerprint, installation_fingerprint, reactivated_at
  );
