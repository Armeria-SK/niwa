import { uid } from './data.js';
import { t } from './i18n.js';
import { nameList } from './conversationText.js';
// Same limits as the server. The kind is decided from the bytes (image header, %PDF-, or strict UTF-8 text), not by the file extension.
export const ATTACHMENT_LIMITS = { count: 5, bytes: 256 * 1024, imageBytes: 3 * 1024 * 1024, pdfBytes: 4 * 1024 * 1024, totalBytes: 8 * 1024 * 1024, name: 120 };
const BINARY = /[\u0000-\u0008\u000e-\u001a\u001c-\u001f]/u;
export function attachmentName(value) {
  const base = value.normalize('NFC').split(/[\\/]/u).at(-1).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/[<>:"|?*]/gu, '_').trim().replace(/^\.+/u, '');
  return [...base].slice(0, ATTACHMENT_LIMITS.name).join('').trim();
}
export function formatSize(bytes) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function base64(bytes) { let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(binary); }

/** 'image'・'pdf'・'text' のどれか。画像は先頭の印（PNG・JPEG・GIF・WebP）で、PDFは「%PDF-」で見分ける。どれでもなければ null。 */
export function attachmentKind(bytes) {
  const starts = (...values) => values.every((value, index) => bytes[index] === value);
  const ascii = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 24 && starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) && ascii(12, 16) === 'IHDR') return 'image';
  if (bytes.length >= 4 && starts(0xff, 0xd8, 0xff)) return 'image';
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(ascii(0, 6))) return 'image';
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image';
  if (bytes.length >= 5 && ascii(0, 5) === '%PDF-') return 'pdf';
  try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); return BINARY.test(text) ? null : 'text'; } catch { return null; }
}

/** Returns accepted files and a reason (in the current display language) for every rejected file. */
export async function readAttachments(files, current = 0, currentBytes = 0) {
  const accepted = [], errors = []; let total = currentBytes;
  for (const file of files) {
    const name = attachmentName(file.name);
    if (current + accepted.length >= ATTACHMENT_LIMITS.count) { errors.push(t('conversation.attachTooMany', { name: file.name, count: ATTACHMENT_LIMITS.count })); continue; }
    if (!name) { errors.push(t('conversation.attachBadName', { name: file.name })); continue; }
    if (file.size > ATTACHMENT_LIMITS.pdfBytes) { errors.push(t('conversation.attachTooBig', { name, size: formatSize(file.size) })); continue; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const kind = attachmentKind(bytes);
      if (!kind) { errors.push(t('conversation.attachUnsupported', { name })); continue; }
      const limit = kind === 'image' ? ATTACHMENT_LIMITS.imageBytes : kind === 'pdf' ? ATTACHMENT_LIMITS.pdfBytes : ATTACHMENT_LIMITS.bytes;
      if (bytes.byteLength > limit) { errors.push(t(({ image: 'conversation.attachImageTooBig', pdf: 'conversation.attachPdfTooBig', text: 'conversation.attachTextTooBig' })[kind], { name, size: formatSize(bytes.byteLength) })); continue; }
      if (total + bytes.byteLength > ATTACHMENT_LIMITS.totalBytes) { errors.push(t('conversation.attachTotalTooBig', { name })); continue; }
      total += bytes.byteLength;
      accepted.push({ id: uid('file'), name, size: bytes.byteLength, kind, content: base64(bytes) });
    } catch { errors.push(t('conversation.attachReadFailed', { name })); }
  }
  return { accepted, errors };
}

/** 画像を見られなかったBotの名前から、会話に出す知らせを作る。だれもいなければ空。 */
export function unseenNotice(names) {
  const list = (names || []).filter(Boolean);
  return list.length ? t('conversation.unseenNotice', { names: nameList(list), count: list.length }) : '';
}
