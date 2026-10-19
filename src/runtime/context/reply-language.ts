import type { LanguageId } from '../../storage/language-schema.ts';

const NAMES: Record<LanguageId, string> = { ja: '日本語', en: '英語（English）', ko: '韓国語（한국어）', 'zh-CN': '簡体字の中国語（简体中文）' };

/** The one line that asks a Bot to write in the language chosen in the settings; when the administrator writes in another language, that one wins. */
export function replyLanguage(language: string): string {
  const name = NAMES[language as LanguageId] ?? NAMES.ja;
  return `返答の言語: 会話への返答や報告は${name}で書いてください。管理者が別の言語で書いたときは、その言語で答えてください。`;
}
