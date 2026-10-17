import { useEffect, useState } from 'react';
import { Switch, Segmented } from '../components.jsx';
import { THEMES } from '../data.js';
import { AutonomyStatus } from '../AutonomyStatus.jsx';
import { BackupStatus } from '../BackupStatus.jsx';
import { SubscriptionConnection } from '../SubscriptionConnection.jsx';
import { CompatibleConnection } from '../CompatibleConnection.jsx';
import { AnthropicConnection } from '../AnthropicConnection.jsx';
import { LocalLlmConnection } from '../LocalLlmConnection.jsx';
import { ModelDefaults } from '../ModelDefaults.jsx';
import { ModelRoutes } from '../ModelRoutes.jsx';
import { McpConnections } from '../McpConnections.jsx';
import { NightPreviewSetting } from '../NightPlan.jsx';
import { CheckIcon, PauseIcon, PlayIcon, ShieldIcon } from '../icons.jsx';

const FIELD_TABS = { theme: 'テーマ', rules: '共通ルール', autonomous: '活動と人数', maxMembers: '活動と人数', unlimited: '活動と人数', concurrent: '活動と人数', backupEnabled: 'バックアップ', backupTime: 'バックアップ', backupDays: 'バックアップ' };

/** 上に「いつものモデル」、下に接続先のカード。接続とモデルは、枠ごとにその場で保存する（ページ下の「設定を保存」は使わない）。 */
function ModelSettings() {
  return <div className="settings-form model-settings">
    <section className="settings-section"><h2>いつものモデル</h2><p>Botたちが返事に使うモデルです。<br />つないだ接続先のモデルから選べます。<br />枠ごとに、中のボタンで保存します。</p>
      <ModelDefaults />
      <p className="field-hint">Botごとの変更は、Botのプロフィールで行えます。</p>
    </section>
    <section className="settings-section"><h2>接続先</h2><p>使う接続先を開いて設定します。<br />いくつでも同時につなげます。</p>
      <div className="connection-grid"><AnthropicConnection /><CompatibleConnection /><LocalLlmConnection /><SubscriptionConnection /></div>
    </section>
    <details className="settings-more"><summary>直近のモデル接続</summary><ModelRoutes /></details>
  </div>;
}

