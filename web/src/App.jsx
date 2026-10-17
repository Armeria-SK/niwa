import {memberWork} from './work-display.js';
import { useEffect, useRef, useState } from 'react';
import { initialSettings, THEMES } from './data.js';
import { api } from './api.js';
import { Login } from './Login.jsx';
import { AppearanceEditor, IconButton, Modal, Segmented, EmptyState, SetupNotice, Sentences } from './components.jsx';
import { modelSetupNotice } from './providers.js';
import { markSeen, readSeen, startSeen, unreadOf, writeSeen } from './unread.js';
import { ChatIcon, UsersIcon, SettingsIcon, SearchIcon, PlusIcon, LockIcon, CloseIcon, InfoIcon, CheckCircleIcon, PinIcon, TodayIcon, RecordsIcon } from './icons.jsx';
import { attentionItems } from './attention.js';
import { parseRoute, routeHash } from './route.js';
import { Today } from './pages/Today.jsx';
import { Conversation } from './pages/Conversation.jsx';
import { Members } from './pages/Members.jsx';
import { Activity } from './pages/Activity.jsx';
import { ArtifactPreview } from './pages/Productivity.jsx';
import { Settings } from './pages/Settings.jsx';
import { DeleteContentDialog } from './ContentActions.jsx';
import { TrashIcon } from './icons.jsx';
import { useRoomSearch } from './useRoomSearch.js';
import { useLiveStream } from './useLiveStream.js';

const navItems = [
  { id: 'today', label: 'きょう', icon: TodayIcon },
  { id: 'conversation', label: '会話', icon: ChatIcon },
  { id: 'bots', label: 'Bot', icon: UsersIcon },
  { id: 'records', label: '記録', icon: RecordsIcon },
  { id: 'settings', label: '設定', icon: SettingsIcon },
];

