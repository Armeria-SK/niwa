import { useEffect, useRef, useState } from 'react';
import { initialSettings, THEMES } from './data.js';
import { api } from './api.js';
import { Login } from './Login.jsx';
import { AppearanceEditor, IconButton, Modal, Segmented, EmptyState } from './components.jsx';
import { ChatIcon, UsersIcon, ActivityIcon, SettingsIcon, SearchIcon, PlusIcon, LockIcon, CloseIcon, InfoIcon, CheckCircleIcon, PinIcon } from './icons.jsx';
import { Conversation } from './pages/Conversation.jsx';
import { Members } from './pages/Members.jsx';
import { Activity } from './pages/Activity.jsx';
import { ArtifactPreview } from './pages/Productivity.jsx';
import { Settings } from './pages/Settings.jsx';
import { DeleteContentDialog } from './ContentActions.jsx';
import { TrashIcon } from './icons.jsx';
import { useRoomSearch } from './useRoomSearch.js';

const navItems = [
  { id: 'conversation', label: '会話', icon: ChatIcon },
  { id: 'members', label: 'メンバー', icon: UsersIcon },
  { id: 'activity', label: '活動', icon: ActivityIcon },
  { id: 'settings', label: '設定', icon: SettingsIcon },
];
function readPage() { const id = window.location.hash.slice(1); return navItems.some(item => item.id === id) ? id : 'activity'; }