/** 開いている欄はURL（#settings/欄）で決まる。MCPの認証から戻るページと、モデル接続の案内がここへつなぐ。 */
export function Settings({ tab = 'theme', onTab, onPreviewTheme, settings, onSave, paused, onPause, members }) {
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);
  const [touched, setTouched] = useState(() => new Set());
  // Untouched fields follow the server, so saving sends only what was edited here and never reverts another tab's change.
  useEffect(() => { setDraft(current => {
    const next = { ...settings, ...Object.fromEntries([...touched].map(key => [key, current[key]])), ...(touched.has('rules') ? { rulesRevision: current.rulesRevision } : {}) };
    return Object.keys(next).every(key => next[key] === current[key]) ? current : next;
  }); }, [settings, touched]);
  useEffect(() => { onPreviewTheme(draft.theme); return () => onPreviewTheme(null); }, [draft.theme, onPreviewTheme]);
  const change = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setTouched(current => new Set(current).add(key)); setSaved(false); };
  // 下の「設定を保存」は、テーマ・共通ルール・活動と人数・バックアップの欄をまとめて保存する。どの欄に未保存の変更があるかを示す。
  const unsaved = [...new Set([...touched].map(field => FIELD_TABS[field]).filter(Boolean))];
  async function submit(e) { e.preventDefault(); const ok = await onSave(draft, touched); if (ok) setTouched(new Set()); setSaved(ok); }
  return <main className="work-area settings-page" id="main-content" tabIndex={-1}>
    <div className="page-heading"><div><span className="eyebrow">心地よく、一緒に過ごすために。</span><h1>設定</h1><p>みんなのルールと、活動の仕方を整えます。</p></div></div>
    <Segmented label="設定のカテゴリ" className="settings-tabs" options={[{ value: 'theme', label: 'テーマ' }, { value: 'rules', label: '共通ルール' }, { value: 'models', label: 'モデルと接続' }, { value: 'mcp', label: 'MCP接続' }, { value: 'activity', label: '活動と人数' }, { value: 'backup', label: 'バックアップ' }]} value={tab} onChange={value => { onTab(value); setSaved(false); }} />
    <div className="settings-scroll" key={tab}>
    {tab === 'mcp' ? <McpConnections /> : tab === 'models' ? <ModelSettings /> : <form className="settings-form" onSubmit={submit}>
      {tab === 'theme' ? <section className="settings-section"><h2>Niwaの色を選ぶ</h2><p>気分に合う配色で、心地よい場所に。</p><div className="theme-picker" role="group" aria-label="配色テーマ">{THEMES.map(theme => <button type="button" key={theme.id} className={`theme-option ${draft.theme === theme.id ? 'selected' : ''}`} aria-pressed={draft.theme === theme.id} onClick={() => change('theme', theme.id)}><span className="theme-colors" aria-hidden="true">{theme.colors.map(color => <span key={color} style={{ backgroundColor: color }} />)}</span><strong>{theme.name}</strong><small>{theme.description}</small>{draft.theme === theme.id ? <CheckIcon size={18} /> : null}</button>)}</div><p className="field-hint">選ぶとすぐに全画面でプレビューできます。<br />「設定を保存」で、このNiwaを開くすべての端末でこの配色を使います。<br />保存せずに設定画面を離れると元に戻ります。</p></section> : null}
      {tab === 'rules' ? <section className="settings-section"><h2>みんなが大切にすること</h2><p>全Botに共通して渡す指示です。<br />保存すると、進行中の応答も新しいルールで取り直します。</p><label className="field"><span>共通の指示</span><textarea rows={9} maxLength={20000} value={draft.rules} onChange={e => change('rules', e.target.value)} /></label><p className="field-hint">別の画面で更新された場合は「変更を戻す」で最新の内容を読み直してください。<br />空欄にすると追加の指示を解除します。</p><div className="inline-note"><ShieldIcon size={20} /><span>停止・権限・予算・記憶の分離は本体が管理します。<br />共通の指示や個別の性格設定では上書きできません。</span></div></section> : null}
      {tab === 'activity' ? <section className="settings-section"><h2>Botたちの活動</h2><p>人数と同時に活動できる数は、別々に設定できます。</p>
        <div className="pause-setting"><div><strong>{paused ? '活動を一時停止しています' : 'Botたちは活動中です'}</strong><small>一時停止中も、会話や設定を確認できます。</small></div><button className="button secondary" type="button" onClick={onPause}>{paused ? <PlayIcon size={17} /> : <PauseIcon size={17} />}{paused ? '再開' : '一時停止'}</button></div>
        <Switch checked={draft.autonomous} onChange={value => change('autonomous', value)} label="自発的な活動を許可する" description="保存すると、予定登録なしでもBotが順番に活動を選べます。必要がなければ休息します。オフでも通常の依頼は続けられます。" />
        <NightPreviewSetting />
        <AutonomyStatus members={members} />
        <label className="field narrow-field"><span>リーダーが生成できるBotの数</span><div className="input-with-unit"><input type="number" min="1" max="100" value={draft.maxMembers} onChange={e => change('maxMembers', e.target.value)} required /><span>体</span></div><small>休眠中も含みます。<br />リーダーは別枠です。</small></label>
        <Switch checked={draft.unlimited} onChange={value => change('unlimited', value)} label="同時実行数を制限しない" description="接続先やマシンの実行上限には従います。" />
        {!draft.unlimited ? <label className="field narrow-field"><span>同時実行数</span><div className="input-with-unit"><input type="number" min="1" max="100" value={draft.concurrent} onChange={e => change('concurrent', e.target.value)} required /><span>件</span></div></label> : null}
      </section> : null}
      {tab === 'backup' ? <section className="settings-section"><h2>大切な記憶を残す</h2><p>設定・人格・個別記憶・会話履歴のバックアップを設定します。</p>
        <Switch checked={draft.backupEnabled} onChange={value => change('backupEnabled', value)} label="毎日のバックアップ" description="設定を保存すると反映されます。オフにしても、保存済みのバックアップは残ります。" />
        <div className="field-pair"><label className="field"><span>実行する時刻（日本時間）</span><input type="time" value={draft.backupTime} onChange={e => change('backupTime', e.target.value)} required /></label><label className="field"><span>保存する日数</span><div className="input-with-unit"><input type="number" min="1" max="365" value={draft.backupDays} onChange={e => change('backupDays', e.target.value)} required /><span>日</span></div></label></div>
        <BackupStatus enabled={settings.backupEnabled} />
      </section> : null}
      <div className="form-actions settings-save"><span className="saved-inline" role="status">{saved ? <><CheckIcon size={16} />保存しました</> : unsaved.length ? `保存していない変更：${unsaved.join('・')}` : null}</span><button type="button" className="button subtle" disabled={!touched.size} onClick={() => { setDraft(settings); setTouched(new Set()); setSaved(false); }}>変更を戻す</button><button className="button primary" disabled={!touched.size}>設定を保存</button></div>
    </form>}
    </div>
  </main>;
}
