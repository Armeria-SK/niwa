# Niwa

Botごとの人格と独立した記憶を持ち、会話・調査・制作を続けるブラウザアプリ。

**次のセッションは [引き継ぎ資料](docs/HANDOFF.md) から読んでください。**

2026-09-07時点で、保存・内部認可、モデル接続部品、親子タスク、スケジューラー、管理者HTTP APIと承認済みUIを接続しています。日常利用の5機能に加え、公開ページ取得、専用キー設定時のBrave検索、専用実行サービス経由の共有ファイル読み書き、出所付き検索・要約、文脈圧縮、残りの手順の保存と過去手順の再利用、ユーザー指定の定期実行API・管理画面を追加しました。117件のテスト・型チェック・Webを含むビルドが成功し、定期実行の保存・停止・再開をPC／モバイル幅のブラウザーで検証しました。実モデルでの調査完遂、実Brave検索、共有ファイルの管理画面、定期実行の通知・費用予算、自発起動とUbuntuでの隔離検証・配置は未完了です。詳細は [実装状況](docs/IMPLEMENTATION.md) を参照してください。

| 資料 | 用途 |
|---|---|
| [HANDOFF](docs/HANDOFF.md) | 現在地、確定したUI、再開手順、残作業 |
| [PLAN](PLAN.md) | 製品要件・ユーザーの決定事項 |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | 本番ディレクトリ・保存・実行境界の設計 |
| [CODE_REUSE](docs/CODE_REUSE.md) | 上流の固定コミット、移植・参考・除外範囲 |
| [プロトタイプ](prototype/README.md) | 実行方法、実装ファイルと制約 |

現在の `D:\niwa` は、本番では `/home/niwa/niwa/app/source/` に置くソースリポジトリです。製品ルート `/home/niwa/niwa/` には `app/`・`config/`・`state/`・`secrets/`・`workspace/`・`runtime/`・`backups/`・`logs/` を並べます。Linux本番への配置はまだ行っていません。

本体検証はルートで `npm ci` → `npm run check`。Node.js 24.16.0を使用します。
