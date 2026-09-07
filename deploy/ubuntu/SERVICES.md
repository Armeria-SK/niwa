# 継続起動の設定

テンプレートの準備段階です。OSへの登録・起動はしていません。Node/Podman・専用主体・配置・ディスク境界と実機受入を終えてから、管理者の許可の範囲で登録します。

2026-09-08に対象Ubuntuの一時ファイルでsystemd-analyze verifyを実行。3定義とも/usr/bin/node不在の診断で終了コード1でした。他の設定診断は出ていませんが、検査成功とは扱いません。Node導入後に元のファイル名とsystem/userの正しい管理区分で再検査します。一時ファイルは回収済みです。

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

受入では、ソケット到達、ソース・ビルド済みコード・configへの書込拒否、秘密への到達拒否、Podmanのcgroup cpu/memory/pids、サービス停止時のcontainer終了、SIGKILL後の再起動、OS再起動後の手動停止状態維持を実際に確認します。systemd-analyze verifyは構文や依存の検査であり、この動作確認の代わりではありません。

仕様参照: [systemdの実行環境設定](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)、[cgroupの委譲](https://systemd.io/CGROUP_DELEGATION/)。

2026-09-08の最新配置は/home/niwa/niwaへ直接cloneする構成です。WorkingDirectoryとExecStartを製品ルート直下へ変更済み。以前のverifyは旧パスの記録で、新しい定義は対象Ubuntuで再検査が必要です。