export function App() {
  // 今いる画面はURL（#のあと）で決まる。戻る・進むや、URLの共有でも同じ画面が開く。
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const page = route.page;
  const [members, setMembers] = useState([]);
  const [deletedMembers, setDeletedMembers] = useState([]);
  const [threads, setThreads] = useState([]);
  const [activities, setActivities] = useState([]);
  const [updates, setUpdates] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [recordTab, setRecordTab] = useState('recap');
  const taskReturn = useRef(null);
  const seen = Object.fromEntries(updates.filter(item => item.seen).map(item => [item.id, true]));
  const [authenticated, setAuthenticated] = useState(null);
  const [ready, setReady] = useState(false);
  const [readyProviders, setReadyProviders] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [offline, setOffline] = useState(false);
  const refreshVersion = useRef(0);
  const submission = useRef(null);
  const previousTasks = useRef(null);
  const celebrationTimers = useRef(new Map());
  const [celebrating, setCelebrating] = useState({});
  const conversationRequest = useRef(null);
  const [settings, setSettings] = useState(() => {
    try { const theme = localStorage.getItem('niwa-theme'); return { ...initialSettings, theme: THEMES.some(item => item.id === theme) ? theme : 'auto' }; }
    catch { return initialSettings; }
  });
  useEffect(() => { try { localStorage.setItem('niwa-theme', settings.theme || 'auto'); } catch { /* Storage can be disabled by the browser. */ } }, [settings.theme]);
  const [previewTheme, setPreviewTheme] = useState(null);
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)'); if (!query) return undefined;
    const follow = event => setPrefersDark(event.matches); query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, []);
  // The theme sits on the document so dialogs, the login page and the browser bar all use the same colors.
  const chosenTheme = (page === 'settings' ? previewTheme : null) || settings.theme || 'auto';
  const resolvedTheme = chosenTheme === 'auto' ? (prefersDark ? 'night' : 'garden') : chosenTheme;
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim() || '#fafaf7');
  }, [resolvedTheme]);
  const [selectedThread, setSelectedThread] = useState(() => { try { return sessionStorage.getItem('niwa-thread') || ''; } catch { return ''; } });
  // スマートフォンでは、URLに会話のIDがあるときだけ一覧ではなく会話そのものを出す。
  const mobileDetail = page === 'conversation' && !!route.id;
  const [scope, setScope] = useState('all');
  const [search, setSearch] = useState('');
  const roomSearch = useRoomSearch(search, threads);
  const [paused, setPaused] = useState(false);
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);
  const threadId = mobileDetail ? route.id : selectedThread;
  const thread = threads.find(item => item.id === threadId) || threads[0];
  const [seenMessages, setSeenMessages] = useState(readSeen);
  // The open conversation is read as messages arrive; on a phone only while it is actually shown, not behind the list.
  useEffect(() => {
    if (!ready) return;
    let next = startSeen(threads, seenMessages);
    const showing = page === 'conversation' && thread && document.visibilityState === 'visible' && (mobileDetail || window.matchMedia('(min-width: 701px)').matches);
    if (showing) next = markSeen(next, thread);
    if (next !== seenMessages) { setSeenMessages(next); writeSeen(next); }
  }, [ready, threads, page, thread, mobileDetail, seenMessages]);
  const animatedMembers = members.map(member => ({ ...member, runtimeMotion: member.status === 'sleeping' || paused ? 'none' : celebrating[member.id] ? 'celebrate' : member.runtimeMotion, activity: paused ? '一時停止中' : member.activity }));
  const memberMap = Object.fromEntries([...deletedMembers, ...animatedMembers].map(item => [item.id, item]));
  const attention = attentionItems({ activities, questions, decisions: updates });
  const waitingOnYou = attention.some(item => item.kind !== 'decisions');

  useEffect(() => { const onHash = () => setRoute(parseRoute(window.location.hash)); window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash); }, []);
  // 前の名前（#activity など）や読めない部分は、今の形のURLに置き換える（履歴は増やさない）。
  const currentHash = routeHash(route);
  useEffect(() => { if (window.location.hash !== currentHash) history.replaceState(null, '', currentHash); }, [currentHash]);
  // 戻る・進むで画面が変わったら、前の画面で開いていた窓（成果物など）は閉じる。
  useEffect(() => { setModal(null); }, [currentHash]);
  useEffect(() => { if (route.page === 'conversation' && route.id) setSelectedThread(route.id); }, [route.page, route.id]);
  useEffect(() => { if (route.page === 'records' && route.tab) setRecordTab(route.tab); }, [route.page, route.tab]);
  useEffect(() => { document.title = `Niwa · ${navItems.find(item => item.id === page)?.label || 'きょう'}`; }, [page]);
  useEffect(() => () => { clearTimeout(toastTimer.current); for (const timer of celebrationTimers.current.values()) clearTimeout(timer); }, []);
  useEffect(() => { try { sessionStorage.setItem('niwa-thread', selectedThread); } catch { /* Optional browser state. */ } }, [selectedThread]);
  useEffect(() => { api('/session').then(result => setAuthenticated(result.authenticated)).catch(() => setAuthenticated(false)); }, []);
  const pushed = useRef({ busy: false, again: false, timer: null, last: 0 });
  // Pushed hints are coalesced: one refresh at a time, at most about once per 0.8 seconds.
  function requestRefresh() {
    const state = pushed.current;
    if (state.busy) { state.again = true; return; }
    if (state.timer) return;
    state.timer = setTimeout(async () => {
      state.timer = null; state.busy = true; state.last = Date.now();
      try { await refresh(); } finally { state.busy = false; if (state.again) { state.again = false; requestRefresh(); } }
    }, Math.max(0, state.last + 800 - Date.now()));
  }
  const live = useLiveStream(!!authenticated && ready, requestRefresh);
  const liveConnected = useRef(false); const pollNow = useRef(null);
  useEffect(() => { const lost = liveConnected.current && !live.connected; liveConnected.current = live.connected; if (lost) pollNow.current?.(); }, [live.connected]);
  useEffect(() => {
    if (!authenticated) return;
    let stopped = false; let timer; let running = false; let failures = 0;
    // Hidden tabs stop polling; failures back off from 2 s to 30 s. While the stream is connected, polling is only a slow safety net.
    async function poll() {
      running = true; clearTimeout(timer);
      try { failures = await refresh() ? 0 : failures + 1; } finally { running = false; }
      if (!stopped && !document.hidden) timer = setTimeout(poll, liveConnected.current ? 30_000 : Math.min(30_000, 2000 * 2 ** failures));
    }
    pollNow.current = () => { if (running || document.hidden) return; clearTimeout(timer); timer = setTimeout(poll, 2000); };
    const onVisibility = () => { if (document.hidden) clearTimeout(timer); else if (!running) void poll(); };
    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) void poll();
    return () => { stopped = true; pollNow.current = null; clearTimeout(timer); clearTimeout(pushed.current.timer); pushed.current.timer = null; document.removeEventListener('visibilitychange', onVisibility); refreshVersion.current++; };
  }, [authenticated]);

  async function refresh() {
    const version = ++refreshVersion.current;
    try {
      const [state, modelSettings, savedUpdates, savedArtifacts, savedSchedules] = await Promise.all([api('/state'), api('/model-settings'), api('/updates'), api('/artifacts'), api('/schedules')]);
      if (version !== refreshVersion.current) return true;
      if (previousTasks.current) for (const task of state.tasks) {
        if (task.state !== 'completed' || previousTasks.current.get(task.id) === 'completed') continue;
        setCelebrating(current => ({ ...current, [task.agent_id]: true }));
        clearTimeout(celebrationTimers.current.get(task.agent_id));
        celebrationTimers.current.set(task.agent_id, setTimeout(() => { setCelebrating(current => ({ ...current, [task.agent_id]: false })); celebrationTimers.current.delete(task.agent_id); }, 900));
      }
      previousTasks.current = new Map(state.tasks.map(task => [task.id, task.state]));
      const time = value => new Date(value).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
      setDeletedMembers((state.deletedAgents || []).map(agent => ({ id: agent.id, name: '削除したBot', deleted: true, shape: 'pebble', color: '#9a9a91', status: 'sleeping', motion: 'none' })));
      setMembers(state.agents.map(agent => ({ ...agent, authority: agent.role, role: agent.profile.role || (agent.role === 'leader' ? 'リーダー' : 'Bot'),
        shape: 'pebble', color: '#61B8A5', persona: '', interests: [], ...agent.profile, effort: agent.reasoning,
        runtimeMotion: memberWork(state.tasks.filter(task=>task.agent_id===agent.id),state.settings.paused,agent.status==='dormant').kind==='running'?'sway':'none', status: agent.status === 'dormant' ? 'sleeping' : 'active', activity:memberWork(state.tasks.filter(task=>task.agent_id===agent.id),state.settings.paused,agent.status==='dormant').activity })));
      setThreads(state.rooms.map(room => ({ ...room, scope: room.visibility, members: room.participants,
        lastActivity: Date.parse(room.last_at) || 0, time: room.last_at ? time(room.last_at) : '',
        day: room.first_at ? new Date(room.first_at).toLocaleDateString('ja-JP') : '' })));
      const approvals = new Map((state.approvals || []).map(item => [item.task_id, item]));
      const business = new Map((state.businessTasks || []).map(item => [item.task_id, item]));
      const businessRoots=new Set(state.tasks.filter(task=>business.has(task.id)).map(task=>task.work_root_id||task.id));
      setActivities(state.tasks.map(task => ({ ...task, member: task.agent_id, thread: task.room_id, approvalVersion: approvals.get(task.id)?.version, business: businessRoots.has(task.work_root_id||task.id), title: approvals.get(task.id)?.title || business.get(task.id)?.title || task.prompt,
        instructions: task.replies.map((reply, index) => ({ id: index, time: time(reply.created_at), text: reply.body })), detail: approvals.get(task.id)?.detail || business.get(task.id)?.detail || task.result || task.wait_reason || ({ queued: '順番を待っています', running: '実行中です', waiting_child: 'ほかのBotの結果を待っています' })[task.state],
        reason: task.wait_reason, status: approvals.has(task.id) ? 'approval' : task.paused ? 'paused' : ({ completed: 'done', failed: 'failed', cancelled: 'canceled', waiting_child: 'waiting', waiting_user: 'waiting', waiting_provider: 'waiting' })[task.state] || 'running', time: time(task.updated_at), steps: [task.progress?.label || ({ queued: '順番を待っています', running: '実行中', waiting_child: 'ほかのBotを待っています', waiting_user: '回答を待っています', waiting_provider: '接続を待っています', completed: '完了', failed: '失敗', cancelled: '中止' })[task.state]] })));
      setUpdates(savedUpdates.filter(item => item.kind === 'decision').map(item => ({ ...item, member: item.author_id, thread: item.room_id, artifact: item.artifact_id, activity: item.task_id, time: new Date(item.created_at).toLocaleString('ja-JP') })));
      setQuestions(savedUpdates.filter(item => item.kind === 'question').map(item => ({ ...item, member: item.author_id, thread: item.room_id, activity: item.task_id })));
      setArtifacts(savedArtifacts.map(item => ({ ...item, member: item.author_id, thread: item.room_id, scope: state.rooms.find(room => room.id === item.room_id)?.visibility, updated: new Date(item.created_at).toLocaleString('ja-JP') })));
      setPaused(state.settings.paused);
      if (THEMES.some(item => item.id === state.settings.theme)) setSettings(current => current.theme === state.settings.theme ? current : { ...current, theme: state.settings.theme });
      setSchedules(savedSchedules);
      api('/model-ready').then(result => { if (version === refreshVersion.current) setReadyProviders(result.providers); }).catch(() => {});
      setSettings(current => ({ ...current, maxMembers: state.settings.generatedLimit, unlimited: state.settings.concurrencyLimit === null,
        concurrent: state.settings.concurrencyLimit ?? 3, backupDays: state.settings.backupDays, backupTime: state.settings.backupTime, backupEnabled: state.settings.backupEnabled, autonomous: state.settings.autonomous, localLlmUrl: modelSettings.localLlmUrl || '', maxParallel: modelSettings.maxParallel ?? 1, rules: state.commonRules.body, rulesRevision: state.commonRules.revision }));
      setReady(true);
      setLoadError(''); setOffline(false);
      return true;
    } catch (error) {
      if (version !== refreshVersion.current) return true;
      if (error.status === 401) { setAuthenticated(false); setReady(false); return true; }
      setLoadError('庭を読み込めませんでした。サーバーの接続とバージョンを確認してください。'); setOffline(true);
      return false;
    }
  }
  async function mutate(work, message = '保存しました') {
    try { await work(); await refresh(); notify(message); return true; } catch (error) { notify(error.message); return false; }
  }

  function notify(text) { clearTimeout(toastTimer.current); setToast(text); toastTimer.current = setTimeout(() => setToast(''), 4500); }
  function navigate(next) { const hash = routeHash(next); setRoute(parseRoute(hash)); if (window.location.hash !== hash) window.location.hash = hash; }
  function openModelSettings() { navigate({ page: 'settings', tab: 'models' }); }
  function openThread(id) { setScope(threads.find(item => item.id === id)?.archived ? 'archived' : 'all'); setSearch(''); setSelectedThread(id); navigate({ page: 'conversation', id }); }
  // 仕事の詳細は記録の上に脇の欄で出す。ほかの画面から開いたときは、閉じるとその画面へ戻る。
  function openTask(id) { taskReturn.current = page === 'records' ? null : route; navigate({ page: 'records', task: id }); }
  function closeTask() {
    // 承認のあとは決めた側と窓の側の両方から呼ばれる。もう仕事を開いていなければ何もしない。
    if (!parseRoute(window.location.hash).task) return;
    const back = taskReturn.current; taskReturn.current = null; navigate(back || { page: 'records', tab: recordTab });
  }
  const shownBot = (members.find(item => item.id === route.id) || members[0])?.id;
  function organizeThread(id, field) {
    const value = !threads.find(item => item.id === id)[field];
    return mutate(() => api(`/rooms/${id}/organization`, 'PATCH', { [field]: value }), field === 'pinned' ? (value ? '会話をピン留めしました' : 'ピン留めを解除しました') : (value ? '保管しました。中身はそのまま残っています。' : '会話を保管から戻しました'));
  }
  async function updateMember(id, patch) {
    const { model, effort, profile_version, provider = memberMap[id].provider, ...profile } = patch;
    let version;
    const ok = await mutate(async () => {
      const changed = model && (model !== memberMap[id].model || provider !== memberMap[id].provider || effort !== memberMap[id].effort);
      ({ version } = await api(`/agents/${id}/profile`, 'PATCH', { patch: profile, version: profile_version,
        ...(changed ? { selection: { provider, model, reasoning: provider === 'local_llm' || provider === 'openai_compatible' ? 'native' : effort } } : {}) }));
    });
    return ok ? version : false;
  }
  const memberRequest = useRef(null);
  async function addMember(draft) {
    const { name, ...profile } = draft;
    const key = JSON.stringify(draft);
    if (memberRequest.current?.key !== key) memberRequest.current = { key, id: crypto.randomUUID() };
    const ok = await mutate(() => api('/agents', 'POST', { id: memberRequest.current.id, name, profile }), 'Botを迎えました');
    if (ok) memberRequest.current = null;
    return ok ? null : 'Botを迎えられませんでした。人数の上限と接続を確かめてください。';
  }
  async function openArtifact(id) {
    try { const value = await api(`/artifacts/${id}`); setModal({ type: 'artifact', artifact: { ...artifacts.find(item => item.id === id), ...value } }); } catch (error) { notify(error.message); }
  }
  function controlTask(id, action, body) { return mutate(() => api(`/tasks/${id}/${action}`, 'POST', action === 'instruct' ? { body } : {}), '仕事への操作を保存しました'); }
  function readUpdates(ids) { return mutate(async () => {
    for (let offset = 0; offset < ids.length; offset += 1000) await api('/updates/read', 'POST', { ids: ids.slice(offset, offset + 1000) });
  }, '確認済みにしました'); }
  function openMember(id) { if (memberMap[id]?.deleted) { notify('このBotは削除されています。会話と成果物は引き続き確認できます。'); return; } navigate({ page: 'bots', id }); }
  function togglePause() { return mutate(() => api('/settings', 'PATCH', { paused: !paused }), paused ? '活動を再開しました' : '活動を一時停止しました'); }
  async function sendMessage(text, attachments = [], replyTo, selectedRecipients = [], requestContext) {
    if (selectedRecipients.some(id => memberMap[id]?.deleted)) { notify('指定したBotは削除されています。依頼先を選び直してください。'); return false; }
    const body = text, files = attachments.map(({ name, content }) => ({ name, content }));
    const fallback = replyTo && memberMap[replyTo.author] && !memberMap[replyTo.author].deleted ? replyTo.author : thread.scope === 'private' ? thread.members[0] : members.find(item => item.authority === 'leader')?.id;
    const recipients = [...new Set(selectedRecipients.length ? selectedRecipients : fallback ? [fallback] : [])].sort();
    const key = JSON.stringify([thread.id, recipients, body, replyTo?.id,requestContext,files]);
    if (submission.current?.key !== key) submission.current = { key, id: crypto.randomUUID() };
    const ok = await mutate(() => api(`/rooms/${thread.id}/messages`, 'POST', { id: submission.current.id, body, ...(files.length ? { attachments: files } : {}), ...(requestContext?{request_context:requestContext}:{}), ...(replyTo ? { reply_to: replyTo.id } : {}), ...(recipients.length ? { agent_ids: recipients } : {}) }), '送信しました');
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
      setSelectedThread(room.id); setScope('all'); setSearch(''); setModal(null); navigate({ page: 'conversation', id: room.id });
    }, '会話を作成しました');
  }
  function openDM(id) {
    const existing = threads.find(item => item.scope === 'private' && item.members[0] === id);
    if (existing) { openThread(existing.id); return; }
    setModal({ type: 'new-thread', member: id, scope: 'private' });
  }
  function saveMemory(memory, text, keepPrevious = false) {
    return mutate(() => api(`/agents/${memory.member}/memories/${memory.id}`, 'PATCH', { revision: memory.revision, body: text, keep_previous: keepPrevious }), '記憶を訂正しました');
  }
  function deleteMemory(memory) {
    return mutate(() => api(`/agents/${memory.member}/memories/${memory.id}`, 'DELETE', { revision: memory.revision }), '記憶を削除しました');
  }
  function saveSettings(next, touched) { return mutate(async () => {
    if (touched.has('rules') && next.rules !== settings.rules) await api('/common-rules', 'PUT', { revision: next.rulesRevision, body: next.rules });
    const patch = { ...(touched.has('maxMembers') ? { generatedLimit: Number(next.maxMembers) } : {}), ...(touched.has('unlimited') || touched.has('concurrent') ? { concurrencyLimit: next.unlimited ? null : Number(next.concurrent) } : {}),
      ...(touched.has('backupDays') ? { backupDays: Number(next.backupDays) } : {}), ...(touched.has('backupTime') ? { backupTime: next.backupTime } : {}),
      ...(touched.has('backupEnabled') ? { backupEnabled: next.backupEnabled } : {}), ...(touched.has('autonomous') ? { autonomous: next.autonomous } : {}),
      ...(touched.has('theme') ? { theme: next.theme } : {}) };
    if (Object.keys(patch).length) await api('/settings', 'PATCH', patch);
    const model = { ...(touched.has('localLlmUrl') ? { localLlmUrl: next.localLlmUrl || null } : {}), ...(touched.has('maxParallel') ? { maxParallel: Number(next.maxParallel) } : {}) };
    if (Object.keys(model).length) await api('/model-settings', 'PATCH', model);
    setSettings(current => ({ ...current, theme: next.theme }));
  }); }
  const leader = members.find(member => member.authority === 'leader');
  const setupNotice = modelSetupNotice(readyProviders, leader);
  // In a conversation, the Bot that answers decides: the partner of a private one, otherwise the leader.
  const threadNotice = thread ? modelSetupNotice(readyProviders, thread.scope === 'private' ? memberMap[thread.members[0]] : leader) : null;
  const unreadCounts = new Map(threads.map(item => [item.id, unreadOf(item, seenMessages)]));
  const visibleThreads = threads.filter(item => (scope === 'archived' ? item.archived : !item.archived) && (scope === 'all' || scope === 'archived' || item.scope === scope) && (roomSearch.ids?.has(item.id) || `${item.title} ${item.members.map(id => memberMap[id]?.name).join(' ')}`.toLowerCase().includes(search.toLowerCase()))).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivity - a.lastActivity);
  if (!authenticated) return <Login loading={authenticated === null} onLogin={() => setAuthenticated(true)} />;
  if (!ready) return <main className="login-page">{loadError ? <div><p role="alert">{loadError}</p><button className="button secondary" onClick={() => { setLoadError(''); void refresh(); }}>再試行</button></div> : <p role="status">庭を読み込んでいます…</p>}</main>;

  return <div className={`app-shell page-${page} ${mobileDetail ? 'mobile-detail' : ''}`} >
    <a className="skip-link" href="#main-content">メインコンテンツへ</a>
    <aside className="sidebar" aria-label="ナビゲーションと会話">
      <a href="#today" className="wordmark" aria-label="Niwa きょうへ">Niwa</a>
      <nav className="main-nav" aria-label="メインナビゲーション">{navItems.filter(item => item.id !== 'settings').map(({ id, label, icon: Icon }) => <a key={id} href={`#${id}`} className={`nav-link ${page === id ? 'active' : ''}`} aria-current={page === id ? 'page' : undefined}><Icon size={25} /><span>{label}</span>{id === 'today' && waitingOnYou ? <span className="nav-notice" title="あなたの番があります" /> : null}</a>)}</nav>
      <div className="thread-navigation">
        <div className="sidebar-section-heading"><h2>会話</h2><IconButton label="新しい会話" onClick={() => setModal({ type: 'new-thread' })}><PlusIcon size={22} /></IconButton></div>
        <div className="search-field"><SearchIcon size={20} /><input type="search" aria-label="会話を検索" placeholder="会話を検索" value={search} maxLength={200} onChange={e => setSearch(e.target.value)} />{search ? <IconButton label="検索をクリア" onClick={() => setSearch('')}><CloseIcon size={16} /></IconButton> : null}</div>
        <Segmented label="会話の公開範囲" options={[{ value: 'all', label: 'すべて' }, { value: 'shared', label: '共有' }, { value: 'private', label: '個別' }, { value: 'archived', label: '保管' }]} value={scope} onChange={setScope} />
        {roomSearch.loading ? <p role="status">検索中…</p> : roomSearch.error ? <p role="alert">会話の検索に失敗しました。{roomSearch.error}</p> : null}<div className="thread-list">{visibleThreads.length ? visibleThreads.map(item => <div key={item.id} className="thread-row"><button type="button" className={`thread-item ${selectedThread === item.id && page === 'conversation' ? 'selected' : ''}`} aria-current={selectedThread === item.id && page === 'conversation' ? 'true' : undefined} onClick={() => openThread(item.id)}>
          <span className="thread-item-top"><strong>{item.pinned ? <PinIcon size={13} aria-label="ピン留め" /> : null}{item.title}{item.scope === 'private' ? <LockIcon size={15} /> : null}</strong><time>{item.time}</time></span>
          <span className="thread-item-bottom"><span>{item.scope === 'private' ? '個別' : '共有'} · {item.members.slice(0, 3).map(id => memberMap[id]?.name).join(' / ')}</span>{unreadCounts.get(item.id) > 0 ? <span className="unread-count" aria-label={`${unreadCounts.get(item.id)}件の未読`}>{unreadCounts.get(item.id)}</span> : <span className="reply-count">{Math.max(0, item.message_count - 1)}</span>}</span>
        </button><div className="thread-quick-actions"><IconButton label={item.pinned ? `${item.title}のピン留めを解除` : `${item.title}をピン留め`} onClick={() => organizeThread(item.id, 'pinned')}><PinIcon size={16} /></IconButton><IconButton label={`${item.title}を削除`} onClick={() => setModal({ type: 'delete-content', kind: 'room', id: item.id, title: item.title })}><TrashIcon size={16} /></IconButton></div></div>) : roomSearch.loading || roomSearch.error ? null : <ThreadListEmpty search={search} scope={scope} onClear={() => { setSearch(''); setScope('all'); }} onShowAll={() => setScope('all')} onCreate={() => setModal({ type: 'new-thread' })} />}</div>
      </div>
      <div className="sidebar-bottom"><a href="#settings" className={`nav-link ${page === 'settings' ? 'active' : ''}`} aria-current={page === 'settings' ? 'page' : undefined}><SettingsIcon size={23} /><span>設定</span></a><button className="preview-label" onClick={async () => { await api('/logout', 'POST', {}); setAuthenticated(false); setReady(false); }}><span className="preview-dot" />ログアウト<InfoIcon size={13} /></button></div>
    </aside>
    {page === 'today' ? <Today notice={setupNotice ? <SetupNotice notice={setupNotice} onConnect={openModelSettings} /> : null} paused={paused} onPause={togglePause} attention={attention} members={animatedMembers} memberMap={memberMap} activities={activities} artifacts={artifacts} decisions={updates} threads={threads} onOpenTask={openTask} onThread={openThread} onRead={readUpdates} onRecap={() => navigate({ page: 'records', tab: 'recap' })} onArtifact={openArtifact} onMember={openMember} onNewThread={() => setModal({ type: 'new-thread' })} /> : null}
    {page === 'conversation' && !thread ? <main className="conversation" id="main-content">{setupNotice ? <EmptyState title={setupNotice.title} action={<button className="button primary" onClick={openModelSettings}>モデルをつなぐ</button>}>{setupNotice.body}</EmptyState> : <EmptyState title="最初の会話を始めましょう" action={<button className="button primary" onClick={() => setModal({ type: 'new-thread' })}>会話を始める</button>}>リーダーと名前や好きなことを話してみてください。</EmptyState>}</main> : null}
    {page === 'conversation' && thread ? <Conversation notice={threadNotice ? <SetupNotice notice={threadNotice} onConnect={openModelSettings} /> : null} onThreadAction={organizeThread} drafts={Object.values(live.drafts).filter(draft => draft.room_id === thread.id)} thread={thread} artifacts={artifacts} tasks={activities.filter(task => task.thread === thread.id)} onNewSession={() => setModal({ type: 'new-thread', scope: thread.scope, member: thread.members[0] })} members={animatedMembers} memberMap={memberMap} paused={paused} onPause={togglePause} onSend={sendMessage} onAppearance={id => setModal({ type: 'appearance', member: id })} onMember={openMember} onBack={() => navigate({ page: 'conversation' })} onArtifact={openArtifact} /> : null}
    {page === 'bots' ? <Members onOpenThread={openThread} onDormant={(id, dormant) => mutate(() => api(`/agents/${id}/dormancy`, 'PATCH', { dormant }), dormant ? '休ませました。記憶と会話はそのままです。' : '呼び戻しました。')} onDelete={(id, version) => mutate(() => api('/agents/' + id, 'DELETE', { version }), 'Botを削除しました。会話と成果物は残っています。')} onAdd={addMember} maxMembers={Math.max(1, Number(settings.maxMembers) || 10)} members={animatedMembers} selected={route.id} tab={route.tab} onSelect={id => navigate({ page: 'bots', id, tab: route.tab })} onTab={tab => navigate({ page: 'bots', id: shownBot, tab })} onUpdate={updateMember} onSaveMemory={saveMemory} onDeleteMemory={deleteMemory} onDM={openDM} paused={paused} /> : null}
    {page === 'records' ? <Activity taskId={route.task} onOpenTask={openTask} onCloseTask={closeTask} onDeleteArtifact={id => { const item = artifacts.find(item => item.id === id); if (item) setModal({ type: 'delete-content', kind: 'artifact', id, title: item.name }); }} onScheduleDelete={id => mutate(() => api(`/schedules/${id}`, 'DELETE'), '定期実行を削除しました')} schedules={schedules} threads={threads} onScheduleSave={({ id, version, ...body }) => mutate(() => version ? api(`/schedules/${id}`, 'PUT', { ...body, version }) : api('/schedules', 'POST', { ...body, id }), '定期実行を保存しました')} onScheduleToggle={(id, enabled) => mutate(() => api(`/schedules/${id}`, 'PATCH', { enabled }), enabled ? '定期実行を再開しました' : '定期実行を一時停止しました')} onScheduleToken={async id => { let issued = null; await mutate(async () => { issued = await api(`/schedules/${id}/token`, 'POST', {}); }, '受付用の鍵を発行しました'); return issued; }} updates={updates} seen={seen} onRead={readUpdates} artifacts={artifacts} filter={route.tab || recordTab} onFilter={tab => navigate({ page: 'records', tab })} onControl={controlTask} activities={activities} members={memberMap} paused={paused} onPause={togglePause} onDecide={(id, approved, version) => mutate(async () => { await api(`/approvals/${id}`, 'POST', { approved, version }); closeTask(); }, approved ? '承認して仕事を再開しました' : 'この仕事を見送りました')} onThread={openThread} onArtifact={openArtifact} /> : null}
    {page === 'settings' ? <Settings tab={route.tab} onTab={tab => navigate({ page: 'settings', tab })} onPreviewTheme={setPreviewTheme} settings={settings} onSave={saveSettings} paused={paused} onPause={togglePause} members={animatedMembers} /> : null}
    <nav className="mobile-nav" aria-label="モバイルナビゲーション">{navItems.map(({ id, label, icon: Icon }) => <a key={id} href={`#${id}`} className={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined}><Icon size={23} /><span>{label}</span>{id === 'today' && waitingOnYou ? <span className="nav-notice" /> : null}</a>)}</nav>
    {modal?.type === 'appearance' ? <Modal title={`${memberMap[modal.member].name}のアイコン`} onClose={() => setModal(null)} className="appearance-modal"><AppearanceEditor member={memberMap[modal.member]} onCancel={() => setModal(null)} onSave={async patch => { if (await updateMember(modal.member, patch)) setModal(null); }} /></Modal> : null}
    {modal?.type === 'delete-content' ? <DeleteContentDialog item={modal} onClose={() => setModal(null)} onDelete={item => mutate(() => api(`/${item.kind === 'room' ? 'rooms' : 'artifacts'}/${item.id}`, 'DELETE', {}), '削除しました')} /> : null}
    {modal?.type === 'artifact' ? <ArtifactPreview key={modal.artifact.id} onOpen={openArtifact} onDelete={() => setModal({ type: 'delete-content', kind: 'artifact', id: modal.artifact.id, title: modal.artifact.name })} artifact={modal.artifact} members={memberMap} onClose={() => setModal(null)} onThread={openThread} /> : null}
    {modal?.type === 'new-thread' ? <NewThreadModal members={animatedMembers} initialScope={modal.scope} initialMember={modal.member} onClose={() => setModal(null)} onCreate={createThread} /> : null}
    {offline ? <div className="offline-notice" role="alert">サーバーに接続できません。<br />つながるまで自動で再試行します。</div> : null}
    <div className={`toast ${toast ? 'visible' : ''}`} role="status" aria-live="polite">{toast ? <><CheckCircleIcon size={20} /><span><Sentences>{toast}</Sentences></span><IconButton label="通知を閉じる" onClick={() => setToast('')}><CloseIcon size={16} /></IconButton></> : null}</div>
  </div>;
}

