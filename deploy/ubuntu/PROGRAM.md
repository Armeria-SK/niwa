# プログラム実行の初回受入

専用セッションと[ディスク上限](STORAGE.md)の準備後、初期の空workspaceで実行します。Niwa本体やworkspaceサービスは起動せず、実データや保存済みコンテナがある環境では実行しません。

```sh
sudo sh /home/niwa/niwa/deploy/ubuntu/prepare-program.sh --apply
```

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
