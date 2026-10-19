/** サーバーが日本語で作る文言の言い換え。exact は文そのもの、patterns は [正規表現, 置き換え（文字列か関数）] の並び。 */
// 3つの言語のファイル（en・ko・zh-CN）は、同じ文を同じ順に並べる。

// patterns の中で、文の一部（取得に失敗した理由・作業場の規則など）を言い換える表。
const FETCH_FAILURES = {
  'ページが見つかりません': 'page not found',
  'アクセスを断られました': 'access was refused',
  '相手のサーバーがエラーを返しました': 'the site’s server returned an error',
  '対応していない形式か、大きすぎます': 'unsupported format, or too large',
  '本文がありません': 'no body text',
  '公開されていない宛先です': 'not a public address',
  'URLが正しくありません': 'the URL isn’t valid',
  '時間内に応答がありませんでした': 'no response in time',
  '接続できませんでした': 'couldn’t connect',
};
const WORKSPACE_RULES = {
  'ファイルとフォルダの合計は1000個までです。不要なものを削除してください': 'Up to 1,000 files and folders in total. Delete what isn’t needed.',
  '別のマウントにまたがるエントリは戻せません': 'Entries that span another mount can’t be copied back.',
  'シンボリックリンクは戻せません。削除するか実体にしてください(例: npm install --no-bin-links、python -m venv --copies)': 'Symbolic links can’t be copied back. Delete them or replace them with real files (e.g. npm install --no-bin-links, python -m venv --copies).',
  '通常ファイルとフォルダ以外(FIFOやソケット等)は戻せません。削除してください': 'Only regular files and folders can be copied back (not FIFOs, sockets, etc.). Delete the others.',
  'ハードリンクされたファイルは戻せません。コピーして実体にしてください': 'Hard-linked files can’t be copied back. Copy them into real files.',
  '1ファイルは8MiBまでです。小さくするか削除してください': 'Each file can be up to 8 MiB. Make it smaller or delete it.',
  '合計は64MiBまでです。不要なファイルや依存物を削除してください': 'The total can be up to 64 MiB. Delete unneeded files or dependencies.',
  '読取り中にファイルが変化しました。実行後に何も残さないようにしてください': 'A file changed while it was being read. Make sure nothing is left running afterward.',
};
// MCPのログインを始められなかったときの文（後ろに（理由のコード）が付く）。
const OAUTH_START = {
  'この接続先は、クライアントの自動登録に対応していません。提供元の開発者向け画面で発行したクライアントIDを入力してください。': 'This service doesn’t support automatic client registration. Enter a client ID issued on the provider’s developer page.',
  'この接続先はPKCE（S256）に対応していないため、ログインできません。': 'This service doesn’t support PKCE (S256), so you can’t log in.',
  'この接続先のログイン用アドレスがHTTPSではないため、ログインできません。': 'This service’s login address isn’t HTTPS, so you can’t log in.',
  'この接続先のログイン情報が一致しないため、ログインできません。': 'This service’s login details don’t match, so you can’t log in.',
  'ログインを開始できませんでした。接続先のURLと、OAuthへの対応を確認してください。': 'Couldn’t start logging in. Check the service’s URL and that it supports OAuth.',
};
// 継続する取り組みを見直す理由（「・」でつながることがある）。
const REVIEW_REASONS = {
  '見直し時刻': 'review time',
  '子タスクと結果': 'subtasks and results',
  '成果物の改訂': 'output revisions',
  '関連する発言': 'related messages',
  '待ち条件の変化': 'changes in what it waits for',
};
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const either = table => Object.keys(table).map(escape).join('|');
const capital = text => text.charAt(0).toUpperCase() + text.slice(1);
const count = (n, one, many) => `${n} ${Number(n) === 1 ? one : many}`;
const reasons = text => capital(text.split('・').map(reason => REVIEW_REASONS[reason] ?? reason).join(', '));

