export const providerRetrySchema = `
ALTER TABLE tasks ADD COLUMN provider_retry_at INTEGER;
CREATE INDEX tasks_provider_retry ON tasks(provider_retry_at) WHERE state='waiting_provider';
`;
