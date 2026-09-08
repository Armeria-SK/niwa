# プログラム実行の初回受入

専用セッションと[ディスク上限](STORAGE.md)の準備後、初期の空workspaceで実行します。Niwa本体やworkspaceサービスは起動せず、実データや保存済みコンテナがある環境では実行しません。

```sh
sudo sh /home/niwa/niwa/deploy/ubuntu/prepare-program.sh --apply
```

起動前に `prepare-container-access.py` が `/etc/subuid` の専用ユーザー割当を確認し、`keep-id` の名前空間rootに対応するUIDへ、`/home/niwa` と製品ルートの通過専用ACLを設定します。既存のACLマスク・所有者・配下の権限は保持します。単一の十分な割当範囲を要求し、重複割当や想定外の所有者・リンクは拒否します。

一度のsudo認証で、専用user manager内の委譲付き一時サービスから次を行います。

1. workspace/executorが指定容量以下の独立mountで、Podmanがrootless/local・seccomp・cgroup v2を使うことを確認します。
2. executor領域の人工ファイルで、容量を超える割り当てがENOSPCになることを確認します。人工ファイルは削除します。
3. [program-image.json](program-image.json)で固定した公式Pythonイメージを取得。manifest digest・Linux/amd64・ローカルimage IDを照合します。取得先は専用Podmanストレージ、一時ファイルも容量制限のある専用HOME内です。ホストへのパッケージ導入は行いません。
4. 空の人工workspaceを一時作成し、非root実行・共有書込・ホストの私的ファイル/リンクへの到達拒否・OS読取専用・外部通信拒否・cgroup設定を検証します。
5. workspaceのENOSPC、PID数上限、512 MiB上限による1 GiB割り当てのOOM終了、非ゼロ終了、出力上限、期限、中断を確認します。
6. 成功時だけ `runtime/executor/state/program-acceptance.json` に検証済みimage IDと日時を保存します。人工ファイルを片付け、イメージは次の実行に備えて保持します。

イメージは2026-09-08にDocker公式registryの `python:3.13-slim-bookworm` から解決したlinux/amd64 manifestを固定しています。コンテナ内はDebian bookwormです。将来のoffline package catalogはこのOS/architectureに合う.debを準備してください。Ubuntuホスト用パッケージをそのまま混ぜません。

この処理は本体のexecutor UID設定やNiwaサービスの登録・起動を行いません。初回受入の成功後に、検証済みimage IDを使ってサービス設定を進めます。失敗時は出力を確認し、残存コンテナを無条件で削除して再実行しないでください。以前の成功記録があっても、今回の失敗を成功扱いにはしません。

2026-09-08、スクリプト構文検査と `python3 tests/program-probes.test.py` の3件が成功。実tmpfs上のENOSPCと人工ファイル回収、user namespace内のRLIMIT_NPROCによるPID上限時の子プロセス回収、seccomp/NoNewPrivsの文字列検査を確認しました。実Podmanの受入はまだ実行していません。PIDの補助テストは、コンテナのcgroupによるPID制御の代替ではありません。

### crunの起動時にmergedのPermission deniedが出る場合

`--userns=keep-id` では、起動処理中の名前空間rootがホストのniwa-execとは別のsubordinate UIDに対応します。niwa-execだけの親ディレクトリACLでは、crunが保存領域を開く段階で拒否されます（[upstreamの同種報告](https://github.com/containers/crun/issues/1777)）。この準備手順は該当UIDだけに通過権限を付けます。`chmod o+x` や再帰的な所有権変更は不要です。

2026-09-08の実行ではイメージ取得・executor領域のENOSPC確認が成功し、最初のコンテナ起動で上記エラーになりました。人工の二重user namespaceで失敗を再現し、ACL適用後の到達成功、親一覧・私的領域の拒否を検証済み。実環境のACLも適用済みですが、実コンテナ受入は同じprepare-programコマンドで再実行が必要です。

2026-09-08、ACL修正後の実再試験は `status=0/SUCCESS`。上記の隔離・共有書込・executor/workspaceのENOSPC・PID上限・OOM・非ゼロ終了・出力上限・期限・中断がすべてPASSしました。実行UID1001、メモリ512 MiB・swap 0・PID64・CPU1の設定も確認。成功記録の保存まで完了しています。継続サービスとOS再起動の受入は別途必要です。
