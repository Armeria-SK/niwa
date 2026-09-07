# Niwa

Botごとの人格と独立した記憶を持ち、会話・調査・制作を続けるブラウザアプリ。

**次のセッションは [引き継ぎ資料](docs/HANDOFF.md) から読んでください。**

2026-09-07時点で、要件・技術設計と承認済みUI、本体の管理DB・個別記憶DB・内部認可基盤を実装済みです。型チェック・8件のテスト・ビルドが成功しています。実際のBot活動、認証、モデル接続、UI接続、Ubuntuへの配置は未実施です。詳細は [実装状況](docs/IMPLEMENTATION.md) を参照してください。

| 資料 | 用途 |
|---|---|
| [HANDOFF](docs/HANDOFF.md) | 現在地、確定したUI、再開手順、残作業 |
| [PLAN](PLAN.md) | 製品要件・ユーザーの決定事項 |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | 本番ディレクトリ・保存・実行境界の設計 |
| [CODE_REUSE](docs/CODE_REUSE.md) | 上流の固定コミット、移植・参考・除外範囲 |
| [プロトタイプ](prototype/README.md) | 実行方法、実装ファイルと制約 |

現在の作業場所は `D:\niwa`、予定する本番ルートは `/home/niwa/niwa/`。この二つを混同しないでください。

本体検証はルートで `npm ci` → `npm run check`。Node.js 24.16.0を使用します。
