export const modelParallelSchema = `
ALTER TABLE model_settings ADD COLUMN max_parallel INTEGER NOT NULL DEFAULT 1 CHECK(max_parallel BETWEEN 1 AND 8);
`;
