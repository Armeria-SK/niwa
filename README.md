# Niwa（ニワ）

**それぞれの個性と記憶が育つ、Botたちの庭。**

Niwaは、個性の異なるAIの仲間と会話し、一緒に調べものや文章づくりを進めるアプリです。ブラウザーから使えます。Botごとにプロフィールや記憶を持ち、みんなで話す場所と、一対一で話す場所があります。

## できること

- Botを追加し、名前や性格、使うモデルを選ぶ
- リーダーや仲間に話しかけて、仕事を頼む
- 仕事の進み具合を確認し、一時停止・再開する
- Botの記憶を確認し、必要に応じて訂正する
- 決まった時間の活動や、バックアップの時刻を設定する

現在は試験提供中です。Botによるプログラム実行・ブラウザー操作・Xへの投稿は、まだ利用準備中です。

## 用意するもの

- Ubuntuが入ったIntel／AMDの64ビットPC（この手順はARM版には対応していません）
- Ubuntuの管理者パスワードと、インターネット接続
- 同じUbuntu PCで使えるブラウザー
- Codexを利用できるChatGPTアカウント（下の接続手順で使用します）

対応OSはUbuntuです。この手順では、まず自分のPCで会話できる状態にします。別のPCからのアクセスや、インターネットへの公開は含みません。

## 1. 必要なものを入れる

Ubuntuで「端末」を開き、以下を貼り付けてEnterを押してください。パスワード入力中は文字が表示されませんが、そのまま入力してEnterを押せます。

```bash
sudo apt-get update && sudo apt-get install -y git curl ca-certificates
```

このコマンドで入れるものは、次の3つです。

| 名前 | 用途 |
| --- | --- |
| git | GitHubからNiwaを取得します。 |
| curl | Node.jsの配布元を設定するファイルをダウンロードします。 |
| ca-certificates | HTTPS接続先の証明書を確認します。 |

## 2. Node.jsをインストールする

Node.jsはNiwaを動かすためのソフトです。PC全体で使える通常のインストールで構いません。必要なバージョンは **24.16.0以上の24系** です。すでに条件を満たすNode.jsとnpmが使える場合は、この手順を省略できます。

以下の枠を、上から1つずつ実行してください。エラーが出た場合は、次へ進まず表示を確認してください。

