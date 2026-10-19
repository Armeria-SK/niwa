import { useEffect, useState } from 'react';
import { Modal, Switch, Segmented } from '../components.jsx';
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
import { LANGUAGES, t } from '../i18n.js';
import { CheckIcon, GlobeIcon, LanguageIcon, MemoryIcon, PaletteIcon, PauseIcon, PlayIcon, ShieldIcon, SlidersIcon, UsersIcon } from '../icons.jsx';

// 欄の名前は、描くたびに今の言語で引く（label は読むときに訳す getter）。
const tabItem = (value, key, icon) => ({ value, icon, get label() { return t(`settings.${key}`); } });
const TABS = [tabItem('theme', 'tabTheme', PaletteIcon), tabItem('language', 'tabLanguage', LanguageIcon), tabItem('rules', 'tabRules', ShieldIcon), tabItem('models', 'tabModels', SlidersIcon), tabItem('mcp', 'tabMcp', GlobeIcon), tabItem('activity', 'tabActivity', UsersIcon), tabItem('backup', 'tabBackup', MemoryIcon)];
/** 下の「設定を保存」で保存する項目が、どの欄にあるか（欄の value）。 */
const FIELD_TABS = { theme: 'theme', language: 'language', rules: 'rules', autonomous: 'activity', maxMembers: 'activity', unlimited: 'activity', concurrent: 'activity', backupEnabled: 'backup', backupTime: 'backup', backupDays: 'backup' };

/** 上に「いつものモデル」、下に接続先のカード。接続とモデルは、枠ごとにその場で保存する（ページ下の「設定を保存」は使わない）。 */
function ModelSettings() {
  return <div className="settings-form model-settings">
    <section className="settings-section"><h2>{t('settings.defaultModelTitle')}</h2><p>{t('settings.defaultModelLead1')}<br />{t('settings.defaultModelLead2')}<br />{t('settings.defaultModelLead3')}</p>
      <ModelDefaults />
      <p className="field-hint">{t('settings.defaultModelHint')}</p>
    </section>
    <section className="settings-section"><h2>{t('settings.connectionsTitle')}</h2><p>{t('settings.connectionsLead1')}<br />{t('settings.connectionsLead2')}</p>
      <div className="connection-grid"><AnthropicConnection /><CompatibleConnection /><LocalLlmConnection /><SubscriptionConnection /></div>
    </section>
    <details className="settings-more"><summary>{t('settings.recentRoutes')}</summary><ModelRoutes /></details>
  </div>;
}

