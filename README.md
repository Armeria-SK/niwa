# Niwa（ニワ）

**それぞれの個性と記憶が育つ、Botたちの庭。**

個性や記憶を持つBotと会話し、調べものや文章づくりを進めるアプリです。Bot管理、共有／個別会話、仕事、記憶、予定、バックアップをブラウザーから操作できます。現在は試験提供中です。[実装状況と残件](docs/STATUS.md)を参照してください。

## 初回セットアップ

Ubuntu・Intel/AMD 64ビット・systemd・cgroup v2を使います。インターネット接続とsudo権限が必要です。共有作業場8 GiB＋実行領域16 GiBを予約するため、**少なくとも26 GiBの空き容量**を用意してください。新規環境向けの手順です。Windowsの既存データは取り込みません。

すでに `/home/niwa/niwa` に取得済みなら、下のセットアップコマンドから進めます。`niwa` でログイン済みならユーザー作成・切替も不要です。

まだ取得していない場合は、sudoを使える端末で次を実行します。

```sh
sudo apt-get update
sudo apt-get install -y git
# niwaユーザーが存在しない場合だけ実行
sudo adduser niwa
sudo -u niwa git clone https://github.com/Armeria-SK/niwa.git /home/niwa/niwa
```

セットアップは **この1コマンド**です。入力するのは通常、rootのパスワードではなく、sudoを実行したユーザーのパスワードです。

```sh
sudo sh /home/niwa/niwa/deploy/ubuntu/setup.sh
```

必要なOSパッケージ、Node.js 24、ビルド、専用ユーザー `niwa-exec`、保存容量の制限、固定Pythonイメージの取得と隔離試験、初期設定、サービス登録・自動起動設定・起動確認まで進みます。対応する `/usr/bin/node`（24.16以上の24系）があれば再導入しません。別バージョンが既にある場合は自動で置換せず停止します。Node未導入時は[NodeSource](https://github.com/nodesource/distributions)の配布手順を利用します。

`niwa` は本体・記憶・認証情報、`niwa-exec` は共有ファイルと隔離プログラム実行を担当します。既存の `niwa` を作り直しません。完了済みの準備は確認して引き継ぎます。既存領域・設定が想定と異なる場合や、途中のディスク準備が不完全な場合は停止し、既存データを削除して再作成しません。

最後に `PASS: Niwa services installed, enabled and responding` と表示されれば、起動確認まで完了です。端末は閉じて構いません。セットアップ自体の実機確認状況は[起動・運用資料](docs/ubuntu/SERVICES.md)に記載しています。

## 開く・ログインする

同じPCのブラウザーで **[http://127.0.0.1:3210](http://127.0.0.1:3210)** を開きます。

管理者キーは初回起動時に作られます。`niwa` の端末で以下を実行し、表示された文字列をログイン画面へ貼り付けてください。別ユーザーの端末では先頭に `sudo -u niwa` を付けます。

```sh
cat /home/niwa/niwa/secrets/admin-key
```

キーはNiwaを操作するパスワードです。チャットへ送ったり公開したりしないでください。セットアップはキーをログへ表示しません。

モデルの接続は画面で行います。「設定」→「モデルと接続」でChatGPTの接続、またはOllamaを設定し、リーダーと新しいBotのモデルを選びます。その後、リーダーへ話しかけてください。アカウントの認証はセットアップでは行いません。

## 日常の起動・停止

Ubuntu起動時にサービスが自動起動します。WSLでは、Ubuntu自体が起動している必要があります。PC全体やWSLの自動起動設定はこの手順では変更しません。

```sh
# 状態確認
sudo sh /home/niwa/niwa/deploy/ubuntu/services.sh status
# 全サービスを停止
sudo sh /home/niwa/niwa/deploy/ubuntu/services.sh stop
# 起動
sudo sh /home/niwa/niwa/deploy/ubuntu/services.sh start
# 再起動
sudo sh /home/niwa/niwa/deploy/ubuntu/services.sh restart
```

端末のCtrl+Cでサービスは停止しません。`node ...server.js` を別に起動すると二重起動になります。日常操作にセットアップの再実行や `--init` は不要です。上のstopは今回の稼働を停止する操作で、自動起動の登録は残ります。Botの活動停止状態は画面で管理します。

## ブラウザー・パッケージ機能を追加する

初回セットアップ後に追加する場合は、次を順に実行します。すでに有効化済みの環境で繰り返す必要はありません。

```sh
sudo sh /home/niwa/niwa/deploy/ubuntu/verify-extensions.sh --apply
sudo python3 /home/niwa/niwa/deploy/ubuntu/enable-extensions.py --apply
```

最初のコマンドで専用ブラウザーと人工パッケージの隔離・動作を検証し、次のコマンドで受入記録を確認して本体へ接続・再起動します。ブラウザーの通常フォームは内容ごとの承認が必要です。パッケージの管理カタログは空で開始し、管理者が検証したdebを追加して使います。任意のオンラインパッケージ取得は行いません。詳しくは[パッケージ運用](docs/ubuntu/PACKAGES.md)を参照してください。

保存・復元・サービス再起動を再検証する場合は `sudo sh /home/niwa/niwa/deploy/ubuntu/verify-continuity.sh --apply` を使います。復元試験は人工データの一時環境で行います。

## 困ったとき

| 状況 | 確認すること |
|---|---|
| セットアップが停止した | 最後の工程名とエラーを確認。既存ファイルを削除して拒否を解除しないでください。[準備工程](docs/ubuntu/SERVICES.md)を参照。 |
| `interactive authentication is required` | 自分のUbuntu端末でsudo付きセットアップコマンドを実行します。 |
| 画面が開かない | `services.sh status` と `sudo journalctl -u niwa.service -u niwa-workspace.service -n 80 --no-pager` を確認。 |
| プログラムが動かない | `services.sh status` でexecutorの状態を確認。[サービス資料](docs/ubuntu/SERVICES.md)にログの確認手順があります。 |
| Botが返事をしない | 画面のモデル接続・モデル選択・活動停止・承認待ちを確認。 |
| 管理者キーが分からない | 上のcatコマンドで再表示できます。 |

会話・記憶・設定は `/home/niwa/niwa/` に保存されます。このフォルダーを削除しないでください。バックアップは画面の設定で管理します。ブラウザー操作、追加パッケージ、X、スマートフォン接続は[追加準備と残件](docs/STATUS.md)を参照してください。

資料は[docs/](docs/README.md)、実行スクリプトとsystemd定義は `deploy/ubuntu/` に集約しています。現在docsはGit対象外のローカル資料です。cloneだけでは含まれませんが、上記のセットアップ・起動操作はこのREADMEだけで行えます。

## ライセンス

Niwaのライセンスの扱いは [LICENSES.md](LICENSES.md) に記載しています。ビルド成果物にも同梱します。Niwa本体のライセンス指定とは区別しています。