// 記憶の食い違いで比べた値（第2・14時・土曜・3人など。同じ種類の値が「・」でつながることがある）。
const FACT = String.raw`(?:第\d+(?:[.:]\d+)?|[月火水木金土日]曜|\d+(?:[.:]\d+)?[時日月年回人冊件分円個つ曜週%])`;
const WEEKDAYS = { 月: 'Mon', 火: 'Tue', 水: 'Wed', 木: 'Thu', 金: 'Fri', 土: 'Sat', 日: 'Sun' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ordinal = n => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] ?? 'th'}`;
const UNITS = {
  時: v => v.includes(':') ? v : `${v}:00`, 日: v => `day ${v}`, 月: v => MONTHS[Number(v) - 1] ?? `month ${v}`, 年: v => `year ${v}`,
  回: v => count(v, 'time', 'times'), 人: v => count(v, 'person', 'people'), 冊: v => count(v, 'copy', 'copies'), 件: v => count(v, 'item', 'items'),
  分: v => `${v} min`, 円: v => `¥${v}`, 個: v => count(v, 'piece', 'pieces'), つ: v => v, 曜: v => `weekday ${v}`, 週: v => count(v, 'week', 'weeks'), '%': v => `${v}%`,
};
const fact = item => {
  const nth = item.match(/^第(.+)$/), weekday = item.match(/^([月火水木金土日])曜$/), unit = item.match(/^(\d+(?:[.:]\d+)?)(.)$/);
  if (nth) return /^\d+$/.test(nth[1]) ? ordinal(Number(nth[1])) : `No. ${nth[1]}`;
  if (weekday) return WEEKDAYS[weekday[1]];
  return unit && UNITS[unit[2]] ? UNITS[unit[2]](unit[1]) : item;
};
const facts = text => text.split('・').map(fact).join(', ');

const exact = {
  // 仕事の進み具合（tasks[].progress.label など）
  '作業中': 'Working…',
  '停止中': 'Paused',
  '順番待ち': 'Waiting in line',
  '仲間の結果待ち': 'Waiting for another Bot’s result',
  '理由未確認の待機': 'Waiting (reason unknown)',
  '対応待ち（理由未確認）': 'Waiting for action (reason unknown)',
  '管理者の入力待ち': 'Waiting for your input',
  '仲間の対応待ち': 'Waiting for another Bot',
  '承認の判断待ち': 'Awaiting your approval',
  '応答形式の確認待ち': 'Waiting to check the reply format',
  '自発活動の利用枠待ち': 'Waiting for the self-directed activity quota',
  '予定の利用枠待ち': 'Waiting for the scheduled run quota',
  '接続の再試行待ち': 'Waiting to retry the connection',
  '接続の確認待ち': 'Waiting to check the connection',
  '認証の確認待ち': 'Waiting for a sign-in check',
  'モデル設定の確認待ち': 'Waiting for a model settings check',
  '接続先の利用枠待ち': 'Waiting for the connection’s quota',
  '進展がないため再確認待ち': 'No progress; waiting to check again',
  '完了': 'Done',
  '失敗': 'Failed',
  '中止': 'Canceled',
  '状態を確認中': 'Checking status…',
  '接続を準備中': 'Preparing the connection…',
  '返答を考え中': 'Thinking of a reply…',
  '調査方法と確認結果を整理中': 'Sorting out methods and findings…',
  '確認できた範囲をまとめ中': 'Summarizing what was confirmed…',
  '記憶を整理中': 'Organizing memories…',
  '結果を整理中': 'Organizing results…',
  '資料を確認中': 'Reading sources…',
  'コードを実行中': 'Running code…',
  '操作中': 'Using a tool…',
  '返答済み': 'Replied',

  // 仕事が待っている理由（tasks[].wait_reason）
  '会話の継続が16回の区切りに達しました。続ける場合は仕事の詳細から再開してください。': 'This conversation reached its limit of 16 continuations. To keep going, resume it from the task details.',
  'この仕事の実行区切りに達しました。続行する場合は、新しい依頼として必要な範囲を指定してください。': 'This task reached its run limit. To continue, send a new request that says what still needs doing.',
  '隔離実行の結果待ち': 'Waiting for the isolated run’s result',
  '自発活動の時間枠の利用量に達したため休息中です。時間枠が戻ると自動で続けます。': 'Resting: the self-directed activity allowance for this time window is used up. It continues automatically when the window resets.',
  '定期実行のモデル呼び出し上限に達しました。': 'This scheduled run reached its limit of model calls.',
  '復元後の外部操作は元の実行記録を確認する必要があります。この仕事から未記録の操作は開始できません。': 'After a restore, outside actions must be checked against the original run records. This task can’t start actions that weren’t recorded.',
  '外部処理の実行結果を確認できません。再開時に実行サービスの記録を照合します。': 'Couldn’t confirm the result of the outside process. It will be checked against the run service’s records when this resumes.',
  '同じ資料の巡回から回復を試みましたが、進展を確認できませんでした。再確認予定まで待機します。': 'Tried to stop going around the same sources, but saw no progress. Waiting until the scheduled check.',
  '自発活動には休息を選べるツール対応モデルが必要です。': 'Acting on their own needs a model that supports tools, so it can choose to rest.',
  'モデルの文脈容量が不正です。': 'The model’s context size is invalid.',
  'モデルの文脈容量が不明で、入力サイズの確認が必要です。': 'The model’s context size is unknown, so the input size needs checking.',
  '依頼・作業状態・直近の交換を保持すると、入力の概算がモデルの文脈容量に収まりません。': 'Keeping the request, the work state, and the latest exchanges, the estimated input doesn’t fit in the model’s context.',
  '文脈の再構成またはモデル接続の再作成を完了できませんでした。': 'Couldn’t finish rebuilding the context or reconnecting to the model.',
  'モデルが引継ぎ整理の形式を返せませんでした。表示された再確認予定まで待機します。': 'The model couldn’t return the handover summary in the right format. Waiting until the check time shown.',
  'モデルの応答が最後まで完了していません。': 'The model’s reply didn’t finish.',
  '実行処理でエラーが発生しました。確認後に再開してください。': 'An error occurred while running. Check it, then resume.',
  '実行が中断されました。確認後に再開してください。': 'The run was interrupted. Check it, then resume.',

  // 承認の題（approvals[].title、待っている理由にもなる）
  'ページのJSON通信': 'JSON request from a web page',
  'Webフォームの送信': 'Submit a web form',

  // 仕事の結果と、サーバーが会話に置く文
  '今回は休息しました。': 'Rested this time.',
  '受領済み（返信不要）': 'Received (no reply needed)',
  '管理者が完了にしました': 'You marked this done',
  '依頼を受け取りました。作業を進めます。': 'Got your request. I’ll get to work.',

  // サーバーが英語で残す仕事の結果（取り消し・期限切れ）
  'Cancelled': 'Canceled.',
  'Task deadline exceeded': 'Ended because the deadline passed.',

  // できごと（updates の title・detail）
  '定期実行の予算を確認してください': 'Check the scheduled run’s budget',
  '会話の宛先を確認してください': 'Check who the message is for',
  '宛先のBotがこの会話に参加できないため、配送できませんでした。': 'The Bot it was addressed to can’t join this conversation, so it wasn’t delivered.',

  // 予定（schedules[].wait_reason・check_status）
  '起動回数の上限に達しました。': 'Reached the maximum number of runs.',
  '3回続けて完了しなかったため、定期実行を停止しました。': 'Stopped the scheduled run because it didn’t finish 3 times in a row.',
  'バックアップから復元した予定です。実行済みの履歴と次回日時を確認してから再開してください。': 'This schedule was restored from a backup. Check its run history and next run time before resuming it.',
  '変更はありません': 'No changes',
  '最初の内容を記録しました。次の確認から変更を比べます': 'Saved the first version. Changes will be compared from the next check',
  '新しい項目はありません': 'No new items',
  '内容の変更を見つけました': 'Found a change in the content',
  '通知を受け付けました': 'Notification received',

  // 自発活動の状態（/api/autonomy の reason）
  '全体停止中': 'Everything is paused',
  '自発活動オフ': 'Acting on their own is off',
  'このBotの自発活動オフ': 'Acting on its own is off for this Bot',
  '休眠中': 'Dormant',
  'モデルの接続がありません': 'No model connection',
  '利用できる共有会話がありません': 'No shared conversation available',
  '前回の活動を継続・待機中': 'Continuing or waiting on the last activity',
  '既存の仕事を優先': 'Current tasks come first',
  '起動判定の準備中': 'Getting ready to decide when to start',
  '保留した仕事とは別の活動を判定': 'Looking for activity apart from the held task',
  '進展がないため方法の見直し待ち': 'No progress; waiting to rethink the approach',
  '失敗後の待機': 'Waiting after a failure',
  '休息中': 'Resting',
  '活動完了後の間隔': 'Break after finishing an activity',
  '予定なしの起動機会を待機中': 'Waiting for an unscheduled chance to start',
  '予定なしの定期判定から起動': 'Started from the regular unscheduled check',
  '起動に失敗したため待機中': 'Waiting because starting failed',

  // 夜の計画（/api/night の gate・plan.never）
  '夜の計画の下見待ち': 'Waiting for you to preview tonight’s plan',
  '今夜は休む日': 'Tonight is a night off',
  '今夜の利用枠に達しました': 'Tonight’s allowance is used up',
  '支払い・購入・契約': 'Payments, purchases, and contracts',
  '外部への公開・送信（フォームやメール）': 'Publishing or sending anything outside (forms or email)',
  'あなたの許可が要る操作（朝まで承認待ちで止まります）': 'Anything that needs your permission (it waits for your approval until morning)',

  // 継続する取り組み（/api/initiatives の review_reason・waits[].reason）
  '見直し時刻': 'Review time',
  '子タスクと結果': 'Subtasks and results',
  '成果物の改訂': 'Output revisions',
  '関連する発言': 'Related messages',
  '待ち条件の変化': 'Changes in what it waits for',
  '操作の承認': 'Approval of an action',
  '子タスクの結果': 'Subtask results',
  'モデル接続・利用枠': 'Model connection or quota',
  '質問への回答': 'Answer to a question',
  '仕事の見直し': 'Task review',

  // サーバーが付ける名前・題
  '自発活動': 'Self-directed activity',
  '削除したBot': 'Deleted Bot',
  'あなた': 'You',
  '個人作業': 'Personal work',

  // サーバーが作る成果物の説明と中身
  '作業ファイルから共有した固定版': 'Fixed copy shared from a work file',
  'ファイルの固定版。ダウンロードで取得できます。': 'Fixed copy of the file. Download it to get it.',
  '対象ファイルの固定版': 'Fixed copy of the target files',

  // 会話の分担（coordination の digest.operation_note）
  '送信の実行記録です。記録済みでも業務の成功を意味しません。導入以前の未分類の操作は含みません。': 'These are records of sends. A recorded send doesn’t mean the work succeeded. Unclassified actions from before this was added aren’t included.',

  // 記憶の食い違い（conflicts[].differences）
  '片方だけ「まだ」「ない」などの言い方': 'Only one says “not yet,” “no,” or similar',

  // 聞き比べ・点検（failure.message、checks[].note）
  'モデルの応答が最後まで届きませんでした。': 'The model’s reply didn’t arrive in full.',
  'モデルの呼び出しを完了できませんでした。': 'Couldn’t finish calling the model.',
  'モデルが文章を返しませんでした。': 'The model didn’t return any text.',
  'モデルの答えを、条件ごとの判断として読めませんでした。': 'Couldn’t read the model’s answer as a judgment for each condition.',
  'モデルの答えに、この条件への判断がありませんでした。': 'The model’s answer had no judgment for this condition.',

  // モデルの接続：Claude（Anthropic API）
  'Claude（Anthropic API）がAPIキーを受け付けませんでした。「設定」→「モデルと接続」でキーを確認してください。': 'Claude (Anthropic API) didn’t accept the API key. Check the key in Settings → Models & connections.',
  'このAPIキーの組織では選択したモデルや機能を利用できません。Claude Consoleで組織の権限を確認してください。': 'This API key’s organization can’t use the selected model or feature. Check the organization’s permissions in Claude Console.',
  'Claude（Anthropic API）で選択したモデルが見つかりません。モデル一覧を取得し直して選んでください。': 'The selected model wasn’t found on Claude (Anthropic API). Reload the model list and choose again.',
  'Claude（Anthropic API）が要求を受け付けませんでした。モデルの選択と会話の長さを確認してください。': 'Claude (Anthropic API) didn’t accept the request. Check the selected model and the conversation length.',
  'Claude（Anthropic API）のクレジットまたは利用枠が不足しています。Claude Consoleの請求設定を確認してください。': 'Claude (Anthropic API) is out of credits or quota. Check billing in Claude Console.',
  'Claude（Anthropic API）の利用制限に達しました。時間をおいて再確認します。': 'Claude (Anthropic API) hit its rate limit. Niwa will check again after a while.',
  'Claude（Anthropic API）が一時的に混み合っているか応答できません。時間をおいて再確認します。': 'Claude (Anthropic API) is busy or not responding right now. Niwa will check again after a while.',
  'Claude（Anthropic API）の応答が時間内に完了しませんでした。': 'Claude (Anthropic API) didn’t finish responding in time.',
  'Claude（Anthropic API）へ接続できませんでした。ネットワークを確認してください。': 'Couldn’t connect to Claude (Anthropic API). Check the network.',
  'Claude（Anthropic API）の応答を読み取れませんでした。': 'Couldn’t read the response from Claude (Anthropic API).',
  'Claude（Anthropic API）への要求を中断しました。': 'Stopped the request to Claude (Anthropic API).',
  'Claude（Anthropic API）のモデルではこの設定を使えません。': 'This setting can’t be used with this Claude (Anthropic API) model.',
  '会話や指示にAPIキーと同じ文字列が含まれているため、Claude（Anthropic API）へ送信しませんでした。': 'Not sent to Claude (Anthropic API) because the conversation or instructions contain the same text as the API key.',
  'Claudeが安全上の理由でこの依頼への応答を控えました（切替先のモデルでも応答できませんでした）。依頼の内容を見直してください。': 'Claude declined to answer this request for safety reasons (the fallback model couldn’t answer either). Review what the request asks for.',
  'Claude（Anthropic API）の応答が出力の上限で途中まで止まったため、ツール操作を実行しませんでした。依頼を小さく分けてください。': 'The response from Claude (Anthropic API) stopped partway at the output limit, so no tool actions were run. Split the request into smaller parts.',
  'Claude（Anthropic API）のモデルが扱える文脈の長さを超えました。会話を短くしてください。': 'This is longer than the context the Claude (Anthropic API) model can handle. Shorten the conversation.',
  'Claude（Anthropic API）のAPIキーを「設定」→「モデルと接続」で保存してください。': 'Save your Claude (Anthropic API) key in Settings → Models & connections.',

  // モデルの接続：OpenAI互換API
  'OpenAI互換APIがAPIキーを受け付けませんでした。「設定」→「モデルと接続」でキーを確認してください。': 'The OpenAI-compatible API didn’t accept the API key. Check the key in Settings → Models & connections.',
  'このAPIキーでは選択したモデルを利用できません。接続先の管理画面で権限とモデルを確認してください。': 'This API key can’t use the selected model. Check the permissions and models on the service’s admin page.',
  'OpenAI互換APIの接続先URLまたはモデルが見つかりません。URL（例: https://api.openai.com/v1）とモデルIDを確認してください。': 'The OpenAI-compatible API’s URL or model wasn’t found. Check the URL (e.g. https://api.openai.com/v1) and the model ID.',
  'OpenAI互換APIが要求を受け付けませんでした。モデルがツール呼び出し（tools）に対応しているか確認してください。': 'The OpenAI-compatible API didn’t accept the request. Check that the model supports tool calls (tools).',
  'OpenAI互換APIの残高または利用枠が不足しています。接続先の請求設定を確認してください。': 'The OpenAI-compatible API is out of balance or quota. Check the service’s billing settings.',
  'OpenAI互換APIの利用制限に達しました。時間をおいて再確認します。': 'The OpenAI-compatible API hit its rate limit. Niwa will check again after a while.',
  'OpenAI互換APIの接続先が一時的に応答できません。時間をおいて再確認します。': 'The OpenAI-compatible API isn’t responding right now. Niwa will check again after a while.',
  'OpenAI互換APIの応答が時間内に完了しませんでした。': 'The OpenAI-compatible API didn’t finish responding in time.',
  'OpenAI互換APIへ接続できませんでした。URLとネットワークを確認してください。': 'Couldn’t connect to the OpenAI-compatible API. Check the URL and the network.',
  'OpenAI互換APIの応答を読み取れませんでした。': 'Couldn’t read the response from the OpenAI-compatible API.',
  'OpenAI互換APIへの要求を中断しました。': 'Stopped the request to the OpenAI-compatible API.',
  'OpenAI互換APIのモデルではこの設定を使えません。': 'This setting can’t be used with this OpenAI-compatible API model.',
  '会話や指示にAPIキーと同じ文字列が含まれているため、OpenAI互換APIへ送信しませんでした。': 'Not sent to the OpenAI-compatible API because the conversation or instructions contain the same text as the API key.',
  'OpenAI互換APIの接続先URLを設定してください。': 'Set the URL for the OpenAI-compatible API.',
  '接続先URLを保存してください。': 'Save the connection URL.',

  // モデルの接続：共通
  'モデル接続のログインが必要です。': 'You need to sign in to the model connection.',
  'モデル接続のアカウント情報を確認してください。': 'Check the model connection’s account details.',
  '接続先の利用枠回復を待っています。': 'Waiting for the connection’s quota to recover.',
  '認証情報の保存先を確認してください。': 'Check where sign-in details are stored.',
  'モデル能力の確認に失敗しました。': 'Couldn’t check what the model can do.',
  'モデル接続の設定または準備処理を確認してください。': 'Check the model connection’s settings or setup.',

  // ChatGPTのサブスクリプションの接続（/api/subscription の error）
  '認証情報の保存領域を利用できませんでした。Niwaのファイル権限を確認してください。': 'Couldn’t use the storage for sign-in details. Check Niwa’s file permissions.',
  '認証の戻り先を開けませんでした。同じPCで別の認証処理が動いていないか確認してください。': 'Couldn’t open the sign-in return address. Check that no other sign-in is running on the same PC.',
  '認証結果の受信が時間切れになりました。Niwaを動かしているPCから、もう一度接続してください。': 'Timed out waiting for the sign-in result. Connect again from the PC running Niwa.',
  '認証結果が現在の接続操作と一致しません。古い認証タブを閉じ、もう一度接続してください。': 'The sign-in result doesn’t match the current connection attempt. Close any old sign-in tabs and connect again.',
  '認証結果を受け取れませんでした。もう一度接続してください。': 'Couldn’t receive the sign-in result. Connect again.',
  'Niwaから認証サーバーへ接続できませんでした。Niwaの通信許可とネットワーク接続を確認してください。': 'Niwa couldn’t reach the sign-in server. Check Niwa’s network permissions and your connection.',
  '認証情報の交換が時間切れになりました。通信を確認し、もう一度接続してください。': 'Exchanging sign-in details timed out. Check the connection and connect again.',
  '認証サーバーが認証情報の交換を受け付けませんでした。もう一度接続してください。': 'The sign-in server refused to exchange sign-in details. Connect again.',
  '認証サーバーの応答を確認できませんでした。もう一度接続してください。': 'Couldn’t verify the sign-in server’s response. Connect again.',
  '認証を完了できませんでした。もう一度接続してください。': 'Couldn’t finish signing in. Connect again.',

  // MCP接続（/api/mcp の error・message）
  '接続できませんでした。サービスの起動、ソケットのパスと権限（URLの場合はURLと認証トークン）、対応する会話範囲・ツールを確認してください。': 'Couldn’t connect. Check that the service is running, the socket path and permissions (for a URL: the URL and access token), and the conversations and tools it covers.',
  'MCP設定を保存できませんでした。Niwaの保存先の書き込み権限と空き容量を確認してください。': 'Couldn’t save the MCP settings. Check write permission and free space where Niwa saves its data.',
  'ログインが必要な接続があります。各接続の「ログイン」からログインしてください。': 'Some connections need you to log in. Use the “Log in” button on each one.',
  'ログインが必要です。「ログイン」からログインしてください。': 'You need to log in. Use the “Log in” button.',
  '保存済みの認証トークンを読み込めません。secretsフォルダーの mcp-token-* の権限と内容を確認してください。': 'Can’t read the saved access tokens. Check the permissions and contents of mcp-token-* in the secrets folder.',

  // バックアップ（/api/backups の error）
  '確認できないバックアップがあります。該当する保存物は削除せず、新しいバックアップの保存を続けます。': 'Some backups can’t be verified. They won’t be deleted, and new backups will keep being saved.',
  'バックアップを保存できませんでした。保存先と空き容量を確認してください。': 'Couldn’t save the backup. Check the save location and free space.',
};
const part = text => exact[text] ?? text;

export default {
  exact,
  patterns: [
    // 仕事の待っている理由：モデルの接続や応答が終わらなかった（tasks.ts の providerFailure。古い記録には後ろの文が無い）
    [/^(モデル接続の準備を完了できませんでした|モデル応答を完了できませんでした) \(([A-Z_]+)\)。(再確認予定まで待機します。|接続設定の確認後、同じ仕事を再開してください。)?$/,
      (what, code, next) => `${what === 'モデル接続の準備を完了できませんでした' ? 'Couldn’t finish preparing the model connection' : 'The model’s reply didn’t finish'} (${code}).${
        next === undefined ? '' : next === '再確認予定まで待機します。' ? ' Waiting until the scheduled check.' : ' Check the connection settings, then resume this task.'}`],
    // 承認の題：外部ツールの書き込み（turn-tools.ts）
    [/^外部ツールの書き込み：(.+)$/, name => `Write with an outside tool: ${name}`],
    // 承認したあと仕事に渡る文（tasks[].replies）
    [/^管理者が次の内容を承認しました：([^\n]*)\n([\s\S]*)$/, (title, detail) => `You approved this: ${part(title)}\n${detail}`],
    // できごと：定期実行を止めた（題の後ろは依頼の文）
    [/^定期実行を停止：([\s\S]*)$/, prompt => `Scheduled run stopped: ${prompt}`],
    // 予定：ページの見張り・通知の受け付け（check_status）
    [/^新しい項目を(\d+)件見つけました$/, n => `Found ${count(n, 'new item', 'new items')}`],
    [/^通知を受け付けました（次の仕事に(\d+)件まとめて渡します）$/, n => `Notification received (the next task will get all ${n} together)`],
    [/^取得失敗：(.+)（(\d+)回連続）$/, (reason, n) => `Couldn’t fetch: ${FETCH_FAILURES[reason] ?? reason} (${Number(n) === 1 ? 'once' : `${n} times in a row`})`],
    // 自発活動：継続する取り組みから起動した理由と、見直す理由
    [/^継続する取り組み：(.+)$/, why => `Ongoing initiative: ${reasons(why)}`],
    [new RegExp(`^((?:${either(REVIEW_REASONS)})(?:・(?:${either(REVIEW_REASONS)}))+)$`), joined => reasons(joined)],
    // Botの読み込み：できる会話の題と、最初の発言
    [/^ファイルから迎えた(.+)の手順と記憶$/, name => `Procedures and memories from ${name}’s file`],
    [/^ファイルから(.+)を迎えました。\nこのあとの発言は、ファイルにあった手順(\d+)件と記憶(\d+)件です。\n「手順：」で始まる発言が手順で、ほかは記憶です。\n(.+)は、それぞれの発言を出所として覚えます。$/,
      (name, procedures, memories) => `Added ${name} from a file.\nThe messages that follow are the ${count(procedures, 'procedure', 'procedures')} and ${count(memories, 'memory', 'memories')} from the file.\nMessages that start with “手順：” are procedures; the rest are memories.\n${name} keeps each message as the source of what it remembers.`],
    // モデルの接続
    [/^モデル一覧の確認に失敗しました \(([A-Z_]+)\)。$/, code => `Couldn’t check the model list (${code}).`],
    // MCP接続：理由つきの文
    [/^接続できませんでした。サービスの起動、ソケットのパスと権限（URLの場合はURLと認証トークン）、対応する会話範囲・ツールを確認してください。（([\s\S]+)）$/,
      reason => `${exact['接続できませんでした。サービスの起動、ソケットのパスと権限（URLの場合はURLと認証トークン）、対応する会話範囲・ツールを確認してください。']} (${reason})`],
    [/^設定ファイルを読み込めません（(.+)）。直前の正常な状態を表示しています。ファイルを修正してから読み直してください。$/,
      reason => `Can’t read the settings file (${reason}). Showing the last good state. Fix the file, then reload.`],
    [/^保存済みの認証トークンを読み込めません（(.+)）。secretsフォルダーの mcp-token-\* の権限と内容を確認するか、トークンを入力し直してください。$/,
      ids => `Can’t read the saved access tokens (${ids}). Check the permissions and contents of mcp-token-* in the secrets folder, or enter the tokens again.`],
    [new RegExp(`^(${either(OAUTH_START)})（([a-z_]+)）$`), (message, code) => `${OAUTH_START[message]} (${code})`],
    // 作業場所：実行の出力が規則に合わなかった
    [/^実行は終了しましたが、出力が作業場の安全規則に違反したため結果を反映しませんでした\(ルール ([a-z_]+)\)。(.*)$/,
      (rule, advice) => `The run finished, but its output broke the workspace safety rules, so the result wasn’t applied (rule ${rule}). ${WORKSPACE_RULES[advice] ?? advice}`],
    // 記憶の食い違い：片方と片方の値（conflicts[].differences）
    [new RegExp(`^(${FACT}(?:・${FACT})*) ⇄ (${FACT}(?:・${FACT})*)$`), (a, b) => `${facts(a)} ⇄ ${facts(b)}`],
    // ファイルだけを送ったときの発言
    [/^添付ファイル：(.+)$/, names => `Attachments: ${names}`],
  ],
};
