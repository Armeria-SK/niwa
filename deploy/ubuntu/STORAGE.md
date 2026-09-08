# 実行領域のディスク上限

初期上限はworkspace 8 GiB、PodmanのHOME・実行記録を含むexecutor領域16 GiBです。ファイルシステムの管理領域もこの容量に含むため、ファイルを保存できる量は少し小さくなります。製品ルート配下の `runtime/volumes` にroot所有・0600のイメージファイルを作り、容量を実際に確保します。

| ファイル | マウント先 | 上限 |
|---|---|---|
| runtime/volumes/workspace.img | workspace/ | 8 GiB |
| runtime/volumes/executor.img | runtime/executor/ | 16 GiB |

これはOS全体へのquota設定ではありません。Botが書く共有作業場とPodmanストレージを別のext4へ置き、ホスト全体を使い切れないようにします。Niwa本体のDB・ログ・バックアップはこの上限の対象外です。

## 初回準備

`prepare-executor-session.sh` が成功し、Niwa本体・workspaceサービスとコンテナをまだ起動していない段階で実行します。必要なのはUbuntuのPython3、e2fsprogs、util-linux、rsyncです。

```sh
sudo python3 /home/niwa/niwa/deploy/ubuntu/prepare-disks.py --apply
```

このコマンドは次を順番に行います。

1. 専用主体・所有権・容量・既存mount/unit・コンテナ・本体ロックを確認。少なくとも26 GiBの空きを要求します。
2. 8+16 GiBのイメージを確保し、ext4を作成。初期化後も容量の実割り当てが維持されていることを検査します。
3. 専用user managerを止め、専用主体のプロセスが残っていないことを確認します。
4. 元の2領域を新しいファイルシステムへコピーし、チェックサム・権限・ACL・拡張属性を照合します。コピー完了までは元の領域の権限を変更しません。
5. 元ディレクトリをroot所有・000にし、その上へコピー済みのファイルシステムをmountします。元ファイルは削除しません。mountがない場合に、上限のない元領域へ書き込むことを防ぎます。
6. systemdのmount unitと専用user managerの依存関係を登録し、mount完了後にuser managerを再起動します。Niwa本体やコンテナは起動しません。

`nosuid,nodev,nodiscard` を使用します。`/` 全体の共有マウント設定は変更しません。rootless Podmanの共有mount警告は、実コンテナのbind mount検証で評価します。

## 停止・失敗時

初回専用です。`runtime/volumes`、同名unit、既存コンテナ、本体のservice-lock.dbがある場合は停止します。停止済みコンテナや古いロックでも自動削除しません。途中失敗後はスクリプトを繰り返す前に、mount・コピー・サービス状態を確認してください。

コピー照合失敗の場合、元領域はそのまま残り、user managerは停止状態のままです。mount切替後の失敗でも元ファイルは下層に残っていますが、読み出し・復旧は管理者による個別作業が必要です。イメージや元ディレクトリを削除しないでください。元領域は切替時点の保存物であり、切替後の更新を含むバックアップではありません。

## 検証範囲

2026-09-08、`python3 tests/storage-preparation.test.py` の6件が成功。人工ディレクトリの実rsyncコピー/照合、コピー不一致・既存コンテナ/ロック・容量不足の拒否、元ファイル保持、切替順を確認しました。小さい実イメージでfallocate/mkfsと割り当て保持を検証。ext4のオフライン検査と生成mount unitのsystemd-analyze verifyも成功しました。

実loop mount・本番容量の確保・サービス再起動後の依存関係・ENOSPC（容量を使い切ったときの拒否）は未検証です。準備成功後、人工データ専用の場所で容量境界と実コンテナ動作を検証してからプログラム実行を有効化します。

2026-09-08: 実行時の未mount判定を修正。util-linuxのmountpointは未mountで32、mount済みで0、呼出し/権限/システムエラーで1を返します。実コマンドで3状態を検証し、32だけを許可します。初回の「Already mounted or inaccessible」での停止はvolumes作成前で、元データを変更していません。
