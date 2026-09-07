export const modelSchema = `
ALTER TABLE agents ADD COLUMN provider TEXT NOT NULL DEFAULT 'openai_subscription'
  CHECK(provider IN ('openai_subscription','ollama'));
CREATE TABLE model_settings(id INTEGER PRIMARY KEY CHECK(id=1), ollama_url TEXT) STRICT;
INSERT INTO model_settings VALUES(1,NULL);
`;
