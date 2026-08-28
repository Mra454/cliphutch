-- Bound raw Stripe payment-intent/refund correlation records independently
-- from the shorter pseudonymous mutation journal.
ALTER TABLE stripe_refund_events
  ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;

-- Existing records begin their retention window at first observation. The
-- Worker writes an explicit configured expiry for every new event.
UPDATE stripe_refund_events
SET expires_at = observed_at + (365 * 24 * 60 * 60 * 1000)
WHERE expires_at = 0;

CREATE INDEX IF NOT EXISTS idx_stripe_refund_events_expiry
  ON stripe_refund_events(expires_at);
