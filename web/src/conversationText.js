import { t, language, formatList } from './i18n.js';

/** 名前の並び。日本語はこれまでどおり「・」でつなぎ、ほかの言語はその言語の書き方（「A, B, and C」など）でつなぐ。 */
export function nameList(names) { return language() === 'ja' ? names.join('・') : formatList(names); }

// The server writes these envelopes in Japanese. Only their fixed labels follow the chosen language; names, reasons and request text stay as written.
const REVIEW_NOTE = '内容のレビュー依頼です。まだ確認済みとしての引渡しではありません。\n';
const requestHeading = mention => t('conversation.envelopeRequestTo', { mention });
const waitingFor = who => who === '管理者' ? t('conversation.administrator') : who;

// Hide only known generated envelopes. Stored text and task input stay intact.
export function conversationText(message) {
  if (message.author_id === 'administrator') return message.body;
  const blocked = message.body.match(/^((?:@[^\n]+\n)?)作業を保留しています：([\s\S]+)\n親タスク：[0-9a-f-]{36}\n状態：waiting_user\n成果物：通知だけでは受け渡しません\n必要な対応：([^\n]+?) — ([\s\S]+)$/u);
  if (blocked && blocked[2] === blocked[4]) return t('conversation.envelopeBlocked', { mention: blocked[1], reason: blocked[2], waitingFor: waitingFor(blocked[3]) });
  const handoff = message.body.match(/^(@[^\n]+) への依頼\n成果物の受け渡し\n親タスク：[0-9a-f-]{36}\n親の段階：review_ready\n成果物ID：([0-9a-f-]{36})\nSHA-256：([0-9a-f]{64})\n依頼内容：([\s\S]*)$/u);
  if (!handoff) {
    // A plain request envelope: only its first line (「@名前 への依頼」) is Niwa's label.
    const request = message.body.match(/^(@[^\n]+) への依頼(\n[\s\S]*)?$/u);
    return request ? requestHeading(request[1]) + (request[2] ?? '') : message.body;
  }
  const [, mention, artifactId, sha256, request] = handoff;
  const body = request.startsWith(REVIEW_NOTE) ? `${t('conversation.envelopeReviewNote')}\n${request.slice(REVIEW_NOTE.length)}` : request;
  // Only identifiers confirmed by the stored envelope are presentation metadata.
  const metadata = new RegExp(`(?:artifact_id|成果物ID|SHA-?256)[ \t]*[:：]?[ \t]*(?:${artifactId}|${sha256})[ \t]*[、,。]?[ \t]*`, 'giu');
  const readable = body.replace(metadata, '').replaceAll(artifactId, t('conversation.thisOutput')).replaceAll(sha256, t('conversation.fixedVersionInline'));
  return `${requestHeading(mention)}\n${t('conversation.envelopeHandoff')}\n${t('conversation.envelopeRequestBody', { request: readable })}`;
}

/** The artifact id recorded by a stored handoff envelope; the title is looked up from loaded artifacts. */
export function messageArtifact(message) {
  if (message.artifact) return message.artifact;
  if (message.author_id === 'administrator') return null;
  return message.body.match(/^@[^\n]+ への依頼\n成果物の受け渡し\n親タスク：[0-9a-f-]{36}\n親の段階：review_ready\n成果物ID：([0-9a-f-]{36})\n/u)?.[1] ?? null;
}
