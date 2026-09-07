# Ubuntu実行サービスの準備

基本のWeb画面、会話、Bot管理、記憶、モデル接続、仕事のスケジューラーはWindowsのNode.jsでも動く。
隔離プログラム実行と専用ファイルサービスはLinuxの別実行主体・Unixソケットを必要とする。
Windowsでこれらを使う場合はWSL2のUbuntu内でサービスを動かす。npmだけでOS隔離を提供するものではない。

## 現在の確認範囲

2026-09-07、WSL登録名Ubuntu-22.04で診断スクリプトを実行した。実OSはUbuntu 26.04.1（登録名からOS版を推定しない）。
Linux・非rootユーザーniwa・cgroup v2の存在・Windowsドライブの未マウントを確認。
Node.js、Podman、専用ユーザーniwa-execは未導入。
本番配置やユーザー作成はまだ実施していない。
製品ルート `/home/niwa/niwa/` は空ディレクトリとして存在することを確認した。
当時のパッケージ候補はPodman 5.7.0、Node.js 22系。Node.jsはユーザー指定に従い、ルートREADMEのNodeSource手順で24.16.0以上25未満をシステムへ導入する。

```sh
sh deploy/ubuntu/check-prerequisites.sh
```

この診断は読み取りだけを行い、不足があると終了コード1を返す。
診断の成功はコンテナによる隔離の実証ではない。

## 管理者が確認して実行する準備

`prepare-executor.sh` は `/home/niwa/niwa` に直接cloneした、初回設定前の環境用です。専用主体が未作成のx86_64環境を前提とします。ソースやビルド結果を保持し、旧配置のappディレクトリは作りません。
ルートと親ホームがniwa所有で、グループ・その他の書込権限がなく、パスがシンボリックリンクでないことを確認します。既存のruntime/workspace（空ディレクトリやリンクを含む）があれば停止します。稼働済み環境や途中失敗からの再実行は、データ・所有権を個別に確認してください。拒否を解除するために既存データを削除しないでください。
システムの `/usr/bin/node` が24.16.0以上25未満であることを変更前に検査する。Node本体のダウンロード・製品内配置は行わない。
Podman・uidmap・fuse-overlayfs・ACLを導入し、niwa-execとniwa-ipcを作成する。
必要なディレクトリごとに所有者・モードを設定し、niwa-execには `/home/niwa` の通過権限だけを追加する。
サービス登録・起動、モデル認証、実行イメージ取得、Windowsドライブのマウント変更は行わない。

まず変更を行わない検査を実行します。Nodeが未導入の場合も停止します。

```sh
sh deploy/ubuntu/prepare-executor.sh --check
```

検査後、管理者がOS変更を許可した場合に限り `sudo sh deploy/ubuntu/prepare-executor.sh --apply` で準備します。`--apply` でも変更前の検査を繰り返します。本体の `--init` より先に実行してください。

既存インストールや同名実行主体がある場合は停止する。途中失敗後に無条件で再実行せず、作成済みの状態を確認する。
2026-09-08、修正後の `sh -n` と `python3 tests/prepare-executor.test.py` の11件が成功しました。テストは人工checkoutとOS操作の代替コマンドで、既存ファイルの保持、変更なし検査、拒否条件、変更対象を確認します。実Ubuntuの `--check` は `/usr/bin/node` 不在で停止。実導入・実ACL・隔離の成立は未検証です。

## 配置前に用意するもの

- Node.js 24.16以降の24系と、rootless Podman・seccomp・cgroup v2のCPU／memory／pids制御。
- アプリのniwaとは別のniwa-exec主体。管理DB・secrets・backupsへアクセスさせない。
- 製品ルート `/home/niwa/niwa/` 内の共有workspaceと、別の私的な実行state・HOME。
- 両サービスだけが使うソケット用グループとディレクトリ。executorが所有し、その他のユーザーへ公開しない。
- 管理者が用意した実行イメージのローカルsha256 ID。実行時にpullしない。
- 共有workspaceのディスク使用上限。CPU／メモリ制限だけではホストのディスク枯渇を防げない。

起動入口は `node dist/entrypoints/executor.js`。
必須オプションは `--workspace`、`--socket`、`--state`、`--home`、`--runtime`、`--image`。
前五つは明示した絶対パス、imageは導入済みの `sha256:...` を指定する。
runtimeは専用ユーザーのOS一時実行領域、socketは製品ルートの `runtime/sockets/program.sock` を使用する。
ソケットと実行state・HOMEをworkspace内に置かない。

起動時にPodmanのrootless・ローカル接続・seccomp・cgroup制御、ストレージ位置、イメージ存在を確認する。
不合格ならソケットを開かない。未完了の保存済みコンテナを回収しても、仕事を再実行しない。
本体側は `config/niwa.json` の `programExecutorUid` を設定した場合だけツールを公開する。
実機検証を完了するまではこの設定を追加しない。

追加機能の準備と検証範囲は [ブラウザー](BROWSER.md)、[承認付き通常フォーム](FORMS.md)、[パッケージ導入](PACKAGES.md)、[共有X接続](X.md) を参照。

継続起動のsystemd定義は [SERVICES.md](SERVICES.md) を参照。テンプレートは準備済みですが、登録・起動と実機受入は未実施です。

## 有効化前の実機確認

`verify-program.mjs` は、実際のPodmanで実行する検証スクリプト。明示した `--apply` が必要。
専用のniwa-execユーザーと導入済みのPythonイメージを使い、本体を起動せずに確認する。
workspaceには、niwa-execが読み書きできる**空の検証専用ディレクトリ**を渡す。
実際のBotファイルがあるディレクトリは使わない。空でなければ検証を拒否する。
home・runtimeはexecutorと同じ私的なディレクトリを指定し、workspaceの外へ置く。
ビルド済みのソースディレクトリで、niwa-execとして次を実行する（各変数は管理者が確認した絶対パス／ローカルイメージID）。

```sh
"$NODE" deploy/ubuntu/verify-program.mjs --apply \
  --workspace "$VERIFY_WORKSPACE" --home "$EXECUTOR_HOME" \
  --runtime "$EXECUTOR_RUNTIME" --image "$PYTHON_IMAGE_ID"
```

共有ファイルの書き込み・私的ファイルとリンク先への到達拒否・読取専用OS・外部通信拒否・
cgroup設定値・seccomp／権限昇格禁止・非ゼロ終了・出力上限・時間切れ・中断を検査する。
作成した人工ファイルは終了時に削除する。PASSはこれらの確認範囲に限る。
メモリ／プロセスの実負荷試験、ディスク使用上限、サービス再起動時の回収は別途必要。
スクリプトの構文検査のみ実施済みで、実Podmanでの実行は未実施。

人工データだけの専用作業場で、正常終了・非ゼロ終了・停止・期限・出力上限を確認する。
管理データ／ホストファイルへの到達、外部通信、fork／メモリ／ディスク制限、シンボリックリンクと同時編集も確認する。
実行中にサービスを終了した後、回収と結果不明状態を確認し、再起動で処理を重複させない。
本体と実行記録を別世代に復元した場合の運用は未確立なので、自動復帰させない。

仕様参照: [Podman info](https://docs.podman.io/en/latest/markdown/podman-info.1.html)、[Podman run](https://docs.podman.io/en/latest/markdown/podman-run.1.html)。
