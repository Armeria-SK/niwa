# 継続起動の設定

テンプレートの準備段階です。OSへの登録・起動はしていません。Node/Podman・専用主体・配置・ディスク境界と実機受入を終えてから、管理者の許可の範囲で登録します。

2026-09-08、Node.js 24.20.0導入後、直接clone構成の3定義を以下のコマンドで再検査し、両方とも終了コード0を確認しました（サンドボックス外）。以前のNode不在による失敗は解消しました。登録・起動・実際の専用主体での権限やcgroup検証は未実施です。

```sh
systemd-analyze verify deploy/ubuntu/systemd/niwa.service deploy/ubuntu/systemd/niwa-workspace.service
systemd-analyze --user verify deploy/ubuntu/systemd/niwa-executor.service
```

| 定義 | 管理するsystemd | 実行主体 | 用途 |
|---|---|---|---|
| systemd/niwa.service | system | niwa | 管理画面・モデル接続・保存 |
| systemd/niwa-workspace.service | system | niwa-exec | 共有ファイルだけの読書き |
| systemd/niwa-executor.service | niwa-execのuser manager | niwa-exec | rootless Podman・専用ブラウザー・パッケージ |

本体とファイルサービスはOS領域・ソース・ビルド済みコード・configを読取専用にし、必要な保存先だけ書込可能にします。ファイルサービスには外部ネットワークを渡しません。アプリ・Bot生成コードを同じ実行主体で動かしません。

実行サービスはrootless Podmanがuser managerとcgroupを利用できる形にします。ユーザー名niwa-execのHOMEはprepare-executor.shが指定するruntime/executor/home、XDG_RUNTIME_DIRはuser managerの `%t` です。UIDを1001等に決め打ちしません。ユーザーサービスへ単にProtectSystemを追加して隔離済みとは扱わず、ホストの所有権とコンテナ境界を検証します。newuidmap/newgidmapが必要なため、executor親にNoNewPrivilegesを設定しません。生成プログラム側のコンテナには既存の昇格禁止を維持します。

配置時の条件:

- 製品ルートの通過権限と、ビルド済みdist・node_modulesへの読取/通過権限だけをniwa-execへ与える。state/secrets/backupsや製品全体へ再帰的に権限を付けない。
- niwaのstate/config/secrets/backups/logs、niwa-execのworkspace・state・HOME・保護socketディレクトリを事前に作る。サービスは初期化用ではない。
- config/executor.envは管理者が用意し、executor.env.exampleのimage IDを実在するローカルIDへ置換する。niwa-execにはそのファイルの読取とconfigディレクトリの通過だけを許可する。認証情報は入れない。
- program/browser imageとcatalogの準備は管理者作業。TMPDIRも製品内のprivate作業先を明示し、イメージ取得時の一時ファイルを既定の/var/tmpへ散らさない。
- workspaceとPodmanストレージにディスク使用境界を設ける。サービスのCPUやメモリ設定は代替にならない。

登録時はsystemの2ファイルを/etc/systemd/systemへ、executorのuser unitをniwa-execのHOME内.config/systemd/userへ置きます。ログアウト後とOS起動後にもuser managerを動かすには、管理者がniwa-execのlingerを有効化します。これはOSの登録操作であり、まだ実行していません。

実際の起動はexecutor、workspace、本体の順に行い、停止は逆順にします。本体のAfter指定は同時起動時のworkspaceとの順序を指定するもので、別user managerのexecutor起動を保証するものではありません。各socketを確認し、本体の対応UID設定を有効化してから利用します。

`prepare-executor.sh` の実行と本体ビルド後、次のコマンドで所有権・IPCグループ・専用ユーザーのアクセス権を検査し、lingerとuser managerを準備できます。

```sh
sudo sh /home/niwa/niwa/deploy/ubuntu/prepare-executor-session.sh --apply
```

既存の所有権やアクセス権が想定と違えば、変更前に停止します。通過後は `loginctl enable-linger niwa-exec` と `systemctl start user@<確認したUID>.service` を実行します。専用user manager内の一時サービスへcgroupを委譲し、製品と同じ `validatePodmanInfo` でrootless・seccomp・CPU/memory/pids制御・private保存先を確認します。Podmanの初期メタデータが専用HOME/runtimeへ作られる場合があります。イメージ取得やコンテナ起動は行いません。

2026-09-08、ACL判定修正後にユーザー端末で実行成功。専用主体のアクセス検査と、rootless/local・seccomp・cgroup v2のcpu/memory/pids・private保存先の検査がPASS。linger有効、user manager起動も確認しました。実イメージ・コンテナ隔離の受入は未実施です。次は[ディスク上限の準備](STORAGE.md)を行います。

受入では、ソケット到達、ソース・ビルド済みコード・configへの書込拒否、秘密への到達拒否、Podmanのcgroup cpu/memory/pids、サービス停止時のcontainer終了、SIGKILL後の再起動、OS再起動後の手動停止状態維持を実際に確認します。systemd-analyze verifyは構文や依存の検査であり、この動作確認の代わりではありません。

仕様参照: [systemdの実行環境設定](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)、[cgroupの委譲](https://systemd.io/CGROUP_DELEGATION/)。

2026-09-08の最新配置は/home/niwa/niwaへ直接cloneする構成です。WorkingDirectoryとExecStartを製品ルート直下へ変更済み。直接clone用定義のverify結果は本書冒頭を参照してください。

2026-09-08のACL判定修正: 対象Ubuntuの外部 `test`（uutils 0.8.0）では、名前付きユーザーACLを無視してother権限から読取可と判定するケースを人工ディレクトリで再現しました。専用主体のアクセス判定を `/bin/sh` の組込み `test` に統一し、権限設定は変更していません。`Executor can list private parent` で停止した場合、この修正版で同じコマンドを再実行します。停止はlinger変更より前です。`python3 tests/executor-session.test.py` は実ACLのread/write/search判定を含む6件成功（skip0）。

## 実コンテナ検証後の設定案（2026-09-08）

固定Pythonイメージの実コンテナ受入が成功しました（[検証結果](PROGRAM.md)）。3定義のsystemd-analyze verifyも再度終了0。Niwaサービスの登録・起動は未実施です。

このホストの設定案を `.local/service-preview/` に準備済みです。`config/niwa.json` は現在のorigin/portを保ち、実UIDからworkspaceExecutorUid/programExecutorUidを追加します。`executor.env` は取得済みローカルimage IDを指定します。適用時はprivateなprogram-acceptance.jsonのimage/referenceとPodmanの実imageを再照合してください。configへのniwa-exec通過ACLとexecutor.envだけの読取権限も必要です。browser/packagesは別受入後に設定します。

本体の初回起動前に、新規環境かWindows実データの移行かを確定します。サービス登録・起動の承認後、executor→workspace→本体の順でsocket接続と実動作を確認します。設定案の生成・構文検査だけでは継続起動や復旧を検証したことにはなりません。
