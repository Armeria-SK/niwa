# 隔離環境へのパッケージ導入

実装済みの専用経路。実Ubuntu/Podmanでの導入試験は未実施です。以下は配置準備であり、ホストへのOS導入やアカウント作成の許可を意味しません。

管理者は、既存のプログラム用イメージ（Ubuntu、apt-getとdpkg-queryを含む）の正確なimage IDを指定します。実行サービスへ `--packages /home/niwa/niwa/runtime/executor/environments/catalog` を追加し、本体の `config/niwa.json` へ `packagesEnabled: true` を設定します。`programExecutorUid` の設定も必要です。

catalogディレクトリはniwa-exec所有・0700とし、Botのworkspaceから独立させます。管理者が配布元と依存関係を確認した `.deb` と `catalog.json` を置きます。ファイルは同じ所有者・通常ファイル・リンクなし・他者書込不可とします。JSONは次の構造の配列です（hashは実ファイルのSHA-256へ置換）。

```json
[
  { "name": "hello", "version": "2.10-1", "file": "hello.deb", "sha256": "実ファイルの64桁のSHA-256" }
]
```

一覧は名前と版だけをBotへ返します。Botは `packages_list` で確認し、`packages_install` へ許可済みの名前を渡します。必要な依存パッケージもcatalogへ用意し、一緒に指定します。ネットワーク取得は行わず、依存不足は失敗として返します。catalogの変更は実行サービス再起動後に読み込みます。

導入は専用rootlessコンテナのrootで固定apt-get引数を使い、パッケージのコピーだけを読取専用で渡します。workspace・秘密・ソケットはmountしません。通信なし、CPU・メモリ・PID・実行時間制限と標準seccompを維持します。成功後にイメージをcommitし、別の読取専用コンテナで要求した版とinstalled状態を照合します。[Podman commitの仕様](https://docs.podman.io/en/latest/markdown/podman-commit.1.html)に従い、mountした内容はイメージへ含めません。

実行サービスのprivate stateに `packages.db` を保存し、採用image ID・明示導入した名前/版・操作結果を保持します。これは依存パッケージを含む全OSのインベントリではありません。同時要求は順番に処理し、成功した次のプログラム実行から新imageを使用します。既に実行中のプログラムは元imageで続きます。起動時は採用imageの存在を検査します。

不明結果は自動再実行せず確認待ちにします。再起動時は未完了記録から導入・検証コンテナと専用stageを回収します。結果保存前の失敗では新imageを採用しませんが、commit済みの未採用imageがPodmanストレージに残ることがあります。管理者は利用中imageを確認した上で整理してください。通常backupにexecutor journal/imageは含めず、復元後に結果不明な操作を推測で再実行しません。別base imageへの移行は新しい専用stateで行います。

人工SQLite・IPC・Podman応答で、digest改変、未知名、私的会話の拒否、導入失敗、版不一致、中断、逐次反映、再起動後の結果再利用、不明結果非再送を検証済みです。実環境では導入成功後のprogram_run、依存不足、外部通信拒否、停止と再起動回収、権限・cgroup・seccompを確認してから有効化します。