/** Only a search can hide threads; an empty scope or a first start says how to begin instead of asking to change the search. */
function ThreadListEmpty({ search, scope, onClear, onShowAll, onCreate }) {
  if (search.trim()) return <EmptyState icon={SearchIcon} title="会話が見つかりません" action={<button className="text-button" onClick={onClear}>条件をクリア</button>}>言葉や公開範囲を変えてみてください。</EmptyState>;
  if (scope === 'archived') return <EmptyState icon={InfoIcon} title="保管した会話はありません">会話を保管すると、ここに並びます。</EmptyState>;
  if (scope !== 'all') return <EmptyState icon={ChatIcon} title={`${scope === 'shared' ? '共有' : '個別'}の会話はまだありません`} action={<button className="text-button" onClick={onShowAll}>すべてを表示</button>} />;
  return <EmptyState icon={ChatIcon} title="まだ会話がありません" action={<button className="text-button" onClick={onCreate}>新しい会話を始める</button>}>Botと話す場所です。<br />＋からも作れます。</EmptyState>;
}

function NewThreadModal({ members, initialScope = 'shared', initialMember, onCreate, onClose }) {
  const [scope, setScope] = useState(initialScope);
  const [member, setMember] = useState(initialMember || members[0].id);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return <Modal title="新しい会話" onClose={onClose}><form onSubmit={async e => { e.preventDefault(); if (busy || !title.trim() || !text.trim()) return; setBusy(true); try { await onCreate({ title: title.trim(), text: text.trim(), scope, member }); } finally { setBusy(false); } }}>
    <div className="modal-body form-stack"><Segmented label="新しい会話の公開範囲" options={[{ value: 'shared', label: 'みんなと共有' }, { value: 'private', label: '個別に話す' }]} value={scope} onChange={setScope} />
      {scope === 'private' ? <label className="field"><span>話す相手</span><select value={member} onChange={e => setMember(e.target.value)}>{members.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
      <p className="scope-note">{scope === 'private' ? <LockIcon size={16} /> : <UsersIcon size={16} />}{scope === 'private' ? 'あなたと選んだBotだけが参加する会話です。' : 'すべてのBotが読んで、自由に参加できます。'}</p>
      <label className="field"><span>話題</span><input autoFocus placeholder="何について話しますか？" maxLength={80} value={title} onChange={e => setTitle(e.target.value)} required /></label>
      <label className="field"><span>最初のメッセージ</span><textarea rows={4} placeholder="気になること、試してみたいことなど…" value={text} onChange={e => setText(e.target.value)} required /></label>
    </div><div className="form-actions"><button type="button" className="button subtle" onClick={onClose}>やめる</button><button className="button primary" disabled={busy || !title.trim() || !text.trim()}>会話を始める</button></div>
  </form></Modal>;
}
