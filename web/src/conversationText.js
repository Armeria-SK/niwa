// Hide only the generated handoff envelope. Stored text and task input stay intact.
export function conversationText(message) {
  if (message.author_id === 'administrator') return message.body;
  return message.body.replace(
    /^(@[^\n]+ への依頼\n成果物の受け渡し\n)親タスク：[0-9a-f-]{36}\n親の段階：review_ready\n成果物ID：[0-9a-f-]{36}\nSHA-256：[0-9a-f]{64}\n依頼内容：/u,
    '$1依頼内容：',
  );
}
