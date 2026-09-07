# 共有Xアカウントの接続

実Xアカウント・開発者App・契約の作成は管理者の判断で行う。Niwaの実装・人工試験では、認証や投稿を実行していない。
APIの権限・利用料金は接続する契約に従う。アカウントはNiwa全体で1つを共有する。

1. [XのOAuth 2.0設定](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)で、Niwa用のAppとcallbackを準備する。callbackはNiwaの公開originに `/api/x/callback` を付けたもの。PKCE/S256と `tweet.read tweet.write users.read offline.access` を使う。Automated App等のconfidential clientではclient secretも必要。
2. 接続するアカウントの数値IDを `config/niwa.json` の `xAccountId` に設定する。認証後の [GET /2/users/me](https://docs.x.com/x-api/users/get-my-user) と一致しなければ保存しない。
3. `secrets/x-client.json` をNiwaのサービス所有・600で作成し、`client_id` と、必要なら `client_secret` をJSONの文字列フィールドとして保存する。シェルの引数・ログ・会話へ秘密値を載せない。既存ブラウザーのCookieや他アプリの資格情報は使わない。
4. Niwaを再起動し、設定 → モデルと接続 → 共有Xアカウントの「Xで接続」「Xで許可する」から管理者が認証する。接続完了後に設定へ戻る。認証情報は `secrets/x.json` に保存する。

接続後は共有会話のBotが `x_post` で公開投稿・返信できる。毎回の承認は要求しない。`x_read` と `x_mentions` で投稿や共有アカウント宛ての発言を参照できる。一般ブラウザー・生成プログラムへXのtokenを渡さない。
私的情報の意図しない公開を避けるため、個別会話では投稿ツールを公開せず、直接の呼出しも拒否する。
初期接続はテキスト投稿・返信・参照。DM、media upload、広告、アカウント作成、課金操作、quote投稿は実装していない。
[投稿API](https://docs.x.com/x-api/posts/create-post)の長さ・権限・レート等の検査にも従い、APIの拒否を投稿成功として扱わない。

`runtime/x-posts.db` は本文やtokenを持たず、要求hash・実行ID・確認できた投稿IDを記録する。同一内容の成功済み投稿を重複送信せず、投稿順を一元化する。
送信後の切断や不明な応答は確認待ちにし、再起動・仕事の再開・別Botの同じ投稿要求でも自動再送しない。管理者はX上の実投稿を確認し、必要なら仕事を手動で完了する。
認証情報とこの実行journalは通常バックアップの対象外。復元後は再接続が必要で、失われたjournalを成功と推定して過去の送信を再実行しない。
client設定ファイルがない場合、Niwa本体は起動しX接続だけを無効にする。ファイルを準備して再起動してから認証する。
認証更新に失敗した場合は設定から再接続する。設定の「認証情報を保存済み」はAPIの現在の権限・契約・稼働状態の保証ではない。

人工検証: PKCE/stateの一回消費、scope不足/別アカウント拒否、更新の一本化、切断競合、管理APIの認証/Origin、共有会話の制約、SQLiteの重複抑止と不明結果の非再送。実アカウント・実契約・実投稿での通し確認は未実施。
