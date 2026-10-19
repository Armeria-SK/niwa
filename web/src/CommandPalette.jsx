import { useEffect, useId, useRef, useState } from 'react';
import { Avatar, reducedMotion } from './components.jsx';
import { ChatIcon, LockIcon, PauseIcon, PlayIcon, PlusIcon, RecordsIcon, SearchIcon, SettingsIcon, TodayIcon, UsersIcon, ChevronRightIcon, MemoryIcon, PaletteIcon, SlidersIcon } from './icons.jsx';
import { t } from './i18n.js';

// 名前・ヒント・探すときの言葉は、今の言語で読む（getter にして、言語を切り替えると変わるようにする）。
const page = (id, icon, route, label, hint, words) => ({ id, get label() { return t(label); }, get hint() { return t(hint); }, icon, route, get words() { return t(words); } });
const PAGES = [
  page('page:today', TodayIcon, { page: 'today' }, 'shell.navToday', 'shell.paletteHintScreen', 'shell.wordsToday'),
  page('page:conversation', ChatIcon, { page: 'conversation' }, 'shell.navConversation', 'shell.paletteHintScreen', 'shell.wordsConversation'),
  page('page:bots', UsersIcon, { page: 'bots' }, 'shell.navBots', 'shell.paletteHintScreen', 'shell.wordsBots'),
  page('page:memory', MemoryIcon, { page: 'bots', id: 'everyone' }, 'shell.everyonesMemories', 'shell.navBots', 'shell.wordsMemory'),
  page('page:records', RecordsIcon, { page: 'records' }, 'shell.navRecords', 'shell.paletteHintScreen', 'shell.wordsRecords'),
  page('page:approval', RecordsIcon, { page: 'records', tab: 'approval' }, 'shell.awaitingApproval', 'shell.navRecords', 'shell.wordsApproval'),
  page('page:artifacts', RecordsIcon, { page: 'records', tab: 'artifacts' }, 'shell.outputs', 'shell.navRecords', 'shell.wordsArtifacts'),
  page('page:settings', SettingsIcon, { page: 'settings' }, 'shell.navSettings', 'shell.paletteHintScreen', 'shell.wordsSettings'),
  page('page:theme', PaletteIcon, { page: 'settings', tab: 'theme' }, 'shell.theme', 'shell.navSettings', 'shell.wordsTheme'),
  page('page:models', SlidersIcon, { page: 'settings', tab: 'models' }, 'shell.modelsAndConnections', 'shell.navSettings', 'shell.wordsModels'),
];

/** どの画面からでも開ける「探す」窓。会話・Bot・画面・よく使う操作を、文字で絞り込んで開く。 */
export function CommandPalette({ threads, members, paused, onClose, onThread, onMember, onNavigate, onNewThread, onPause }) {
  const ref = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [closing, setClosing] = useState(false);
  const timer = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog.showModal();
    inputRef.current?.focus();
    return () => { clearTimeout(timer.current); dialog.close(); previous?.focus?.(); };
  }, []);
  function requestClose() {
    if (timer.current) return;
    if (reducedMotion()) { onClose(); return; }
    setClosing(true);
    timer.current = setTimeout(() => { timer.current = null; onClose(); }, 180);
  }
  const text = query.trim().toLowerCase();
  const matches = (...values) => !text || values.some(value => String(value || '').toLowerCase().includes(text));
  const actions = [
    { id: 'action:new', label: t('shell.startNewThread'), icon: PlusIcon, run: onNewThread, words: t('shell.wordsNew') },
    { id: 'action:pause', label: paused ? t('shell.resumeBots') : t('shell.pauseBots'), icon: paused ? PlayIcon : PauseIcon, run: onPause, words: t('shell.wordsPause') },
  ].filter(item => matches(item.label, item.words));
  const pages = PAGES.filter(item => matches(item.label, item.hint, item.words)).map(item => ({ ...item, run: () => onNavigate(item.route) }));
  const conversations = threads.filter(item => matches(item.title)).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivity - a.lastActivity)
    .slice(0, text ? 8 : 5).map(item => ({ id: `thread:${item.id}`, label: item.title, hint: item.archived ? t('shell.scopeArchived') : item.scope === 'private' ? t('shell.scopePrivate') : t('shell.scopeShared'), icon: item.scope === 'private' ? LockIcon : ChatIcon, run: () => onThread(item.id) }));
  const bots = members.filter(item => matches(item.name, item.role)).slice(0, text ? 8 : 6).map(item => ({ id: `bot:${item.id}`, label: item.name, hint: item.role, member: item, run: () => onMember(item.id) }));
  const groups = [[t('shell.navConversation'), conversations], [t('shell.navBots'), bots], [t('shell.paletteGroupActions'), actions], [t('shell.paletteGroupPages'), pages]].filter(([, items]) => items.length);
  const flat = groups.flatMap(([, items]) => items);
  const current = Math.min(active, Math.max(0, flat.length - 1));
  useEffect(() => { setActive(0); }, [text]);
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [current]);
  function choose(item) { onClose(); item.run(); }
  function onKeyDown(event) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (flat.length) setActive((current + (event.key === 'ArrowDown' ? 1 : flat.length - 1)) % flat.length); }
    else if (event.key === 'Enter' && flat[current]) { event.preventDefault(); choose(flat[current]); }
  }
  let index = -1;
  return <dialog ref={ref} className={`palette ${closing ? 'closing' : ''}`} aria-label={t('shell.search')} onCancel={event => { event.preventDefault(); requestClose(); }} onClick={event => { if (event.target === event.currentTarget) requestClose(); }}>
    <div className="palette-search"><SearchIcon size={20} /><input ref={inputRef} type="search" role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={flat[current] ? `${listId}-${current}` : undefined} aria-label={t('shell.palettePlaceholder')} placeholder={t('shell.palettePlaceholder')} maxLength={200} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown} /><kbd className="kbd-hint">Esc</kbd></div>
    <div className="palette-list" id={listId} role="listbox" aria-label={t('shell.paletteResults')} ref={listRef}>
      {groups.map(([label, items]) => <div key={label} role="group" aria-label={label}><div className="palette-label" aria-hidden="true">{label}</div>{items.map(item => { index += 1; const position = index; const Icon = item.icon;
        return <button key={item.id} type="button" id={`${listId}-${position}`} role="option" tabIndex={-1} aria-selected={position === current} className={`palette-item ${position === current ? 'active' : ''}`} onMouseMove={() => { if (position !== current) setActive(position); }} onClick={() => choose(item)}>
          <span className="palette-icon" aria-hidden="true">{item.member ? <Avatar member={item.member} motion="none" size={22} /> : <Icon size={17} />}</span>
          <span className="palette-item-text"><span>{item.label}</span>{item.hint ? <small>{item.hint}</small> : null}</span>
          <ChevronRightIcon size={16} className="palette-go" aria-hidden="true" />
        </button>; })}</div>)}
      {flat.length ? null : <div className="palette-empty"><strong>{t('shell.paletteNoResults')}</strong><span>{t('shell.paletteNoResultsBody')}</span></div>}
    </div>
    <div className="palette-foot" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd>{t('shell.paletteSelect')}</span><span><kbd>Enter</kbd>{t('shell.paletteOpen')}</span><span><kbd>Esc</kbd>{t('shell.paletteClose')}</span></div>
  </dialog>;
}