[NodeSourceの配布手順](https://github.com/nodesource/distributions)を使い、Node.js 24系の配布元を追加します。

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x -o nodesource_setup.sh
```

```bash
sudo -E bash nodesource_setup.sh
```

Node.jsとnpmをインストールします。

```bash
sudo apt-get install -y nodejs
```

バージョンを確認します。

```bash
node --version
```

```bash
npm --version
```

Node.jsが `v24.16.0` 以上の `v24.x.x`、npmもバージョン番号を表示すれば準備完了です。

## 3. Niwaをダウンロードする

Niwa用のユーザー `niwa` を作ります。途中で新しいパスワードを決めてください。氏名などの欄はEnterで空欄にできます。すでに同名のユーザーがある場合は作成を省略します。

```bash
sudo adduser niwa
```

Niwa用のユーザーに切り替えます。

```bash
sudo -iu niwa
```

**ここから手順6までは、この端末で続けてください。**

GitHubからNiwaを取得します。

```bash
git clone https://github.com/Armeria-SK/niwa.git /home/niwa/niwa
```

## 4. Niwaを使う準備をする

Niwaのフォルダーへ移動します。

```bash
cd /home/niwa/niwa
```

Niwaに必要な部品を入れます。数分かかることがあります。

```bash
npm ci
```

ブラウザーで使える形に準備します。

```bash
npm run build
```

エラーなく完了したら、次へ進んでください。

### Botのプログラム実行を準備する場合

Botが生成したプログラムを実行する機能には、Podmanと専用のLinuxユーザー `niwa-exec` が必要です。`niwa` は本体・会話・記憶・認証情報を管理し、`niwa-exec` は共有作業場と隔離実行を担当します。生成プログラムから本体のデータへアクセスさせないため、すでに `niwa` があっても別に作成します。

この準備は、**手順5の初回設定より前**に行います。会話だけを試す場合は省略できます。すでに初回設定済みの場合は、[Ubuntu実行サービスの準備](deploy/ubuntu/README.md)を確認してください。

まず、変更を行わない事前検査を実行します。

```bash
sh /home/niwa/niwa/deploy/ubuntu/prepare-executor.sh --check
```

検査が成功したら、sudoを使えるユーザーのUbuntu端末で次を実行します。Podmanなどの必要パッケージ、`niwa-exec`、連携用グループ `niwa-ipc`、ディレクトリの所有者・権限を準備します。

```bash
sudo sh /home/niwa/niwa/deploy/ubuntu/prepare-executor.sh --apply
```

sudoのパスワード入力が必要です。自動実行が `interactive authentication is required` で止まった場合も、自分の端末で上のコマンドを実行してください。パスワードをチャットへ送る必要はありません。

既存のruntime/workspaceや同名の専用ユーザー・グループがある場合は停止します。途中で失敗した場合も、既存ファイルを削除してやり直さず、状態を確認してください。

準備が完了したら、専用ユーザーの権限を検査し、ログアウト後も使える実行用セッションを準備します。

```bash
sudo sh /home/niwa/niwa/deploy/ubuntu/prepare-executor-session.sh --apply
```

この操作は `niwa-exec` のsystemdユーザー管理機能を起動し、rootless Podman・seccomp・cgroup・保存先を検査します。Niwa本体やコンテナは起動しません。

ここではNiwaのサービス登録・起動や実行イメージの取得は行いません。プログラム実行の有効化には、[追加の準備と隔離検証](deploy/ubuntu/README.md)および[サービス設定](deploy/ubuntu/SERVICES.md)が必要です。

## 5. 初回の設定を作る

以下は**最初の1回だけ**実行します。

```bash
node \
  /home/niwa/niwa/dist/entrypoints/server.js \
  --root /home/niwa/niwa --init --origin http://127.0.0.1:3210
```

`Installation configuration created.` と表示されれば完了です。

## 6. 起動する

```bash
node \
  /home/niwa/niwa/dist/entrypoints/server.js \
  --root /home/niwa/niwa
```

`Niwa is running.` と表示されたら起動しています。**この端末は開いたままにしてください。**

ブラウザーで [Niwaを開く](http://127.0.0.1:3210) を押します。アドレスを手入力する場合も `http://127.0.0.1:3210` を使ってください。

## 7. ログインする

Niwaへのログインには、初回起動時に作られる管理者キーを使います。

Ubuntuで**別の端末をもう1つ開き**、次を実行してください。

```bash
sudo -u niwa cat /home/niwa/niwa/secrets/admin-key
```

表示された長い文字列をコピーし、Niwaのログイン画面に貼り付けます。これはNiwaを操作するためのパスワードに相当するので、ほかの人に送ったり公開したりしないでください。

## 8. AIを接続して、話しかける

1. Niwaの「設定」→「モデルと接続」を開きます。
2. 「ChatGPTで接続（試験対応）」を押し、「ChatGPTのログインを開く」からログインします。Niwaを起動しているPCのブラウザーで進めてください。
3. Niwaへ戻り、「認証情報を保存済み」と表示されることを確認します。
4. 「リーダーのモデル」で「Codexのモデルを取得」を押し、一覧から使うモデルを選んで「モデルを保存」を押します。
5. 「新しいBotの標準モデル」も同じように選んで保存します。
6. リーダーとの会話を開き、「こんにちは。どんなことをお願いできますか？」と送ってみてください。

ChatGPTとの接続は試験対応です。利用できるモデルや上限は、接続したアカウントによって異なります。

## 終了・次回の起動

終了するときは、Niwaを起動した端末で **Ctrl+C** を押します。会話や設定は保存されます。

次回は、Ubuntuの端末で以下だけ実行すれば起動できます。初回設定を作り直す必要はありません。

```bash
sudo -u niwa node \
  /home/niwa/niwa/dist/entrypoints/server.js \
  --root /home/niwa/niwa
```

起動後は [Niwaを開く](http://127.0.0.1:3210) から使えます。PCを再起動した場合も、このコマンドで起動してください。

## 困ったとき

| 状況 | 確認すること |
| --- | --- |
| 画面が開かない | 起動用の端末が開いていて、`Niwa is running.` と表示されているか確認してください。 |
| 起動できない | すでに別の端末でNiwaが動いていないか確認してください。初回設定は手順5の1回だけです。 |
| 管理者キーが分からない | 手順7のコマンドでもう一度表示できます。 |
| Botが返事をしない | 「設定」→「モデルと接続」で接続状態と選んだモデルを確認してください。仕事が確認待ちになっている場合は、画面の案内を確認してください。 |
| ダウンロード中に止まった | インターネット接続と、端末のエラー表示を確認してください。すでに作成されたフォルダーを削除してやり直す前に、中に必要なデータがないか確認してください。 |

会話・記憶・設定などは `/home/niwa/niwa/` に保存されます。このフォルダーを削除すると、大切なデータも失われます。日々のバックアップは「設定」→「バックアップ」から設定できます。
