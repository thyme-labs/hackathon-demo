-- Multi-tenant: every business row belongs to a tenant (lower-case owner address for wallet sessions,
-- 'anon:<id>' for demo sessions). Rows written before this migration belong to the founder tenant: the
-- owner address the production onboarding stored (settings.ownerAddress), else the known founder wallet.
CREATE TEMP TABLE _founder AS
  SELECT lower(COALESCE(
    (SELECT value FROM settings WHERE key = 'ownerAddress' AND value IS NOT NULL AND value <> ''),
    (SELECT value FROM settings WHERE key = 'safeOwner' AND value IS NOT NULL AND value <> ''),
    '0x38bd0c38786a20f2890675e8c4622813b8b3bf16'
  )) AS tenant_id;

ALTER TABLE beneficiaries ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE payouts ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE audit_log ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';

UPDATE beneficiaries SET tenant_id = (SELECT tenant_id FROM _founder) WHERE tenant_id = '';
UPDATE invoices SET tenant_id = (SELECT tenant_id FROM _founder) WHERE tenant_id = '';
UPDATE payouts SET tenant_id = (SELECT tenant_id FROM _founder) WHERE tenant_id = '';
UPDATE audit_log SET tenant_id = (SELECT tenant_id FROM _founder) WHERE tenant_id = '';

CREATE INDEX IF NOT EXISTS idx_beneficiaries_tenant ON beneficiaries (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices (tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_payouts_tenant ON payouts (tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log (tenant_id, id);

-- settings: primary key becomes (tenant_id, key). Process-wide secrets live under tenant '_global'.
CREATE TABLE settings_v2 (
  tenant_id TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT,
  PRIMARY KEY (tenant_id, key)
);
INSERT INTO settings_v2 (tenant_id, key, value) SELECT (SELECT tenant_id FROM _founder), key, value FROM settings;
INSERT OR REPLACE INTO settings_v2 (tenant_id, key, value) VALUES ('_global', 'founderTenant', (SELECT tenant_id FROM _founder));
DROP TABLE settings;
ALTER TABLE settings_v2 RENAME TO settings;

-- agents: the two agent rows exist per tenant; primary key becomes (tenant_id, id).
CREATE TABLE agents_v2 (
  tenant_id   TEXT NOT NULL,
  id          TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('compliance', 'payment')),
  status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused')),
  config_json TEXT,
  last_run_at TEXT,
  PRIMARY KEY (tenant_id, id)
);
INSERT INTO agents_v2 (tenant_id, id, name, kind, status, config_json, last_run_at)
  SELECT (SELECT tenant_id FROM _founder), id, name, kind, status, config_json, last_run_at FROM agents;
DROP TABLE agents;
ALTER TABLE agents_v2 RENAME TO agents;

DROP TABLE _founder;
