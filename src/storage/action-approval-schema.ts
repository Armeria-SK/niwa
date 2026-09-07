export const actionApprovalSchema = `
ALTER TABLE approval_requests ADD COLUMN action_hash TEXT;
ALTER TABLE approval_requests ADD COLUMN operation_id TEXT;
`;