export function App() {
  const [page, setPage] = useState(readPage);
  const [members, setMembers] = useState([]);
  const [deletedMembers, setDeletedMembers] = useState([]);
  const [threads, setThreads] = useState([]);
  const [activities, setActivities] = useState([]);
  const [updates, setUpdates] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [activityFilter, setActivityFilter] = useState('recap');
  const seen = Object.fromEntries(updates.filter(item => item.seen).map(item => [item.id, true]));
  const [authenticated, setAuthenticated] = useState(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const refreshVersion = useRef(0);
  const submission = useRef(null);
  const previousTasks = useRef(null);
  const celebrationTimers = useRef(new Map());
  const [celebrating, setCelebrating] = useState({});
  const conversationRequest = useRef(null);
  const [settings, setSettings] = useState(() => {
    try { const theme = localStorage.getItem('niwa-theme'); return { ...initialSettings, theme: THEMES.some(item => item.id === theme) ? theme : 'garden' }; }
    catch { return initialSettings; }
  });
  useEffect(() => { try { localStorage.setItem('niwa-theme', settings.theme || 'garden'); } catch { /* Storage can be disabled by the browser. */ } }, [settings.theme]);
  const [previewTheme, setPreviewTheme] = useState(null);
  const [selectedThread, setSelectedThread] = useState(() => { try { return sessionStorage.getItem('niwa-thread') || ''; } catch { return ''; } });
  const [selectedMember, setSelectedMember] = useState('');
  const [mobileDetail, setMobileDetail] = useState(false);
  const [scope, setScope] = useState('all');
  const [search, setSearch] = useState('');
  const roomSearch = useRoomSearch(search, threads);
  const [paused, setPaused] = useState(false);
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);
  const thread = threads.find(item => item.id === selectedThread) || threads[0];
  const animatedMembers = members.map(member => ({ ...member, runtimeMotion: member.status === 'sleeping' || paused ? 'none' : celebrating[member.id] ? 'celebrate' : member.runtimeMotion, activity: paused ? '一時停止中' : member.activity }));
  const memberMap = Object.fromEntries([...deletedMembers, ...animatedMembers].map(item => [item.id, item]));
  const pendingCount = activities.filter(item => item.status === 'approval').length;

  useEffect(() => { const onHash = () => setPage(readPage()); window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash); }, []);
  useEffect(() => { document.title = `Niwa · ${navItems.find(item => item.id === page)?.label || '会話'}`; }, [page]);
  useEffect(() => () => { clearTimeout(toastTimer.current); for (const timer of celebrationTimers.current.values()) clearTimeout(timer); }, []);
  useEffect(() => { try { sessionStorage.setItem('niwa-thread', selectedThread); } catch { /* Optional browser state. */ } }, [selectedThread]);
  useEffect(() => { api('/session').then(result => setAuthenticated(result.authenticated)).catch(() => setAuthenticated(false)); }, []);
  useEffect(() => {
    if (!authenticated) return;
    let stopped = false; let timer;
    async function poll() { await refresh(); if (!stopped) timer = setTimeout(poll, 2000); }
    void poll(); return () => { stopped = true; clearTimeout(timer); refreshVersion.current++; };
  }, [authenticated]);

  async function refresh() {
    const version = ++refreshVersion.current;
    try {
      const [state, modelSettings, savedUpdates, savedArtifacts, savedSchedules] = await Promise.all([api('/state'), api('/model-settings'), api('/updates'), api('/artifacts'), api('/schedules')]);
      if (version !== refreshVersion.current) return;
      if (previousTasks.current) for (const task of state.tasks) {
        if (task.state !== 'completed' || previousTasks.current.get(task.id) === 'completed') continue;
        setCelebrating(current => ({ ...current, [task.agent_id]: true }));
        clearTimeout(celebrationTimers.current.get(task.agent_id));
        celebrationTimers.current.set(task.agent_id, setTimeout(() => { setCelebrating(current => ({ ...current, [task.agent_id]: false })); celebrationTimers.current.delete(task.agent_id); }, 900));
      }
      previousTasks.current = new Map(state.tasks.map(task => [task.id, task.state]));
      const time = value => new Date(value).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
      setDeletedMembers((state.deletedAgents || []).map(agent => ({ id: agent.id, name: '削除したBot', deleted: true, shape: 'pebble', color: '#9a9a91', status: 'sleeping', motion: 'none' })));
      setMembers(state.agents.map(agent => ({ ...agent, authority: agent.role, role: agent.profile.role || (agent.role === 'leader' ? 'リーダー' : '仲間'),
        shape: 'pebble', color: '#61B8A5', persona: '', interests: [], ...agent.profile, effort: agent.reasoning,
        runtimeMotion: state.tasks.some(task => task.agent_id === agent.id && task.state === 'running') ? 'sway' : 'none', status: agent.status === 'dormant' ? 'sleeping' : 'active', activity: state.tasks.some(task => task.agent_id === agent.id && task.state === 'running') ? '仕事を進めています' : '待機しています' })));
      setThreads(state.rooms.map(room => ({ ...room, scope: room.visibility, members: room.participants, unread: 0,
        lastActivity: Date.parse(room.last_at) || 0, time: room.last_at ? time(room.last_at) : '',
        day: room.first_at ? new Date(room.first_at).toLocaleDateString('ja-JP') : '' })));
      const approvals = new Map((state.approvals || []).map(item => [item.task_id, item]));
      const business = new Map((state.businessTasks || []).map(item => [item.task_id, item]));
      setActivities(state.tasks.map(task => ({ ...task, member: task.agent_id, thread: task.room_id, approvalVersion: approvals.get(task.id)?.version, business: business.has(task.id), title: approvals.get(task.id)?.title || business.get(task.id)?.title || task.prompt,
        instructions: task.replies.map((reply, index) => ({ id: index, time: time(reply.created_at), text: reply.body })), detail: approvals.get(task.id)?.detail || business.get(task.id)?.detail || task.result || task.wait_reason || ({ queued: '順番を待っています', running: '実行中です', waiting_child: '仲間の結果を待っています' })[task.state],
        reason: task.wait_reason, status: approvals.has(task.id) ? 'approval' : task.paused ? 'paused' : ({ completed: 'done', failed: 'failed', cancelled: 'canceled', waiting_child: 'waiting', waiting_user: 'waiting', waiting_provider: 'waiting' })[task.state] || 'running', time: time(task.updated_at), steps: [({ queued: '順番を待っています', running: '実行中', waiting_child: '仲間を待っています', waiting_user: '回答を待っています', waiting_provider: '接続を待っています', completed: '完了', failed: '失敗', cancelled: '取り消し' })[task.state]] })));
      setUpdates(savedUpdates.filter(item => item.kind === 'decision').map(item => ({ ...item, member: item.author_id, thread: item.room_id, artifact: item.artifact_id, activity: item.task_id, time: new Date(item.created_at).toLocaleString('ja-JP') })));
      setArtifacts(savedArtifacts.map(item => ({ ...item, member: item.author_id, thread: item.room_id, scope: state.rooms.find(room => room.id === item.room_id)?.visibility, updated: new Date(item.created_at).toLocaleString('ja-JP') })));
      setPaused(state.settings.paused);
      setSchedules(savedSchedules);
      setSettings(current => ({ ...current, maxMembers: state.settings.generatedLimit, unlimited: state.settings.concurrencyLimit === null,
        concurrent: state.settings.concurrencyLimit ?? 3, backupDays: state.settings.backupDays, backupTime: state.settings.backupTime, autonomous: state.settings.autonomous, ollamaUrl: modelSettings.ollamaUrl || '', rules: state.commonRules.body, rulesRevision: state.commonRules.revision }));
      setReady(true);
      setLoadError('');
    } catch (error) { if (version !== refreshVersion.current) return; if (error.status === 401) { setAuthenticated(false); setReady(false); } else { setLoadError('庭を読み込めませんでした。サーバーの接続とバージョンを確認してください。'); notify(error.message); } }
  }
  async function mutate(work, message = '保存しました') {
    try { await work(); await refresh(); notify(message); return true; } catch (error) { notify(error.message); return false; }
  }

  function notify(text) { clearTimeout(toastTimer.current); setToast(text); toastTimer.current = setTimeout(() => setToast(''), 4500); }
  function navigate(next) { setPage(next); window.location.hash = next; }
  function openThread(id) { setScope(threads.find(item => item.id === id)?.archived ? 'archived' : 'all'); setSearch(''); setSelectedThread(id); setThreads(current => current.map(item => item.id === id ? { ...item, unread: 0 } : item)); setMobileDetail(true); navigate('conversation'); }
  function organizeThread(id, field) {
    const value = !threads.find(item => item.id === id)[field];
    return mutate(() => api(`/rooms/${id}/organization`, 'PATCH', { [field]: value }), field === 'pinned' ? (value ? 'スレッドをピン留めしました' : 'ピン留めを解除しました') : (value ? 'アーカイブしました。会話は残っています。' : 'スレッドを戻しました'));
  }
  async function updateMember(id, patch) {
    const { model, effort, profile_version, provider = memberMap[id].provider, ...profile } = patch;
    let version;
    const ok = await mutate(async () => {
      const changed = model && (model !== memberMap[id].model || provider !== memberMap[id].provider || effort !== memberMap[id].effort);
      ({ version } = await api(`/agents/${id}/profile`, 'PATCH', { patch: profile, version: profile_version,
        ...(changed ? { selection: { provider, model, reasoning: provider === 'ollama' ? 'native' : effort } } : {}) }));
    });
    return ok ? version : false;
  }
  const memberRequest = useRef(null);
  async function addMember(draft) {
    const { name, ...profile } = draft;
    const key = JSON.stringify(draft);
    if (memberRequest.current?.key !== key) memberRequest.current = { key, id: crypto.randomUUID() };
    const ok = await mutate(() => api('/agents', 'POST', { id: memberRequest.current.id, name, profile }), '仲間を迎えました');
    if (ok) memberRequest.current = null;
    return ok ? null : '仲間を作成できませんでした。人数上限・接続状態を確認してください。';
  }
  async function openArtifact(id) {
    try { const value = await api(`/artifacts/${id}`); setModal({ type: 'artifact', artifact: { ...artifacts.find(item => item.id === id), ...value } }); } catch (error) { notify(error.message); }
  }
  function controlTask(id, action, body) { return mutate(() => api(`/tasks/${id}/${action}`, 'POST', action === 'instruct' ? { body } : {}), '仕事への操作を保存しました'); }
  function readUpdates(ids) { return mutate(async () => {
    for (let offset = 0; offset < ids.length; offset += 1000) await api('/updates/read', 'POST', { ids: ids.slice(offset, offset + 1000) });
  }, '確認済みにしました'); }
  function openMember(id) { if (memberMap[id]?.deleted) { notify('このBotは削除されています。会話と成果物は引き続き確認できます。'); return; } setSelectedMember(id); navigate('members'); }
  function togglePause() { return mutate(() => api('/settings', 'PATCH', { paused: !paused }), paused ? '活動を再開しました' : '活動を一時停止しました'); }
  async function sendMessage(text, attachments = [], replyTo, selectedRecipients = []) {
    if (selectedRecipients.some(id => memberMap[id]?.deleted)) { notify('指定したBotは削除されています。依頼先を選び直してください。'); return false; }
    if (attachments.length) { notify('添付ファイルの保存はまだ利用できません。'); return false; }
    const body = text;
    const fallback = replyTo && memberMap[replyTo.author] && !memberMap[replyTo.author].deleted ? replyTo.author : thread.scope === 'private' ? thread.members[0] : members.find(item => item.authority === 'leader')?.id;
    const recipients = [...new Set(selectedRecipients.length ? selectedRecipients : fallback ? [fallback] : [])].sort();
    const key = JSON.stringify([thread.id, recipients, body, replyTo?.id]);
    if (submission.current?.key !== key) submission.current = { key, id: crypto.randomUUID() };
    const ok = await mutate(() => api(`/rooms/${thread.id}/messages`, 'POST', { id: submission.current.id, body, ...(replyTo ? { reply_to: replyTo.id } : {}), ...(recipients.length ? { agent_ids: recipients } : {}) }), '送信しました');
    if (ok) submission.current = null;
    return ok;
  }
  async function createThread({ title, text, scope: newScope, member }) {
    const recipient = newScope === 'private' ? member : members.find(item => item.authority === 'leader')?.id;
    const body = { title, body: text, ...(newScope === 'private' ? { participants: [member] } : {}), ...(recipient ? { agent_id: recipient } : {}) };
    const key = JSON.stringify(body);
    if (conversationRequest.current?.key !== key) conversationRequest.current = { key, id: crypto.randomUUID() };
    return mutate(async () => {
      const { room } = await api('/conversations', 'POST', { id: conversationRequest.current.id, ...body });
      conversationRequest.current = null;
      setSelectedThread(room.id); setScope('all'); setSearch(''); setModal(null); setMobileDetail(true); navigate('conversation');
    }, '会話を作成しました');
  }
  function openDM(id) {
    const existing = threads.find(item => item.scope === 'private' && item.members[0] === id);
    if (existing) { openThread(existing.id); return; }
    setModal({ type: 'new-thread', member: id, scope: 'private' });
  }
  function saveMemory(memory, text) {
    return mutate(() => api(`/agents/${memory.member}/memories/${memory.id}`, 'PATCH', { revision: memory.revision, body: text }), '記憶を訂正しました');
  }
  function deleteMemory(memory) {
    return mutate(() => api(`/agents/${memory.member}/memories/${memory.id}`, 'DELETE', { revision: memory.revision }), '記憶を削除しました');
  }
  function saveSettings(next) { return mutate(async () => {
    if (next.rules !== settings.rules) await api('/common-rules', 'PUT', { revision: next.rulesRevision, body: next.rules });
    await api('/settings', 'PATCH', { generatedLimit: Number(next.maxMembers), concurrencyLimit: next.unlimited ? null : Number(next.concurrent), backupDays: Number(next.backupDays), backupTime: next.backupTime, autonomous: next.autonomous });
    if (next.ollamaUrl !== settings.ollamaUrl) await api('/model-settings', 'PATCH', { ollamaUrl: next.ollamaUrl || null });
    setSettings(current => ({ ...current, theme: next.theme }));
  }); }
  const visibleThreads = threads.filter(item => (scope === 'archived' ? item.archived : !item.archived) && (scope === 'all' || scope === 'archived' || item.scope === scope) && (roomSearch.ids?.has(item.id) || `${item.title} ${item.members.map(id => memberMap[id]?.name).join(' ')}`.toLowerCase().includes(search.toLowerCase()))).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivity - a.lastActivity);
  if (!authenticated) return <Login loading={authenticated === null} onLogin={() => setAuthenticated(true)} />;
  if (!ready) return <main className="login-page">{loadError ? <div><p role="alert">{loadError}</p><button className="button secondary" onClick={() => { setLoadError(''); void refresh(); }}>再試行</button></div> : <p role="status">庭を読み込んでいます…</p>}</main>;

  return <div className={`app-shell page-${page} ${mobileDetail ? 'mobile-detail' : ''}`} data-theme={(page === 'settings' ? previewTheme : null) || settings.theme || 'garden'}>
    <a className="skip-link" href="#main-content">メインコンテンツへ</a>
    <aside className="sidebar" aria-label="ナビゲーションとスレッド">
      <a href="#conversation" className="wordmark" onClick={() => { setMobileDetail(false); navigate('conversation'); }} aria-label="Niwa 会話へ">Niwa</a>
      <nav className="main-nav" aria-label="メインナビゲーション">{navItems.filter(item => item.id !== 'settings').map(({ id, label, icon: Icon }) => <a key={id} href={`#${id}`} className={`nav-link ${page === id ? 'active' : ''}`} aria-current={page === id ? 'page' : undefined} onClick={() => { setPage(id); if (id === 'conversation') setMobileDetail(false); }}><Icon size={25} /><span>{label}</span>{id === 'activity' && pendingCount ? <span className="nav-notice" title={`${pendingCount}件の承認待ち`} /> : null}</a>)}</nav>
      <div className="thread-navigation">
        <div className="sidebar-section-heading"><h2>スレッド</h2><IconButton label="新しいスレッド" onClick={() => setModal({ type: 'new-thread' })}><PlusIcon size={22} /></IconButton></div>
        <div className="search-field"><SearchIcon size={20} /><input type="search" aria-label="スレッドを検索" placeholder="スレッドを検索" value={search} maxLength={200} onChange={e => setSearch(e.target.value)} />{search ? <IconButton label="検索をクリア" onClick={() => setSearch('')}><CloseIcon size={16} /></IconButton> : null}</div>
        <Segmented label="スレッドの公開範囲" options={[{ value: 'all', label: 'すべて' }, { value: 'shared', label: '共有' }, { value: 'private', label: '個別' }, { value: 'archived', label: '保管' }]} value={scope} onChange={setScope} />
        {roomSearch.loading ? <p role="status">検索中…</p> : roomSearch.error ? <p role="alert">会話の検索に失敗しました。{roomSearch.error}</p> : null}<div className="thread-list">{visibleThreads.length ? visibleThreads.map(item => <div key={item.id} className="thread-row"><button type="button" className={`thread-item ${selectedThread === item.id && page === 'conversation' ? 'selected' : ''}`} aria-current={selectedThread === item.id && page === 'conversation' ? 'true' : undefined} onClick={() => openThread(item.id)}>
          <span className="thread-item-top"><strong>{item.pinned ? <PinIcon size={13} aria-label="ピン留め" /> : null}{item.title}{item.scope === 'private' ? <LockIcon size={15} /> : null}</strong><time>{item.time}</time></span>
          <span className="thread-item-bottom"><span>{item.scope === 'private' ? '個別' : '共有'} · {item.members.slice(0, 3).map(id => memberMap[id]?.name).join(' / ')}</span>{item.unread > 0 ? <span className="unread-count" aria-label={`${item.unread}件の未読`}>{item.unread}</span> : <span className="reply-count">{Math.max(0, item.message_count - 1)}</span>}</span>
        </button><div className="thread-quick-actions"><IconButton label={item.pinned ? `${item.title}のピン留めを解除` : `${item.title}をピン留め`} onClick={() => organizeThread(item.id, 'pinned')}><PinIcon size={16} /></IconButton><IconButton label={`${item.title}を削除`} onClick={() => setModal({ type: 'delete-content', kind: 'room', id: item.id, title: item.title })}><TrashIcon size={16} /></IconButton></div></div>) : roomSearch.loading || roomSearch.error ? null : <EmptyState icon={SearchIcon} title="スレッドが見つかりません" action={<button className="text-button" onClick={() => { setSearch(''); setScope('all'); }}>条件をクリア</button>}>言葉や公開範囲を変えてみてください。</EmptyState>}</div>
      </div>
      <div className="sidebar-bottom"><a href="#settings" className={`nav-link ${page === 'settings' ? 'active' : ''}`} aria-current={page === 'settings' ? 'page' : undefined} onClick={() => setPage('settings')}><SettingsIcon size={23} /><span>設定</span></a><button className="preview-label" onClick={async () => { await api('/logout', 'POST', {}); setAuthenticated(false); setReady(false); }}><span className="preview-dot" />ログアウト<InfoIcon size={13} /></button></div>
    </aside>
    {page === 'conversation' && !thread ? <main className="conversation" id="main-content"><EmptyState title="最初の会話を始めましょう" action={<button className="button primary" onClick={() => setModal({ type: 'new-thread' })}>会話を始める</button>}>リーダーと名前や好きなことを話してみてください。</EmptyState></main> : null}
    {page === 'conversation' && thread ? <Conversation onThreadAction={organizeThread} thread={thread} tasks={activities.filter(task => task.thread === thread.id)} onNewSession={() => setModal({ type: 'new-thread', scope: thread.scope, member: thread.members[0] })} members={animatedMembers} memberMap={memberMap} paused={paused} onPause={togglePause} onSend={sendMessage} onAppearance={id => setModal({ type: 'appearance', member: id })} onMember={openMember} onBack={() => setMobileDetail(false)} onArtifact={openArtifact} /> : null}
    {page === 'members' ? <Members onDelete={(id, version) => mutate(() => api('/agents/' + id, 'DELETE', { version }), 'Botを削除しました。会話と成果物は残っています。')} onAdd={addMember} maxMembers={Math.max(1, Number(settings.maxMembers) || 10)} members={animatedMembers} selected={selectedMember} onSelect={setSelectedMember} onUpdate={updateMember} onSaveMemory={saveMemory} onDeleteMemory={deleteMemory} onDM={openDM} paused={paused} /> : null}
    {page === 'activity' ? <Activity onDeleteArtifact={id => { const item = artifacts.find(item => item.id === id); if (item) setModal({ type: 'delete-content', kind: 'artifact', id, title: item.name }); }} onScheduleDelete={id => mutate(() => api(`/schedules/${id}`, 'DELETE'), '予定を削除しました')} schedules={schedules} threads={threads} onScheduleSave={({ id, version, ...body }) => mutate(() => version ? api(`/schedules/${id}`, 'PUT', { ...body, version }) : api('/schedules', 'POST', { ...body, id }), '予定を保存しました')} onScheduleToggle={(id, enabled) => mutate(() => api(`/schedules/${id}`, 'PATCH', { enabled }), enabled ? '予定を再開しました' : '予定を停止しました')} updates={updates} seen={seen} onRead={readUpdates} artifacts={artifacts} filter={activityFilter} onFilter={setActivityFilter} onControl={controlTask} activities={activities} members={memberMap} paused={paused} onPause={togglePause} onDecide={(id, approved, version) => mutate(() => api(`/approvals/${id}`, 'POST', { approved, version }), approved ? '承認して仕事を再開しました' : 'この仕事を見送りました')} onThread={openThread} onArtifact={openArtifact} /> : null}
    {page === 'settings' ? <Settings onPreviewTheme={setPreviewTheme} settings={settings} onSave={saveSettings} paused={paused} onPause={togglePause} members={animatedMembers} /> : null}
    <nav className="mobile-nav" aria-label="モバイルナビゲーション">{navItems.map(({ id, label, icon: Icon }) => <a key={id} href={`#${id}`} className={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined} onClick={() => { setPage(id); if (id === 'conversation') setMobileDetail(false); }}><Icon size={23} /><span>{label}</span>{id === 'activity' && pendingCount ? <span className="nav-notice" /> : null}</a>)}</nav>
    {modal?.type === 'appearance' ? <Modal title={`${memberMap[modal.member].name}のアイコン`} onClose={() => setModal(null)} className="appearance-modal"><AppearanceEditor member={memberMap[modal.member]} onCancel={() => setModal(null)} onSave={async patch => { if (await updateMember(modal.member, patch)) setModal(null); }} /></Modal> : null}
    {modal?.type === 'delete-content' ? <DeleteContentDialog item={modal} onClose={() => setModal(null)} onDelete={item => mutate(() => api(`/${item.kind === 'room' ? 'rooms' : 'artifacts'}/${item.id}`, 'DELETE', {}), '削除しました')} /> : null}
    {modal?.type === 'artifact' ? <ArtifactPreview key={modal.artifact.id} onOpen={openArtifact} onDelete={() => setModal({ type: 'delete-content', kind: 'artifact', id: modal.artifact.id, title: modal.artifact.name })} artifact={modal.artifact} members={memberMap} onClose={() => setModal(null)} onThread={openThread} /> : null}
    {modal?.type === 'new-thread' ? <NewThreadModal members={animatedMembers} initialScope={modal.scope} initialMember={modal.member} onClose={() => setModal(null)} onCreate={createThread} /> : null}
    <div className={`toast ${toast ? 'visible' : ''}`} role="status" aria-live="polite">{toast ? <><CheckCircleIcon size={20} /><span>{toast}</span><IconButton label="通知を閉じる" onClick={() => setToast('')}><CloseIcon size={16} /></IconButton></> : null}</div>
  </div>;
}

