-- Attempt number of a payout for one invoice: the suffix of the Thyme Idempotency-Key (payout-<invoiceId>-<attempt>).
-- A retry bumps it so Thyme starts a new run instead of replaying the earlier answer.
ALTER TABLE payouts ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
