# 専用ブラウザーの導入と検証

この手順は未実行。ホストへのPodman導入・専用主体の作成・image取得は管理者の許可後に行う。
既存のexecutorと同じ保護ディレクトリ・実行主体を使用し、一般ブラウザーのprofileやXの資格情報を渡さない。

1. アプリをビルドし、Node 24.16.0以上25未満を含む公式Debian系Node imageのdigestを確認する。
2. `Containerfile.browser` の `NIWA_BROWSER_BASE` に、そのdigest付き参照を指定してimageを構築する。例の形式は `docker.io/library/node@sha256:…`。タグだけを記録せず、構築後のimage IDも記録する。構築時のapt通信は管理者による環境準備で、Botへ渡す通信権限ではない。
3. executorの起動引数に `--browser-image sha256:…` を追加する。指定済みローカルimage以外は実行時に取得しない。既存の `--image` はプログラム実行用のまま。
4. 実コンテナで以下の確認を終えてから、`config/niwa.json` の `browserExecutorUid` に専用executorのUIDを設定しNiwaを再起動する。保護された `runtime/sockets/browser.sock` を使う。

確認する項目:

- Chromiumが非root・既定sandboxのまま起動できる。失敗時に `--no-sandbox` で回避しない。
- コンテナにホストのmount・認証情報・管理socket・共有workspaceがない。
- OSのnetwork namespaceに外部経路がなく、直接HTTP/WebSocket/worker/iframeからホストや外部へ通信できない。
- 親の公開取得だけで人工ページを表示でき、POST/未知XHR・Fetch・別documentの要求は外部へ到達しない。
- Botと会話の組合せが違うと同じpage・Cookie・参照を使えない。
- 取得の中断・サービス停止でcontainerが終了する。強制停止の残存containerにも900秒の上限がある。
- 本体のnavigate/snapshot/followとform_prepareから結果を取得でき、再起動後の失効参照には再navigateが必要と分かる。

現状は公開ページのnavigate/snapshot/followに対応する。主文書の最大100要素・20k文字を返す。
通常フォームの準備と、承認後の専用経路による送信は [FORMS.md](FORMS.md) を参照。一般のbutton click・download・iframe/shadow DOM操作、認証が必要なページは未対応。
取得は操作ごとに64要求/8MB、単一resource256KB。大きなページや未知の通信を使うサイトでは表示が欠ける場合がある。
セッションはBot・会話別で最大16、同時処理6、非使用5分で終了する。資格情報は保存しない。
Windows上の実Chromeと人工IPCの検証は、UbuntuのOS隔離確認を代替しない。

2026-09-08、UbuntuでChrome for Testing 152.0.7977.82を `.local/chrome-testing` に配置し、実ブラウザーの2件を含む全222テストが成功（失敗0・skip0）。sandboxを無効化せず、人工ページと専用pipeの動作を確認しました。これはホスト上の試験で、実Podmanコンテナの隔離受入ではありません。

この検証環境の再実行:

```sh
NIWA_TEST_CHROMIUM=/home/niwa/niwa/.local/chrome-testing/run-chrome npm run check
```

`run-chrome` は検証専用のローカル起動スクリプトで、同じ `.local` に展開したNSS/NSPR/ALSAライブラリを指定します。生成物はGit除外で、別環境にcloneした場合は自動では用意されません。製品workerの環境変数制限は変更していません。ログは `.local/ubuntu-check-chrome.log` に保存しています。
