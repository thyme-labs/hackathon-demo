-- "Approve" without "send": the owner approved the invoice (beneficiary registered, limit set) but did not
-- release the payout yet. status stays 'approved', no payout row exists until the owner clicks "Send".
ALTER TABLE invoices ADD COLUMN hold INTEGER NOT NULL DEFAULT 0;
-- "Send anyway": the owner paid despite failed checks (audit event owner.override carries the reason and the
-- acknowledged check ids). The invoice list and the payout rows show an "overridden" badge.
ALTER TABLE invoices ADD COLUMN override INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payouts ADD COLUMN override INTEGER NOT NULL DEFAULT 0;
