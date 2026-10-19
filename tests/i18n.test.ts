import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LANGUAGE_IDS } from '../src/storage/language-schema.ts';

const ui = (file: string) => import(pathToFileURL(resolve('web/src/' + file)).href);
const OTHERS = ['en', 'ko', 'zh-CN'] as const;
const AREAS = readdirSync(resolve('web/src/locales/ja')).filter(name => name.endsWith('.js') && name !== 'index.js').map(name => name.replace(/\.js$/, ''));
const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join(',');
const kana = /[぀-ゟ゠-ヿ]/;

test('the screens offer the same four languages the server stores, Japanese first', async () => {
  const { LANGUAGES } = await ui('i18n.js');
  assert.deepEqual(LANGUAGES.map((item: { id: string }) => item.id), [...LANGUAGE_IDS]);
  assert.deepEqual(LANGUAGES.map((item: { name: string }) => item.name), ['日本語', 'English', '한국어', '简体中文']);
});

test('every language has the same words as Japanese, with the same blanks to fill and no Japanese kana left', async () => {
  for (const area of AREAS) {
    const ja = (await ui(`locales/ja/${area}.js`)).default as Record<string, unknown>;
    for (const language of OTHERS) {
      const other = (await ui(`locales/${language}/${area}.js`)).default as Record<string, unknown>;
      assert.deepEqual(Object.keys(other).sort(), Object.keys(ja).sort(), `${language}/${area}.js has the same keys as ja/${area}.js`);
      for (const [key, value] of Object.entries(other)) {
        assert.ok(typeof value === 'string' || typeof value === 'function', `${language}/${area}.${key} is text`);
        const original = ja[key];
        if (typeof value === 'string' && typeof original === 'string') assert.equal(holes(value), holes(original), `${language}/${area}.${key} keeps the blanks of the Japanese`);
        const shown = typeof value === 'function' ? (value as (vars: unknown) => unknown)(new Proxy({}, { get: (_t, name) => name === 'count' ? 2 : 'X', has: () => true })) : value;
        assert.equal(typeof shown, 'string', `${language}/${area}.${key} gives text`);
        assert.doesNotMatch(String(shown), kana, `${language}/${area}.${key} is translated`);
      }
    }
  }
  for (const language of OTHERS) {
    const index = (await ui(`locales/${language}/index.js`)).default as Record<string, unknown>;
    assert.deepEqual(Object.keys(index).filter(area => area !== 'server').sort(), [...AREAS].sort(), `${language}/index.js lists every area`);
  }
});

test('words are looked up in the chosen language, fall back to Japanese and follow the locale', async () => {
  const i18n = await ui('i18n.js');
  assert.equal(i18n.language(), 'ja');
  assert.equal(i18n.locale(), 'ja-JP');
  assert.equal(i18n.t('common.save'), '保存');
  assert.equal(i18n.t('common.bots', { count: 3 }), '3体');
  assert.equal(i18n.t('missing.word'), 'missing.word');
  assert.equal(i18n.serverText('作業中'), '作業中', 'Japanese server text is shown as it is');
  let changes = 0; const stop = i18n.subscribeLanguage(() => changes++);
  await i18n.setLanguage('en');
  assert.equal(i18n.language(), 'en'); assert.equal(i18n.locale(), 'en-US'); assert.equal(changes, 1);
  assert.equal(i18n.t('common.save'), 'Save');
  assert.equal(i18n.t('common.bots', { count: 1 }), '1 Bot');
  assert.equal(i18n.t('common.bots', { count: 2 }), '2 Bots');
  assert.equal(i18n.formatNumber(12345), '12,345');
  assert.equal(i18n.formatList(['A', 'B', 'C']), 'A, B, and C');
  assert.deepEqual(i18n.parts('common.save'), ['Save']);
  assert.equal(i18n.serverText('この文はどの辞書にもない'), 'この文はどの辞書にもない', 'unknown server text is shown as it is');
  await i18n.setLanguage('ko'); assert.equal(i18n.t('common.save'), '저장'); assert.equal(i18n.locale(), 'ko-KR');
  await i18n.setLanguage('zh-CN'); assert.equal(i18n.t('common.save'), '保存'); assert.equal(i18n.t('common.cancel'), '取消'); assert.equal(i18n.locale(), 'zh-CN');
  await i18n.setLanguage('zh-TW');
  assert.equal(i18n.language(), 'ja', 'an unknown language is treated as Japanese');
  await i18n.setLanguage('ja'); assert.equal(changes, 4, 'choosing the same language again does not redraw');
  stop();
});