/** 開いている欄はURL（#settings/欄）で決まる。MCPの認証から戻るページと、モデル接続の案内がここへつなぐ。 */
export function Settings({ tab = 'theme', onTab, onClose, onPreviewTheme, onPreviewLanguage, settings, onSave, paused, onPause, members }) {
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);
  const [touched, setTouched] = useState(() => new Set());
  // Untouched fields follow the server, so saving sends only what was edited here and never reverts another tab's change.
  useEffect(() => { setDraft(current => {
    const next = { ...settings, ...Object.fromEntries([...touched].map(key => [key, current[key]])), ...(touched.has('rules') ? { rulesRevision: current.rulesRevision } : {}) };
    return Object.keys(next).every(key => next[key] === current[key]) ? current : next;
  }); }, [settings, touched]);
  useEffect(() => { onPreviewTheme(draft.theme); return () => onPreviewTheme(null); }, [draft.theme, onPreviewTheme]);
  useEffect(() => { onPreviewLanguage(draft.language); return () => onPreviewLanguage(null); }, [draft.language, onPreviewLanguage]);
  const change = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setTouched(current => new Set(current).add(key)); setSaved(false); };
  // 下の「設定を保存」は、テーマ・共通ルール・活動と人数・バックアップの欄をまとめて保存する。どの欄に未保存の変更があるかを示す。
  const unsaved = [...new Set([...touched].map(field => FIELD_TABS[field]).filter(Boolean))].map(value => TABS.find(item => item.value === value).label);
  async function submit(e) { e.preventDefault(); const ok = await onSave(draft, touched); if (ok) setTouched(new Set()); setSaved(ok); }
  // 設定は今の画面の上に重ねて開く。左に欄を並べ、右でその欄を設定する。
  return <Modal title={t('settings.title')} onClose={onClose} className="settings-modal"><div className="settings-layout">
    <nav className="settings-nav" aria-label={t('settings.navLabel')}><Segmented label={t('settings.categoryLabel')} options={TABS.map(({ value, label, icon: Icon }) => ({ value, label: <><Icon size={19} />{label}</> }))} value={tab} onChange={value => { onTab(value); setSaved(false); }} /></nav>
    <div className="settings-pane">
    <div className="settings-scroll" key={tab}>
    {tab === 'mcp' ? <McpConnections /> : tab === 'models' ? <ModelSettings /> : <form className="settings-form" onSubmit={submit}>
      {tab === 'theme' ? <section className="settings-section"><h2>{t('settings.themeTitle')}</h2><p>{t('settings.themeLead')}</p><div className="theme-picker" role="group" aria-label={t('settings.themeGroup')}>{THEMES.map(theme => <button type="button" key={theme.id} className={`theme-option ${draft.theme === theme.id ? 'selected' : ''}`} aria-pressed={draft.theme === theme.id} onClick={() => change('theme', theme.id)}><ThemePreview theme={theme} /><strong>{theme.name}</strong><small>{theme.description}</small>{draft.theme === theme.id ? <CheckIcon size={18} /> : null}</button>)}</div><p className="field-hint">{t('settings.themeHint1')}<br />{t('settings.themeHint2')}<br />{t('settings.themeHint3')}</p></section> : null}
      {tab === 'language' ? <section className="settings-section"><h2>{t('settings.languageTitle')}</h2><p>{t('settings.languageLead')}</p><div className="theme-picker language-picker" role="group" aria-label={t('settings.languageGroup')}>{LANGUAGES.map(item => <button type="button" key={item.id} lang={item.id} className={`theme-option language-option ${draft.language === item.id ? 'selected' : ''}`} aria-pressed={draft.language === item.id} onClick={() => change('language', item.id)}><strong>{item.name}</strong><small>{item.sample}</small>{draft.language === item.id ? <CheckIcon size={18} /> : null}</button>)}</div><p className="field-hint">{t('settings.languageHint1')}<br />{t('settings.languageHint2')}<br />{t('settings.languageHint3')}</p></section> : null}
      {tab === 'rules' ? <section className="settings-section"><h2>{t('settings.rulesTitle')}</h2><p>{t('settings.rulesLead1')}<br />{t('settings.rulesLead2')}</p><label className="field"><span>{t('settings.rulesField')}</span><textarea rows={9} maxLength={20000} value={draft.rules} onChange={e => change('rules', e.target.value)} /></label><p className="field-hint">{t('settings.rulesHint1')}<br />{t('settings.rulesHint2')}</p><div className="inline-note"><ShieldIcon size={20} /><span>{t('settings.rulesNote1')}<br />{t('settings.rulesNote2')}</span></div></section> : null}
      {tab === 'activity' ? <section className="settings-section"><h2>{t('settings.activityTitle')}</h2><p>{t('settings.activityLead')}</p>
        <div className="pause-setting"><div><strong>{paused ? t('settings.activityPaused') : t('settings.activityRunning')}</strong><small>{t('settings.activityPauseHint')}</small></div><button className="button secondary" type="button" onClick={onPause}>{paused ? <PlayIcon size={17} /> : <PauseIcon size={17} />}{paused ? t('settings.resume') : t('settings.pause')}</button></div>
        <Switch checked={draft.autonomous} onChange={value => change('autonomous', value)} label={t('settings.autonomousLabel')} description={t('settings.autonomousDescription')} />
        <NightPreviewSetting />
        <AutonomyStatus members={members} />
        <label className="field narrow-field"><span>{t('settings.maxMembersLabel')}</span><div className="input-with-unit"><input type="number" min="1" max="100" value={draft.maxMembers} onChange={e => change('maxMembers', e.target.value)} required /><span>{t('settings.maxMembersUnit')}</span></div><small>{t('settings.maxMembersHint1')}<br />{t('settings.maxMembersHint2')}</small></label>
        <Switch checked={draft.unlimited} onChange={value => change('unlimited', value)} label={t('settings.unlimitedLabel')} description={t('settings.unlimitedDescription')} />
        {!draft.unlimited ? <label className="field narrow-field"><span>{t('settings.concurrentLabel')}</span><div className="input-with-unit"><input type="number" min="1" max="100" value={draft.concurrent} onChange={e => change('concurrent', e.target.value)} required /><span>{t('settings.concurrentUnit')}</span></div></label> : null}
      </section> : null}
      {tab === 'backup' ? <section className="settings-section"><h2>{t('settings.backupTitle')}</h2><p>{t('settings.backupLead')}</p>
        <Switch checked={draft.backupEnabled} onChange={value => change('backupEnabled', value)} label={t('settings.backupDailyLabel')} description={t('settings.backupDailyDescription')} />
        <div className="field-pair"><label className="field"><span>{t('settings.backupTimeLabel')}</span><input type="time" value={draft.backupTime} onChange={e => change('backupTime', e.target.value)} required /></label><label className="field"><span>{t('settings.backupDaysLabel')}</span><div className="input-with-unit"><input type="number" min="1" max="365" value={draft.backupDays} onChange={e => change('backupDays', e.target.value)} required /><span>{t('settings.backupDaysUnit')}</span></div></label></div>
        <BackupStatus enabled={settings.backupEnabled} />
      </section> : null}
      <div className={`form-actions settings-save ${unsaved.length && !saved ? 'dirty' : ''}`}><span className="saved-inline" role="status">{saved ? <><CheckIcon size={16} />{t('common.saved')}</> : unsaved.length ? t('settings.unsavedChanges', { tabs: unsaved.join(t('settings.unsavedSeparator')) }) : null}</span><button type="button" className="button subtle" disabled={!touched.size} onClick={() => { setDraft(settings); setTouched(new Set()); setSaved(false); }}>{t('settings.revert')}</button><button className="button primary" disabled={!touched.size}>{t('settings.saveSettings')}</button></div>
    </form>}
    </div>
    </div>
  </div></Modal>;
}

/** 配色の見本。左の列・地・紙・主色を小さな画面の形で描く。自動は明るい地と暗い地を斜めに分けて見せる。 */
function ThemePreview({ theme }) {
  const night = THEMES.find(item => item.id === 'night').preview;
  const colors = theme.id === 'auto' ? { ...THEMES.find(item => item.id === 'garden').preview, canvas2: night.canvas } : theme.preview;
  return <span className={`theme-preview ${theme.id === 'auto' ? 'split' : ''}`} aria-hidden="true" style={{ '--p-canvas': colors.canvas, '--p-canvas-2': colors.canvas2, '--p-rail': colors.rail, '--p-paper': colors.paper, '--p-accent': colors.accent, '--p-soft': colors.soft }}><i /><span><i /><i /><i /></span></span>;
}
