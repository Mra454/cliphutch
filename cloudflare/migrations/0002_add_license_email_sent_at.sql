-- Track license-email delivery so the Stripe webhook retry loop can
-- re-attempt delivery instead of the worker swallowing Resend failures.
ALTER TABLE licenses ADD COLUMN email_sent_at INTEGER;

-- Existing rows predate tracking and all known customers have their keys;
-- backfill so replayed historical events do not re-email them.
UPDATE licenses SET email_sent_at = created_at WHERE email_sent_at IS NULL;
