-- Payouts recorded without a real chain transaction (mock mode: no AGENT_PRIVATE_KEY / no Roles module).
ALTER TABLE payouts ADD COLUMN simulated INTEGER NOT NULL DEFAULT 0;
-- Effective gas price from the receipt, for the fee columns of the ledger and the remittance advice.
ALTER TABLE payouts ADD COLUMN effective_gas_price_wei TEXT;
