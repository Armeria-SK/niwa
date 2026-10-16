import { uid } from './data.js';
// Same limits as the server. Text is decided by strict UTF-8 decoding, not by the file extension.
export const ATTACHMENT_LIMITS = { count: 5, bytes: 256 * 1024, name: 120 };
const BINARY = /[\u0000-\u0008\u000e-\u001a\u001c-\u001f]/u;
export function attachmentName(value) {
  const base = value.normalize('NFC').split(/[\\/]/u).at(-1).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/[<>:"|?*]/gu, '_').trim().replace(/^\.+/u, '');
  return [...base].slice(0, ATTACHMENT_LIMITS.name).join('').trim();
}
export function formatSize(bytes) { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`; }
function base64(bytes) { let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(binary); }
/** Returns accepted files and a Japanese reason for every rejected file. */
export async function readTextAttachments(files, current = 0) {
  const accepted = [], errors = [];
  for (const file of files) {
    const name = attachmentName(file.name);
    if (current + accepted.length >= ATTACHMENT_LIMITS.count) { errors.push(`「${file.name}」：添付できるのは1回の送信につき${ATTACHMENT_LIMITS.count}件までです。`); continue; }
    if (!name) { errors.push(`「${file.name}」：ファイル名を確認してください。`); continue; }
    if (file.size > ATTACHMENT_LIMITS.bytes) { errors.push(`「${name}」：256KBを超えるファイルは添付できません（${formatSize(file.size)}）。`); continue; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength > ATTACHMENT_LIMITS.bytes) { errors.push(`「${name}」：256KBを超えるファイルは添付できません。`); continue; }
      let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { errors.push(`「${name}」：UTF-8のテキストファイルではないため添付できません。画像・音声・PDFなどは送れません。`); continue; }
      if (BINARY.test(text)) { errors.push(`「${name}」：テキスト以外のデータ（バイナリ）を含むため添付できません。`); continue; }
      accepted.push({ id: uid('file'), name, size: bytes.byteLength, content: base64(bytes) });
    } catch { errors.push(`「${name}」：ファイルを読み込めませんでした。`); }
  }
  return { accepted, errors };
}
