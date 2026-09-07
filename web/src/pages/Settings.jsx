import { useEffect, useState } from 'react';
import { Avatar, Switch, Segmented } from '../components.jsx';
import { THEMES } from '../data.js';
import { BackupStatus } from '../BackupStatus.jsx';
import { SubscriptionConnection } from '../SubscriptionConnection.jsx';
import { FallbackConnection } from '../FallbackConnection.jsx';
import { ModelRoutes } from '../ModelRoutes.jsx';
import { ModelDefaults } from '../ModelDefaults.jsx';
import { XConnection } from '../XConnection.jsx';
import { CheckIcon, ClockIcon, InfoIcon, PauseIcon, PlayIcon, ShieldIcon } from '../icons.jsx';

export function Settings({ onPreviewTheme, settings, onSave, paused, onPause, members, onUpdateMembers, notify }) {
  const [tab, setTab] = useState('theme');
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setDraft(current => current.rules === settings.rules ? { ...current, rulesRevision: settings.rulesRevision } : current); }, [settings.rules, settings.rulesRevision]);
  useEffect(() => { onPreviewTheme(draft.theme); return () => onPreviewTheme(null); }, [draft.theme, onPreviewTheme]);
  const change = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setSaved(false); };
  async function submit(e) { e.preventDefault(); setSaved(await onSave(draft)); }
  return <main className="work-area settings-page" id="main-content" tabIndex={-1}>
    <div className="page-heading"><div><span className="eyebrow">心地よく、一緒に過ごすために。</span><h1>設定</h1><p>みんなのルールと、活動の仕方を整えます。</p></div></div>
    <Segmented label="設定のカテゴリ" className="settings-tabs" options={[{ value: 'theme', label: 'テーマ' }, { value: 'rules', label: '共通ルール' }, { value: 'models', label: 'モデルと接続' }, { value: 'activity', label: '活動と人数' }, { value: 'backup', label: 'バックアップ' }]} value={tab} onChange={value => { setTab(value); setSaved(false); }} />
    <div className="settings-scroll" key={tab}>
    <form className="settings-form" onSubmit={submit}>
      {tab === 'theme' ? <section className="settings-section"><h2>Niwaの色を選ぶ</h2><p>気分に合う配色で、心地よい場所に。</p><div className="theme-picker" role="group" aria-label="配色テーマ">{THEMES.map(theme => <button type="button" key={theme.id} className={`theme-option ${draft.theme === theme.id ? 'selected' : ''}`} aria-pressed={draft.theme === theme.id} onClick={() => change('theme', theme.id)}><span className="theme-colors" aria-hidden="true">{theme.colors.map(color => <span key={color} style={{ backgroundColor: color }} />)}</span><strong>{theme.name}</strong><small>{theme.description}</small>{draft.theme === theme.id ? <CheckIcon size={18} /> : null}</button>)}</div><p className="field-hint">選ぶとすぐに全画面でプレビューできます。「設定を保存」で次回もこの配色を使います。保存せずに設定画面を離れると元に戻ります。</p></section> : null}
      {tab === 'rules' ? <section className="settings-section"><h2>みんなが大切にすること</h2><p>全Botに共通して渡す指示です。保存すると、進行中の応答も新しいルールで取り直します。</p><label className="field"><span>共通の指示</span><textarea rows={9} maxLength={20000} value={draft.rules} onChange={e => change('rules', e.target.value)} /></label><p className="field-hint">別の画面で更新された場合は「変更を戻す」で最新の内容を読み直してください。空欄にすると追加の指示を解除します。</p><div className="inline-note"><ShieldIcon size={20} /><span>停止・権限・予算・記憶の分離は本体が管理します。共通の指示や個別の性格設定では上書きできません。</span></div></section> : null}
      {tab === 'models' ? <section className="settings-section"><h2>モデルと接続先</h2><p>いつものモデルと、利用上限に達したときの切替先を設定します。</p>
        <SubscriptionConnection />
        <ModelDefaults />
        <p className="field-hint">Botごとの変更は、メンバーのプロフィールで行えます。</p>
        <div className="form-section-label">Ollamaへの自動切替</div><label className="field"><span>Ollamaの接続先URL</span><input type="url" value={draft.ollamaUrl} onChange={e => change('ollamaUrl', e.target.value)} placeholder="http://…:11434" /></label>
        <FallbackConnection key={settings.ollamaUrl} savedUrl={settings.ollamaUrl} />
        <ModelRoutes />
        <XConnection />
      </section> : null}
      {tab === 'activity' ? <section className="settings-section"><h2>Botたちの活動</h2><p>人数と同時に活動できる数は、別々に設定できます。</p>
        <div className="pause-setting"><div><strong>{paused ? '活動を一時停止しています' : 'Botたちは活動中です'}</strong><small>一時停止中も、会話や設定を確認できます。</small></div><button className="button secondary" type="button" onClick={onPause}>{paused ? <PlayIcon size={17} /> : <PauseIcon size={17} />}{paused ? '再開' : '一時停止'}</button></div>
        <Switch checked={draft.autonomous} onChange={value => change('autonomous', value)} label="自発的な活動を許可する" description="保存すると、活動の予定で設定した自発活動と、その委任先に適用します。オフでも通常の依頼は続けられます。" />
        <label className="field narrow-field"><span>リーダーが生成できるBotの数</span><div className="input-with-unit"><input type="number" min="1" max="100" value={draft.maxMembers} onChange={e => change('maxMembers', e.target.value)} required /><span>体</span></div><small>休眠中も含みます。リーダーは別枠です。</small></label>
        <Switch checked={draft.unlimited} onChange={value => change('unlimited', value)} label="同時実行数を制限しない" description="接続先やマシンの実行上限には従います。" />
        {!draft.unlimited ? <label className="field narrow-field"><span>同時実行数</span><div className="input-with-unit"><input type="number" min="1" max="100" value={draft.concurrent} onChange={e => change('concurrent', e.target.value)} required /><span>件</span></div></label> : null}
        <div className="form-section-label">現在のメンバー</div><div className="settings-member-list">{members.map(member => <div key={member.id}><Avatar member={member} size={34} /><span>{member.name}</span><span className="muted">{member.status === 'sleeping' ? '休眠中' : paused ? '一時停止中' : '活動中'}</span></div>)}</div>
      </section> : null}
      {tab === 'backup' ? <section className="settings-section"><h2>大切な記憶を残す</h2><p>設定・人格・個別記憶・会話履歴を、毎日バックアップします。</p>
        <Switch disabled checked={true} label="毎日のバックアップ" description="本体が起動している間、定期的に保存します。" />
        <div className="field-pair"><label className="field"><span>実行する時刻（日本時間）</span><input type="time" value={draft.backupTime} onChange={e => change('backupTime', e.target.value)} required /></label><label className="field"><span>保存する日数</span><div className="input-with-unit"><input type="number" min="1" max="365" value={draft.backupDays} onChange={e => change('backupDays', e.target.value)} required /><span>日</span></div></label></div>
        <BackupStatus />
      </section> : null}
      <div className="form-actions settings-save"><span className="saved-inline" role="status">{saved ? <><CheckIcon size={16} />保存しました</> : null}</span><button type="button" className="button subtle" onClick={() => { setDraft(settings); setSaved(false); }}>変更を戻す</button><button className="button primary">設定を保存</button></div>
    </form>
    </div>
  </main>;
}
