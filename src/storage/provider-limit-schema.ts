export const providerLimitSchema = `
CREATE TABLE provider_limits (
  account_key TEXT PRIMARY KEY,
  next_probe_at INTEGER NOT NULL,
  revision INTEGER NOT NULL
) STRICT;
`;
