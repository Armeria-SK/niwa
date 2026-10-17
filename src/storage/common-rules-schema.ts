import { currentDefault, quote } from './common-rules-default-schema.ts';
export const commonRulesSchema = `
CREATE TABLE common_rules (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,body TEXT NOT NULL) STRICT;
INSERT INTO common_rules VALUES (1,1,${quote(currentDefault)});
`;
