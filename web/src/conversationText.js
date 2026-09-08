// Hide only known generated envelopes. Stored text and task input stay intact.
export function conversationText(message) {
  if (message.author_id === 'administrator') return message.body;
  const blocked = message.body.match(/^((?:@[^\n]+\n)?)作業を保留しています：([\s\S]+)\n親タスク：[0-9a-f-]{36}\n状態：waiting_user\n成果物：通知だけでは受け渡しません\n必要な対応：([^\n]+?) — ([\s\S]+)$/u);
  if (blocked && blocked[2] === blocked[4]) return `${blocked[1]}作業を保留しています：${blocked[2]}\n対応待ち：${blocked[3]}`;
  return message.body.replace(
    /^(@[^\n]+ への依頼\n成果物の受け渡し\n)親タスク：[0-9a-f-]{36}\n親の段階：review_ready\n成果物ID：[0-9a-f-]{36}\nSHA-256：[0-9a-f]{64}\n依頼内容：/u,
    '$1依頼内容：',
  );
}
