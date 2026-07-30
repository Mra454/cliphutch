-- Product isolation for the ComputedKit Pro entitlement.
-- Existing licenses are ClipHutch licenses, so the default is intentional.
ALTER TABLE licenses ADD COLUMN product TEXT NOT NULL DEFAULT 'cliphutch';

CREATE INDEX IF NOT EXISTS idx_licenses_product ON licenses(product);