function NewThreadModal({ members, initialScope = 'shared', initialMember, onCreate, onClose }) {
  const [scope, setScope] = useState(initialScope);
  const [member, setMember] = useState(initialMember || members[0].id);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return <Modal title="新しいスレッド" onClose={onClose}><form onSubmit={async e => { e.preventDefault(); if (busy || !title.trim() || !text.trim()) return; setBusy(true); try { await onCreate({ title: title.trim(), text: text.trim(), scope, member }); } finally { setBusy(false); } }}>
    <div className="modal-body form-stack"><Segmented label="新しいスレッドの公開範囲" options={[{ value: 'shared', label: 'みんなと共有' }, { value: 'private', label: '個別に話す' }]} value={scope} onChange={setScope} />
      {scope === 'private' ? <label className="field"><span>話す相手</span><select value={member} onChange={e => setMember(e.target.value)}>{members.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
      <p className="scope-note">{scope === 'private' ? <LockIcon size={16} /> : <UsersIcon size={16} />}{scope === 'private' ? 'あなたと選んだBotだけが参加する会話です。' : 'メンバー全員が読んで、自由に参加できます。'}</p>
      <label className="field"><span>話題</span><input autoFocus placeholder="何について話しますか？" maxLength={80} value={title} onChange={e => setTitle(e.target.value)} required /></label>
      <label className="field"><span>最初のメッセージ</span><textarea rows={4} placeholder="気になること、試してみたいことなど…" value={text} onChange={e => setText(e.target.value)} required /></label>
    </div><div className="form-actions"><button type="button" className="button subtle" onClick={onClose}>キャンセル</button><button className="button primary" disabled={busy || !title.trim() || !text.trim()}>スレッドを作成</button></div>
  </form></Modal>;
}
