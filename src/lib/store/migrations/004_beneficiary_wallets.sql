-- A beneficiary can have several wallets (e.g. a contractor with a hardware wallet and a hot wallet).
-- beneficiaries.wallet stays the PRIMARY approved wallet so existing readers keep working; this table is
-- the source of truth for which wallets may be paid. A wallet printed on an invoice for a known payee is
-- recorded here as 'pending' (source 'invoice') and is never paid until the owner approves it explicitly:
-- that is the invoice-redirection (BEC) vector.
CREATE TABLE IF NOT EXISTS beneficiary_wallets (
  id                   TEXT PRIMARY KEY,
  beneficiary_id       TEXT NOT NULL REFERENCES beneficiaries (id) ON DELETE CASCADE,
  wallet               TEXT NOT NULL,
  label                TEXT,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'revoked')),
  is_primary           INTEGER NOT NULL DEFAULT 0,
  ownership_proof_json TEXT,
  source               TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('registration', 'invoice', 'manual')),
  approved_by          TEXT,
  approved_at          TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (beneficiary_id, wallet)
);

CREATE INDEX IF NOT EXISTS idx_beneficiary_wallets_beneficiary ON beneficiary_wallets (beneficiary_id, status);
CREATE INDEX IF NOT EXISTS idx_beneficiary_wallets_wallet ON beneficiary_wallets (wallet);

-- Backfill: every beneficiary with a wallet gets one approved primary row carrying its ownership proof.
INSERT OR IGNORE INTO beneficiary_wallets (id, beneficiary_id, wallet, label, status, is_primary, ownership_proof_json, source, approved_by, approved_at, created_at)
SELECT lower(hex(randomblob(16))), id, lower(wallet), 'primary', 'approved', 1, ownership_proof_json, 'registration', 'owner', created_at, created_at
FROM beneficiaries
WHERE wallet IS NOT NULL AND wallet <> '';

-- Which wallet a payout was (or is being) sent to: the approved wallet printed on the invoice, else the primary.
ALTER TABLE payouts ADD COLUMN to_wallet TEXT;
