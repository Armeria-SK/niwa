import { useEffect, useId, useRef, useState } from 'react';
import { Avatar, reducedMotion } from './components.jsx';
import { ChatIcon, LockIcon, PauseIcon, PlayIcon, PlusIcon, RecordsIcon, SearchIcon, SettingsIcon, TodayIcon, UsersIcon, ChevronRightIcon, MemoryIcon, PaletteIcon, SlidersIcon } from './icons.jsx';

const PAGES = [
  { id: 'page:today', label: 'きょう', hint: '画面', icon: TodayIcon, route: { page: 'today' }, words: 'today 今日' },
  { id: 'page:conversation', label: '会話', hint: '画面', icon: ChatIcon, route: { page: 'conversation' }, words: 'chat' },
  { id: 'page:bots', label: 'Bot', hint: '画面', icon: UsersIcon, route: { page: 'bots' }, words: 'ボット' },
  { id: 'page:memory', label: 'みんなの記憶', hint: 'Bot', icon: MemoryIcon, route: { page: 'bots', id: 'everyone' }, words: '記憶 探す' },
  { id: 'page:records', label: '記録', hint: '画面', icon: RecordsIcon, route: { page: 'records' }, words: 'できごと 仕事 成果物' },
  { id: 'page:approval', label: '承認待ち', hint: '記録', icon: RecordsIcon, route: { page: 'records', tab: 'approval' }, words: '承認' },
  { id: 'page:artifacts', label: '成果物', hint: '記録', icon: RecordsIcon, route: { page: 'records', tab: 'artifacts' }, words: 'ファイル' },
  { id: 'page:settings', label: '設定', hint: '画面', icon: SettingsIcon, route: { page: 'settings' }, words: 'settings' },
  { id: 'page:theme', label: 'テーマ', hint: '設定', icon: PaletteIcon, route: { page: 'settings', tab: 'theme' }, words: '配色 色' },
  { id: 'page:models', label: 'モデルと接続', hint: '設定', icon: SlidersIcon, route: { page: 'settings', tab: 'models' }, words: 'モデル 接続' },
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
    { id: 'action:new', label: '新しい会話を始める', icon: PlusIcon, run: onNewThread, words: 'new' },
    { id: 'action:pause', label: paused ? 'Botの活動を再開する' : 'Botの活動を一時停止する', icon: paused ? PlayIcon : PauseIcon, run: onPause, words: '停止 再開 pause' },
  ].filter(item => matches(item.label, item.words));
  const pages = PAGES.filter(item => matches(item.label, item.hint, item.words)).map(item => ({ ...item, run: () => onNavigate(item.route) }));
  const conversations = threads.filter(item => matches(item.title)).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivity - a.lastActivity)
    .slice(0, text ? 8 : 5).map(item => ({ id: `thread:${item.id}`, label: item.title, hint: item.archived ? '保管' : item.scope === 'private' ? '個別' : '共有', icon: item.scope === 'private' ? LockIcon : ChatIcon, run: () => onThread(item.id) }));
  const bots = members.filter(item => matches(item.name, item.role)).slice(0, text ? 8 : 6).map(item => ({ id: `bot:${item.id}`, label: item.name, hint: item.role, member: item, run: () => onMember(item.id) }));
  const groups = [['会話', conversations], ['Bot', bots], ['操作', actions], ['移動', pages]].filter(([, items]) => items.length);
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
  return <dialog ref={ref} className={`palette ${closing ? 'closing' : ''}`} aria-label="探す" onCancel={event => { event.preventDefault(); requestClose(); }} onClick={event => { if (event.target === event.currentTarget) requestClose(); }}>
    <div className="palette-search"><SearchIcon size={20} /><input ref={inputRef} type="search" role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={flat[current] ? `${listId}-${current}` : undefined} aria-label="会話・Bot・画面を探す" placeholder="会話・Bot・画面を探す" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown} /><kbd className="kbd-hint">Esc</kbd></div>
    <div className="palette-list" id={listId} role="listbox" aria-label="候補" ref={listRef}>
      {groups.map(([label, items]) => <div key={label} role="group" aria-label={label}><div className="palette-label" aria-hidden="true">{label}</div>{items.map(item => { index += 1; const position = index; const Icon = item.icon;
        return <button key={item.id} type="button" id={`${listId}-${position}`} role="option" tabIndex={-1} aria-selected={position === current} className={`palette-item ${position === current ? 'active' : ''}`} onMouseMove={() => { if (position !== current) setActive(position); }} onClick={() => choose(item)}>
          <span className="palette-icon" aria-hidden="true">{item.member ? <Avatar member={item.member} motion="none" size={22} /> : <Icon size={17} />}</span>
          <span className="palette-item-text"><span>{item.label}</span>{item.hint ? <small>{item.hint}</small> : null}</span>
          <ChevronRightIcon size={16} className="palette-go" aria-hidden="true" />
        </button>; })}</div>)}
      {flat.length ? null : <div className="palette-empty"><strong>見つかりませんでした</strong><span>別の言葉で探してみてください。</span></div>}
    </div>
    <div className="palette-foot" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd>えらぶ</span><span><kbd>Enter</kbd>ひらく</span><span><kbd>Esc</kbd>とじる</span></div>
  </dialog>;
}
