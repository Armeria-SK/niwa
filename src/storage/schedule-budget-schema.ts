export const scheduleBudgetSchema = `
ALTER TABLE schedules ADD COLUMN max_model_calls INTEGER NOT NULL DEFAULT 24 CHECK(max_model_calls > 0);
ALTER TABLE schedules ADD COLUMN model_calls INTEGER NOT NULL DEFAULT 0 CHECK(model_calls >= 0);
UPDATE schedules SET max_model_calls=max_runs*24;
`;
