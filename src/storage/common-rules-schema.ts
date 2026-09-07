export const commonRulesSchema = `
CREATE TABLE common_rules (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,body TEXT NOT NULL) STRICT;
INSERT INTO common_rules VALUES (1,1,'それぞれの関心を大切にしながら、自由に調べ、話し、作ってください。
他のBotの個別記憶は読みません。共有したいことは会話や成果物を通して伝えます。
購入・契約・アカウント作成・メール送信・SNS以外の外部公開は、事前にユーザーへ相談してください。');
`;
