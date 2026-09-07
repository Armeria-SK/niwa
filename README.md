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
sudo apt-get update && sudo apt-get install -y git curl ca-certificates xz-utils
```

続いて、Niwa用のユーザー `niwa` を作ります。途中で新しいパスワードを決めてください。氏名などの欄はEnterで空欄にできます。すでに同名のユーザーがある場合は作成を省略します。

```bash
id niwa >/dev/null 2>&1 || sudo adduser niwa
```

次のコマンドでNiwa用のユーザーに切り替えます。

```bash
sudo -iu niwa
```

**ここから手順4までは、この端末で続けてください。**

## 2. Niwaをダウンロードする

下の枠をまとめてコピーして実行してください。Niwaを動かすNode.jsも一緒に用意します。数分かかることがあります。

```bash
(
  set -eu
  test "$(id -un)" = niwa
  test "$(uname -m)" = x86_64
  mkdir -p /home/niwa/niwa/app/runtime
  download_dir=$(mktemp -d)
  trap 'rm -rf -- "$download_dir"' EXIT
  cd "$download_dir"
  curl --fail --location --proto '=https' --tlsv1.2 \
    -o node.tar.xz https://nodejs.org/download/release/v24.16.0/node-v24.16.0-linux-x64.tar.xz
  echo 'd804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9  node.tar.xz' | sha256sum -c -
  tar -xJf node.tar.xz -C /home/niwa/niwa/app/runtime
  export PATH="/home/niwa/niwa/app/runtime/node-v24.16.0-linux-x64/bin:$PATH"
  git clone https://github.com/Armeria-SK/niwa.git /home/niwa/niwa/app/source
  cd /home/niwa/niwa/app/source
  npm ci
  npm run build
  printf '\nNiwaのダウンロードと準備が完了しました。\n'
)
```

最後に「Niwaのダウンロードと準備が完了しました。」と表示されれば次へ進めます。途中でエラーが出た場合は、その表示を確認してから進めてください。

Node.jsは[公式配布元](https://nodejs.org/download/release/v24.16.0/)から取得し、ダウンロードした内容を照合しています。

## 3. 初回の設定を作る

以下は**最初の1回だけ**実行します。

```bash
/home/niwa/niwa/app/runtime/node-v24.16.0-linux-x64/bin/node \
  /home/niwa/niwa/app/source/dist/entrypoints/server.js \
  --root /home/niwa/niwa --init --origin http://127.0.0.1:3210
```

`Installation configuration created.` と表示されれば完了です。

## 4. 起動する

```bash
/home/niwa/niwa/app/runtime/node-v24.16.0-linux-x64/bin/node \
  /home/niwa/niwa/app/source/dist/entrypoints/server.js \
  --root /home/niwa/niwa
```

`Niwa is running.` と表示されたら起動しています。**この端末は開いたままにしてください。**

ブラウザーで [Niwaを開く](http://127.0.0.1:3210) を押します。アドレスを手入力する場合も `http://127.0.0.1:3210` を使ってください。

## 5. ログインする

Niwaへのログインには、初回起動時に作られる管理者キーを使います。

Ubuntuで**別の端末をもう1つ開き**、次を実行してください。

```bash
sudo -u niwa cat /home/niwa/niwa/secrets/admin-key
```

表示された長い文字列をコピーし、Niwaのログイン画面に貼り付けます。これはNiwaを操作するためのパスワードに相当するので、ほかの人に送ったり公開したりしないでください。

## 6. AIを接続して、話しかける

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
sudo -u niwa /home/niwa/niwa/app/runtime/node-v24.16.0-linux-x64/bin/node \
  /home/niwa/niwa/app/source/dist/entrypoints/server.js \
  --root /home/niwa/niwa
```

起動後は [Niwaを開く](http://127.0.0.1:3210) から使えます。PCを再起動した場合も、このコマンドで起動してください。

## 困ったとき

| 状況 | 確認すること |
| --- | --- |
| 画面が開かない | 起動用の端末が開いていて、`Niwa is running.` と表示されているか確認してください。 |
| 起動できない | すでに別の端末でNiwaが動いていないか確認してください。初回設定は手順3の1回だけです。 |
| 管理者キーが分からない | 手順5のコマンドでもう一度表示できます。 |
| Botが返事をしない | 「設定」→「モデルと接続」で接続状態と選んだモデルを確認してください。仕事が確認待ちになっている場合は、画面の案内を確認してください。 |
| ダウンロード中に止まった | インターネット接続と、端末のエラー表示を確認してください。すでに作成されたフォルダーを削除してやり直す前に、中に必要なデータがないか確認してください。 |

会話・記憶・設定などは `/home/niwa/niwa/` に保存されます。このフォルダーを削除すると、大切なデータも失われます。日々のバックアップは「設定」→「バックアップ」から設定できます。
