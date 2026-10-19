-- Payouts recorded without a real chain transaction (simulated mode: Thyme not configured or onboarding simulated).
ALTER TABLE payouts ADD COLUMN simulated INTEGER NOT NULL DEFAULT 0;
-- Effective gas price from the receipt, for the fee columns of the ledger and the remittance advice.
ALTER TABLE payouts ADD COLUMN effective_gas_price_wei TEXT;
