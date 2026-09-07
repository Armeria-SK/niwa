export const generatedModelSchema = `
CREATE TABLE generated_model (id INTEGER PRIMARY KEY CHECK(id=1),provider TEXT NOT NULL,model TEXT NOT NULL,reasoning TEXT NOT NULL) STRICT;
INSERT INTO generated_model VALUES(1,'openai_subscription','gpt-5.6-luna','max');
`;
