import {memberWork} from './work-display.js';
import { stateMotion } from './avatar.js';
import { useEffect, useRef, useState } from 'react';
import { initialSettings, THEMES } from './data.js';
import { api } from './api.js';
import { AppearanceEditor, Avatar, IconButton, Modal, Segmented, EmptyState, SetupNotice, Sentences } from './components.jsx';
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
import { CommandPalette } from './CommandPalette.jsx';
import { useRoomSearch } from './useRoomSearch.js';
import { useLiveStream } from './useLiveStream.js';
import { isLanguage, locale, serverText, t } from './i18n.js';
import { applyLanguage, rememberedLanguage, useLanguage } from './i18n-react.js';

// 名前は今の言語で読む（getter にして、言語を切り替えると変わるようにする）。
const navItems = [
  { id: 'today', get label() { return t('shell.navToday'); }, icon: TodayIcon },
  { id: 'conversation', get label() { return t('shell.navConversation'); }, icon: ChatIcon },
  { id: 'bots', get label() { return t('shell.navBots'); }, icon: UsersIcon },
  { id: 'records', get label() { return t('shell.navRecords'); }, icon: RecordsIcon },
  { id: 'settings', get label() { return t('shell.navSettings'); }, icon: SettingsIcon },
];
/** 会話の一覧の小さなアイコンの置き方。参加しているBotの数（1〜3体）ごとに決める。 */
const MINI_POSITIONS = { 1: [{ left: 5, top: 5, size: 28 }], 2: [{ left: 2, top: 3, size: 20 }, { left: 16, top: 15, size: 20 }], 3: [{ left: 1, top: 2, size: 19 }, { left: 18, top: 2, size: 19 }, { left: 9.5, top: 17, size: 19 }] };

export function App() {
  // 今いる画面はURL（#のあと）で決まる。戻る・進むや、URLの共有でも同じ画面が開く。
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const page = route.page;
  // 設定は今の画面の上に重ねて開く。後ろに見せるのは、設定を開く前にいた画面。
  const backRoute = useRef(page === 'settings' ? { page: 'today' } : route);
  if (page !== 'settings') backRoute.current = route;
  const view = page === 'settings' ? backRoute.current : route;
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
  const [ready, setReady] = useState(false);
  const [readyProviders, setReadyProviders] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [offline, setOffline] = useState(false);
  const refreshVersion = useRef(0);
  const submission = useRef(null);
  const previousTasks = useRef(null);
  const celebrationTimers = useRef(new Map());
  const [celebrating, setCelebrating] = useState({});
  const conversationRequest = useRef(null);
  const [settings, setSettings] = useState(() => {
    try { const theme = localStorage.getItem('niwa-theme'); return { ...initialSettings, theme: THEMES.some(item => item.id === theme) ? theme : 'auto', language: rememberedLanguage() }; }
    catch { return initialSettings; }
  });
  useEffect(() => { try { localStorage.setItem('niwa-theme', settings.theme || 'auto'); } catch { /* Storage can be disabled by the browser. */ } }, [settings.theme]);
  const [previewTheme, setPreviewTheme] = useState(null);
  // 言語もテーマと同じく、設定で選ぶとすぐ全画面に映し、保存せずに閉じると元に戻す。切り替わると useLanguage が画面全体を描き直す。
  const currentLanguage = useLanguage();
  const [previewLanguage, setPreviewLanguage] = useState(null);
  const chosenLanguage = (page === 'settings' ? previewLanguage : null) || settings.language || 'ja';
  useEffect(() => { void applyLanguage(chosenLanguage); }, [chosenLanguage]);
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
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim() || '#f4f3ee');
  }, [resolvedTheme]);
  const [selectedThread, setSelectedThread] = useState(() => { try { return sessionStorage.getItem('niwa-thread') || ''; } catch { return ''; } });
  // スマートフォンでは、URLに会話のIDがあるときだけ一覧ではなく会話そのものを出す。
  const mobileDetail = view.page === 'conversation' && !!view.id;
  const [scope, setScope] = useState('all');
  const [search, setSearch] = useState('');
  const roomSearch = useRoomSearch(search, threads);
  const [paused, setPaused] = useState(false);
  const [modal, setModal] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [toastOut, setToastOut] = useState(false);
  const toastTimers = useRef([]);
  const threadId = mobileDetail ? view.id : selectedThread;
  const thread = threads.find(item => item.id === threadId) || threads[0];
  const [seenMessages, setSeenMessages] = useState(readSeen);
  // The open conversation is read as messages arrive; on a phone only while it is actually shown, not behind the list.
  useEffect(() => {
    if (!ready) return;
    let next = startSeen(threads, seenMessages);
    const showing = view.page === 'conversation' && thread && document.visibilityState === 'visible' && (mobileDetail || window.matchMedia('(min-width: 701px)').matches);
    if (showing) next = markSeen(next, thread);
    if (next !== seenMessages) { setSeenMessages(next); writeSeen(next); }
  }, [ready, threads, view.page, thread, mobileDetail, seenMessages]);
  const animatedMembers = members.map(member => ({ ...member, runtimeMotion: celebrating[member.id] ? 'celebrate' : member.runtimeMotion, activity: paused ? t('shell.statusPaused') : member.activity }));
  const memberMap = Object.fromEntries([...deletedMembers, ...animatedMembers].map(item => [item.id, item]));
  const attention = attentionItems({ activities, questions, decisions: updates });
  const waitingCount = attention.filter(item => item.kind !== 'decisions').length;

  useEffect(() => { const onHash = () => setRoute(parseRoute(window.location.hash)); window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash); }, []);
  // 前の名前（#activity など）や読めない部分は、今の形のURLに置き換える（履歴は増やさない）。
  const currentHash = routeHash(route);
  useEffect(() => { if (window.location.hash !== currentHash) history.replaceState(null, '', currentHash); }, [currentHash]);
  // 戻る・進むで画面が変わったら、前の画面で開いていた窓（成果物など）は閉じる。
  useEffect(() => { setModal(null); }, [currentHash]);
  useEffect(() => { if (route.page === 'conversation' && route.id) setSelectedThread(route.id); }, [route.page, route.id]);
  useEffect(() => { if (route.page === 'records' && route.tab) setRecordTab(route.tab); }, [route.page, route.tab]);
  useEffect(() => { document.title = `Niwa · ${navItems.find(item => item.id === page)?.label || t('shell.navToday')}`; }, [page, currentLanguage]);
  useEffect(() => () => { for (const timer of toastTimers.current) clearTimeout(timer); for (const timer of celebrationTimers.current.values()) clearTimeout(timer); }, []);
  useEffect(() => { try { sessionStorage.setItem('niwa-thread', selectedThread); } catch { /* Optional browser state. */ } }, [selectedThread]);
  // Ctrl / ⌘ + K で、どの画面からでも「探す」窓を開く。
  useEffect(() => {
    const onKey = event => { if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen(open => !open); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
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
  const live = useLiveStream(ready, requestRefresh);
  const liveConnected = useRef(false); const pollNow = useRef(null);
  useEffect(() => { const lost = liveConnected.current && !live.connected; liveConnected.current = live.connected; if (lost) pollNow.current?.(); }, [live.connected]);
  // ログインはない（持ち主だけが開けるネットワークで使う）。開いたらすぐ読み込みを始める。
  useEffect(() => {
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
  }, []);

  async function refresh() {
    const version = ++refreshVersion.current;
    try {
      const [state, savedUpdates, savedArtifacts, savedSchedules] = await Promise.all([api('/state'), api('/updates'), api('/artifacts'), api('/schedules')]);
      if (version !== refreshVersion.current) return true;
      if (previousTasks.current) for (const task of state.tasks) {
        if (task.state !== 'completed' || previousTasks.current.get(task.id) === 'completed') continue;
        setCelebrating(current => ({ ...current, [task.agent_id]: true }));
        clearTimeout(celebrationTimers.current.get(task.agent_id));
        celebrationTimers.current.set(task.agent_id, setTimeout(() => { setCelebrating(current => ({ ...current, [task.agent_id]: false })); celebrationTimers.current.delete(task.agent_id); }, 900));
      }
      previousTasks.current = new Map(state.tasks.map(task => [task.id, task.state]));
      // 日時と画面の言葉は、読むたびに今の言語で作る（getter）。言語を切り替えると、読み直しを待たずにすぐ変わる。
      const time = value => new Date(value).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
      setDeletedMembers((state.deletedAgents || []).map(agent => ({ id: agent.id, get name() { return t('shell.deletedBot'); }, deleted: true, shape: 'pebble', color: '#9a9a91', status: 'sleeping', motion: 'none' })));
      setMembers(state.agents.map(agent => {
        const work = () => memberWork(state.tasks.filter(task => task.agent_id === agent.id), state.settings.paused, agent.status === 'dormant');
        return { ...agent, authority: agent.role, get role() { return agent.profile.role || (agent.role === 'leader' ? t('shell.roleLeader') : t('shell.roleBot')); },
          shape: 'pebble', color: '#61B8A5', persona: '', interests: [], ...agent.profile, effort: agent.reasoning,
          runtimeMotion: stateMotion(work().kind), status: agent.status === 'dormant' ? 'sleeping' : 'active', get activity() { return work().activity; } };
      }));
      setThreads(state.rooms.map(room => ({ ...room, get title() { return serverText(room.title); }, scope: room.visibility, members: room.participants,
        lastActivity: Date.parse(room.last_at) || 0, get time() { return room.last_at ? time(room.last_at) : ''; },
        get day() { return room.first_at ? new Date(room.first_at).toLocaleDateString(locale()) : ''; } })));
      const approvals = new Map((state.approvals || []).map(item => [item.task_id, item]));
      const business = new Map((state.businessTasks || []).map(item => [item.task_id, item]));
      const businessRoots=new Set(state.tasks.filter(task=>business.has(task.id)).map(task=>task.work_root_id||task.id));
      // サーバーの進み具合（task.progress.label）や待っている理由が無いときに出す、状態ごとの言葉の名前。
      const detailOf = { queued: 'shell.taskQueued', running: 'shell.taskRunning', waiting_child: 'shell.taskWaitingChild' };
      const stepOf = { queued: 'shell.taskQueued', running: 'shell.stepRunning', waiting_child: 'shell.stepWaitingChild', waiting_user: 'shell.stepWaitingUser', waiting_provider: 'shell.stepWaitingProvider', completed: 'shell.stepCompleted', failed: 'shell.stepFailed', cancelled: 'shell.stepCancelled' };
      const stateText = (keys, kind) => Object.hasOwn(keys, kind) ? t(keys[kind]) : undefined;
      setActivities(state.tasks.map(task => ({ ...task, member: task.agent_id, thread: task.room_id, approvalVersion: approvals.get(task.id)?.version, business: businessRoots.has(task.work_root_id||task.id), title: approvals.get(task.id)?.title || business.get(task.id)?.title || task.prompt,
        instructions: task.replies.map((reply, index) => ({ id: index, get time() { return time(reply.created_at); }, text: reply.body })),
        get detail() { return approvals.get(task.id)?.detail || business.get(task.id)?.detail || task.result || serverText(task.wait_reason) || stateText(detailOf, task.state); },
        reason: task.wait_reason, status: approvals.has(task.id) ? 'approval' : task.paused ? 'paused' : ({ completed: 'done', failed: 'failed', cancelled: 'canceled', waiting_child: 'waiting', waiting_user: 'waiting', waiting_provider: 'waiting' })[task.state] || 'running', get time() { return time(task.updated_at); },
        get steps() { return [serverText(task.progress?.label) || stateText(stepOf, task.state)]; } })));
      setUpdates(savedUpdates.filter(item => item.kind === 'decision').map(item => ({ ...item, member: item.author_id, thread: item.room_id, artifact: item.artifact_id, activity: item.task_id, get time() { return new Date(item.created_at).toLocaleString(locale()); } })));
      setQuestions(savedUpdates.filter(item => item.kind === 'question').map(item => ({ ...item, member: item.author_id, thread: item.room_id, activity: item.task_id })));
      setArtifacts(savedArtifacts.map(item => ({ ...item, member: item.author_id, thread: item.room_id, scope: state.rooms.find(room => room.id === item.room_id)?.visibility, get updated() { return new Date(item.created_at).toLocaleString(locale()); } })));
      setPaused(state.settings.paused);
      if (THEMES.some(item => item.id === state.settings.theme)) setSettings(current => current.theme === state.settings.theme ? current : { ...current, theme: state.settings.theme });
      if (isLanguage(state.settings.language)) setSettings(current => current.language === state.settings.language ? current : { ...current, language: state.settings.language });
      setSchedules(savedSchedules);
      api('/model-ready').then(result => { if (version === refreshVersion.current) setReadyProviders(result.providers); }).catch(() => {});
      setSettings(current => ({ ...current, maxMembers: state.settings.generatedLimit, unlimited: state.settings.concurrencyLimit === null,
        concurrent: state.settings.concurrencyLimit ?? 3, backupDays: state.settings.backupDays, backupTime: state.settings.backupTime, backupEnabled: state.settings.backupEnabled, autonomous: state.settings.autonomous, rules: state.commonRules.body, rulesRevision: state.commonRules.revision }));
      setReady(true);
      setLoadError(false); setOffline(false);
      return true;
    } catch (error) {
      if (version !== refreshVersion.current) return true;
      setLoadError(true); setOffline(true);
      return false;
    }
  }
  async function mutate(work, message = t('common.saved')) {
    try { await work(); await refresh(); notify(message); return true; } catch (error) { notify(error.message); return false; }
  }

  // 知らせは弾んで現れ、細い線で残り時間を見せてから、さっと下がる。
  function notify(text) {
    for (const timer of toastTimers.current) clearTimeout(timer);
    setToast({ text, key: Date.now() }); setToastOut(false);
    toastTimers.current = [setTimeout(() => setToastOut(true), 4300), setTimeout(() => { setToast(null); setToastOut(false); }, 4560)];
  }
  function dismissToast() { for (const timer of toastTimers.current) clearTimeout(timer); setToastOut(true); toastTimers.current = [setTimeout(() => { setToast(null); setToastOut(false); }, 260)]; }
  function navigate(next) { const hash = routeHash(next); setRoute(parseRoute(hash)); if (window.location.hash !== hash) window.location.hash = hash; }
  function openModelSettings() { navigate({ page: 'settings', tab: 'models' }); }
  function openThread(id) { setScope(threads.find(item => item.id === id)?.archived ? 'archived' : 'all'); setSearch(''); setSelectedThread(id); navigate({ page: 'conversation', id }); }
  // 仕事の詳細は記録の上に脇の欄で出す。ほかの画面から開いたときは、閉じるとその画面へ戻る。
  function openTask(id) { taskReturn.current = view.page === 'records' ? null : view; navigate({ page: 'records', task: id }); }
  function closeTask() {
    // 承認のあとは決めた側と窓の側の両方から呼ばれる。もう仕事を開いていなければ何もしない。
    if (!parseRoute(window.location.hash).task) return;
    const back = taskReturn.current; taskReturn.current = null; navigate(back || { page: 'records', tab: recordTab });
  }
  const shownBot = view.id === 'everyone' ? 'everyone' : (members.find(item => item.id === view.id) || members[0])?.id;
  function organizeThread(id, field) {
    const value = !threads.find(item => item.id === id)[field];
    return mutate(() => api(`/rooms/${id}/organization`, 'PATCH', { [field]: value }), field === 'pinned' ? (value ? t('shell.threadPinned') : t('shell.threadUnpinned')) : (value ? t('shell.threadArchived') : t('shell.threadRestored')));
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
    const ok = await mutate(() => api('/agents', 'POST', { id: memberRequest.current.id, name, profile }), t('shell.botAdded'));
    if (ok) memberRequest.current = null;
    return ok ? null : t('shell.botAddFailed');
  }
  // ファイルから迎えたBotは、一覧を読み直してから、そのBotのプロフィールを開く。
  async function importedBot(made) {
    await refresh();
    notify(made.room_id ? t('shell.botImportedWithRoom') : t('shell.botImported'));
    navigate({ page: 'bots', id: made.agent_id, tab: 'profile' });
  }
  async function openArtifact(id) {
    try { const value = await api(`/artifacts/${id}`); setModal({ type: 'artifact', artifact: { ...artifacts.find(item => item.id === id), ...value } }); } catch (error) { notify(error.message); }
  }
  function controlTask(id, action, body) { return mutate(() => api(`/tasks/${id}/${action}`, 'POST', action === 'instruct' ? { body } : {}), t('shell.taskControlSaved')); }
  function readUpdates(ids) { return mutate(async () => {
    for (let offset = 0; offset < ids.length; offset += 1000) await api('/updates/read', 'POST', { ids: ids.slice(offset, offset + 1000) });
  }, t('shell.markedRead')); }
  function openMember(id) { if (memberMap[id]?.deleted) { notify(t('shell.botDeletedNotice')); return; } navigate({ page: 'bots', id }); }
  function togglePause() { return mutate(() => api('/settings', 'PATCH', { paused: !paused }), paused ? t('shell.activityResumed') : t('shell.activityPaused')); }
  async function sendMessage(text, attachments = [], replyTo, selectedRecipients = [], requestContext) {
    if (selectedRecipients.some(id => memberMap[id]?.deleted)) { notify(t('shell.recipientDeleted')); return false; }
    const body = text, files = attachments.map(({ name, content }) => ({ name, content }));
    const fallback = replyTo && memberMap[replyTo.author] && !memberMap[replyTo.author].deleted ? replyTo.author : thread.scope === 'private' ? thread.members[0] : members.find(item => item.authority === 'leader')?.id;
    const recipients = [...new Set(selectedRecipients.length ? selectedRecipients : fallback ? [fallback] : [])].sort();
    const key = JSON.stringify([thread.id, recipients, body, replyTo?.id,requestContext,files]);
    if (submission.current?.key !== key) submission.current = { key, id: crypto.randomUUID() };
    const ok = await mutate(() => api(`/rooms/${thread.id}/messages`, 'POST', { id: submission.current.id, body, ...(files.length ? { attachments: files } : {}), ...(requestContext?{request_context:requestContext}:{}), ...(replyTo ? { reply_to: replyTo.id } : {}), ...(recipients.length ? { agent_ids: recipients } : {}) }), t('shell.messageSent'));
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
    }, t('shell.threadCreated'));
  }
  function openDM(id) {
    const existing = threads.find(item => item.scope === 'private' && item.members[0] === id);
    if (existing) { openThread(existing.id); return; }
    setModal({ type: 'new-thread', member: id, scope: 'private' });
  }
  function saveMemory(memory, text, keepPrevious = false) {
    return mutate(() => api(`/agents/${memory.member}/memories/${memory.id}`, 'PATCH', { revision: memory.revision, body: text, keep_previous: keepPrevious }), t('shell.memoryCorrected'));
  }
  function deleteMemory(memory) {
    return mutate(() => api(`/agents/${memory.member}/memories/${memory.id}`, 'DELETE', { revision: memory.revision }), t('shell.memoryDeleted'));
  }
  function saveSettings(next, touched) { return mutate(async () => {
    if (touched.has('rules') && next.rules !== settings.rules) await api('/common-rules', 'PUT', { revision: next.rulesRevision, body: next.rules });
    const patch = { ...(touched.has('maxMembers') ? { generatedLimit: Number(next.maxMembers) } : {}), ...(touched.has('unlimited') || touched.has('concurrent') ? { concurrencyLimit: next.unlimited ? null : Number(next.concurrent) } : {}),
      ...(touched.has('backupDays') ? { backupDays: Number(next.backupDays) } : {}), ...(touched.has('backupTime') ? { backupTime: next.backupTime } : {}),
      ...(touched.has('backupEnabled') ? { backupEnabled: next.backupEnabled } : {}), ...(touched.has('autonomous') ? { autonomous: next.autonomous } : {}),
      ...(touched.has('theme') ? { theme: next.theme } : {}), ...(touched.has('language') ? { language: next.language } : {}) };
    if (Object.keys(patch).length) await api('/settings', 'PATCH', patch);
    setSettings(current => ({ ...current, theme: next.theme, language: next.language }));
  }); }
  const leader = members.find(member => member.authority === 'leader');
  const setupNotice = modelSetupNotice(readyProviders, leader);
  // In a conversation, the Bot that answers decides: the partner of a private one, otherwise the leader.
  const threadNotice = thread ? modelSetupNotice(readyProviders, thread.scope === 'private' ? memberMap[thread.members[0]] : leader) : null;
  const unreadCounts = new Map(threads.map(item => [item.id, unreadOf(item, seenMessages)]));
  const visibleThreads = threads.filter(item => (scope === 'archived' ? item.archived : !item.archived) && (scope === 'all' || scope === 'archived' || item.scope === scope) && (roomSearch.ids?.has(item.id) || `${item.title} ${item.members.map(id => memberMap[id]?.name).join(' ')}`.toLowerCase().includes(search.toLowerCase()))).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivity - a.lastActivity);
  if (!ready) return <main className="login-page">{loadError ? <div><p role="alert">{t('shell.loadError')}</p><button className="button secondary" onClick={() => { setLoadError(false); void refresh(); }}>{t('common.retry')}</button></div> : <p role="status" className="loading-garden">{t('shell.loadingGarden')}</p>}</main>;
  const pinnedThreads = visibleThreads.filter(item => item.pinned && scope !== 'archived'), otherThreads = visibleThreads.filter(item => !item.pinned || scope === 'archived');
  const threadRow = item => <div key={item.id} className="thread-row"><button type="button" className={`thread-item ${selectedThread === item.id && view.page === 'conversation' ? 'selected' : ''}`} aria-current={selectedThread === item.id && view.page === 'conversation' ? 'true' : undefined} onClick={() => openThread(item.id)}>
    <span className="thread-avatars" aria-hidden="true">{item.members.slice(0, 3).map((id, index, list) => { const at = MINI_POSITIONS[list.length][index]; return memberMap[id] ? <span key={id} style={{ left: at.left, top: at.top }}><Avatar member={memberMap[id]} motion="none" size={at.size} /></span> : null; })}</span>
    <span className="thread-item-main">
      <span className="thread-item-top"><strong>{item.pinned ? <PinIcon size={13} aria-label={t('shell.pinned')} /> : null}{item.title}{item.scope === 'private' ? <LockIcon size={14} /> : null}</strong><time>{item.time}</time></span>
      <span className="thread-item-bottom"><span>{item.scope === 'private' ? t('shell.scopePrivate') : t('shell.scopeShared')} · {item.members.slice(0, 3).map(id => memberMap[id]?.name).join(' / ')}</span>{unreadCounts.get(item.id) > 0 ? <span className="unread-count" aria-label={t('shell.unreadCount', { count: unreadCounts.get(item.id) })}>{unreadCounts.get(item.id)}</span> : <span className="reply-count">{Math.max(0, item.message_count - 1)}</span>}</span>
    </span>
  </button><div className="thread-quick-actions"><IconButton label={item.pinned ? t('shell.unpinThread', { title: item.title }) : t('shell.pinThread', { title: item.title })} onClick={() => organizeThread(item.id, 'pinned')}><PinIcon size={16} /></IconButton><IconButton label={t('shell.deleteThread', { title: item.title })} onClick={() => setModal({ type: 'delete-content', kind: 'room', id: item.id, title: item.title })}><TrashIcon size={16} /></IconButton></div></div>;

  return <div className={`app-shell page-${view.page} ${mobileDetail ? 'mobile-detail' : ''} ${page === 'settings' ? 'settings-open' : ''}`} >
    <a className="skip-link" href="#main-content">{t('shell.skipToContent')}</a>
    <nav className="rail" aria-label={t('shell.mainNavigation')}>
      <a href="#today" className="rail-logo" aria-label={t('shell.logoLabel')}><Avatar shape="pebble" color="currentColor" size={34} /><span>Niwa</span></a>
      {navItems.filter(item => item.id !== 'settings').map(({ id, label, icon: Icon }) => <a key={id} href={`#${id}`} className={`rail-item ${view.page === id ? 'active' : ''}`} aria-current={view.page === id ? 'page' : undefined} aria-label={id === 'today' && waitingCount ? t('shell.navTodayWaiting', { label, count: waitingCount }) : undefined}><Icon size={22} /><span>{label}</span>{id === 'today' && waitingCount ? <span className="rail-badge" aria-hidden="true">{waitingCount}</span> : null}</a>)}
      <span className="rail-gap" />
      <button type="button" className="rail-item" onClick={() => setPaletteOpen(true)} aria-label={t('shell.searchShortcut')} title={t('shell.searchShortcut')}><SearchIcon size={22} /><span>{t('shell.search')}</span></button>
      <button type="button" className={`rail-orb ${paused ? 'paused' : ''}`} onClick={togglePause} aria-pressed={paused} aria-label={paused ? t('shell.resumeBots') : t('shell.pauseBots')} title={paused ? t('shell.resumeBots') : t('shell.pauseBots')}><span className="rail-orb-dot" aria-hidden="true" /><span>{paused ? t('shell.orbPaused') : t('shell.orbActive')}</span></button>
      <a href="#settings" className={`rail-item ${page === 'settings' ? 'active' : ''}`} aria-current={page === 'settings' ? 'page' : undefined}><SettingsIcon size={22} /><span>{t('shell.navSettings')}</span></a>
    </nav>
    {view.page === 'conversation' ? <aside className="sidebar" aria-label={t('shell.threadListLabel')}>
      <div className="thread-navigation">
        <div className="sidebar-section-heading"><h2>{t('shell.navConversation')}</h2><IconButton label={t('shell.newThread')} onClick={() => setModal({ type: 'new-thread' })}><PlusIcon size={22} /></IconButton></div>
        <div className="search-field"><SearchIcon size={18} /><input type="search" aria-label={t('shell.searchThreads')} placeholder={t('shell.searchThreads')} value={search} maxLength={200} onChange={e => setSearch(e.target.value)} />{search ? <IconButton label={t('shell.clearSearch')} onClick={() => setSearch('')}><CloseIcon size={16} /></IconButton> : <button type="button" className="kbd-hint" onClick={() => setPaletteOpen(true)} aria-label={t('shell.openSearchShortcut')}>Ctrl K</button>}</div>
        <Segmented label={t('shell.threadScopeLabel')} options={[{ value: 'all', label: t('shell.scopeAll') }, { value: 'shared', label: t('shell.scopeShared') }, { value: 'private', label: t('shell.scopePrivate') }, { value: 'archived', label: t('shell.scopeArchived') }]} value={scope} onChange={setScope} />
        {roomSearch.loading ? <p role="status">{t('shell.searching')}</p> : roomSearch.error ? <p role="alert">{t('shell.searchFailed', { error: roomSearch.error })}</p> : null}<div className="thread-list">{visibleThreads.length ? <>
          {pinnedThreads.length ? <><h2 className="thread-group">{t('shell.pinned')}</h2>{pinnedThreads.map(threadRow)}</> : null}
          {otherThreads.length ? <><h2 className="thread-group">{scope === 'archived' ? t('shell.archivedGroup') : t('shell.recentGroup')}</h2>{otherThreads.map(threadRow)}</> : null}
        </> : roomSearch.loading || roomSearch.error ? null : <ThreadListEmpty search={search} scope={scope} onClear={() => { setSearch(''); setScope('all'); }} onShowAll={() => setScope('all')} onCreate={() => setModal({ type: 'new-thread' })} />}</div>
      </div>
    </aside> : null}
    {view.page === 'today' ? <Today notice={setupNotice ? <SetupNotice notice={setupNotice} onConnect={openModelSettings} /> : null} paused={paused} onPause={togglePause} attention={attention} members={animatedMembers} memberMap={memberMap} activities={activities} artifacts={artifacts} decisions={updates} threads={threads} onOpenTask={openTask} onThread={openThread} onRead={readUpdates} onRecap={() => navigate({ page: 'records', tab: 'recap' })} onArtifact={openArtifact} onMember={openMember} onDM={openDM} onNewThread={() => setModal({ type: 'new-thread' })} onConflicts={() => navigate({ page: 'bots', id: 'everyone', tab: 'conflicts' })} onTrust={() => navigate({ page: 'records', tab: 'approval' })} /> : null}
    {view.page === 'conversation' && !thread ? <main className="conversation" id="main-content">{setupNotice ? <EmptyState title={setupNotice.title} action={<button className="button primary" onClick={openModelSettings}>{t('shell.connectModel')}</button>}>{setupNotice.body}</EmptyState> : <EmptyState title={t('shell.firstThreadTitle')} action={<button className="button primary" onClick={() => setModal({ type: 'new-thread' })}>{t('shell.startThread')}</button>}>{t('shell.firstThreadBody')}</EmptyState>}</main> : null}
    {view.page === 'conversation' && thread ? <Conversation notice={threadNotice ? <SetupNotice notice={threadNotice} onConnect={openModelSettings} /> : null} onThreadAction={organizeThread} drafts={Object.values(live.drafts).filter(draft => draft.room_id === thread.id)} thread={thread} artifacts={artifacts} tasks={activities.filter(task => task.thread === thread.id)} onNewSession={() => setModal({ type: 'new-thread', scope: thread.scope, member: thread.members[0] })} onDelete={() => setModal({ type: 'delete-content', kind: 'room', id: thread.id, title: thread.title })} members={animatedMembers} memberMap={memberMap} paused={paused} onPause={togglePause} onSend={sendMessage} onAppearance={id => setModal({ type: 'appearance', member: id })} onMember={openMember} onBack={() => navigate({ page: 'conversation' })} onArtifact={openArtifact} /> : null}
    {view.page === 'bots' ? <Members memberMap={memberMap} onOpenBot={id => navigate({ page: 'bots', id, tab: 'memory' })} onOpenThread={openThread} onDormant={(id, dormant) => mutate(() => api(`/agents/${id}/dormancy`, 'PATCH', { dormant }), dormant ? t('shell.botRested') : t('shell.botBroughtBack'))} onDelete={(id, version) => mutate(() => api('/agents/' + id, 'DELETE', { version }), t('shell.botDeleted'))} onAdd={addMember} onImported={importedBot} maxMembers={Math.max(1, Number(settings.maxMembers) || 10)} members={animatedMembers} selected={view.id} tab={view.tab} onSelect={id => navigate({ page: 'bots', id, tab: view.tab })} onClose={() => navigate({ page: 'bots' })} onTab={tab => navigate({ page: 'bots', id: shownBot, tab })} onUpdate={updateMember} onSaveMemory={saveMemory} onDeleteMemory={deleteMemory} onDM={openDM} paused={paused} /> : null}
    {view.page === 'records' ? <Activity taskId={view.task} replay={!!view.replay} onReplay={(id, on) => navigate({ page: 'records', task: id, ...(on ? { replay: true } : {}) })} onBranched={async id => { await refresh(); notify(t('shell.taskBranched')); navigate({ page: 'records', task: id }); }} onOpenTask={openTask} onCloseTask={closeTask} onDeleteArtifact={id => { const item = artifacts.find(item => item.id === id); if (item) setModal({ type: 'delete-content', kind: 'artifact', id, title: item.name }); }} onScheduleDelete={id => mutate(() => api(`/schedules/${id}`, 'DELETE'), t('shell.scheduleDeleted'))} schedules={schedules} threads={threads} onScheduleSave={({ id, version, ...body }) => mutate(() => version ? api(`/schedules/${id}`, 'PUT', { ...body, version }) : api('/schedules', 'POST', { ...body, id }), t('shell.scheduleSaved'))} onScheduleToggle={(id, enabled) => mutate(() => api(`/schedules/${id}`, 'PATCH', { enabled }), enabled ? t('shell.scheduleResumed') : t('shell.schedulePaused'))} onScheduleToken={async id => { let issued = null; await mutate(async () => { issued = await api(`/schedules/${id}/token`, 'POST', {}); }, t('shell.scheduleTokenIssued')); return issued; }} updates={updates} seen={seen} onRead={readUpdates} artifacts={artifacts} filter={view.tab || recordTab} onFilter={tab => navigate({ page: 'records', tab })} onControl={controlTask} activities={activities} members={memberMap} paused={paused} onPause={togglePause} onDecide={(id, approved, version) => mutate(async () => { await api(`/approvals/${id}`, 'POST', { approved, version }); closeTask(); }, approved ? t('shell.approvalApproved') : t('shell.approvalDeclined'))} onThread={openThread} onArtifact={openArtifact} /> : null}
    {page === 'settings' ? <Settings tab={route.tab} onTab={tab => navigate({ page: 'settings', tab })} onClose={() => navigate(backRoute.current)} onPreviewTheme={setPreviewTheme} onPreviewLanguage={setPreviewLanguage} settings={settings} onSave={saveSettings} paused={paused} onPause={togglePause} members={animatedMembers} /> : null}
    <nav className="mobile-nav" aria-label={t('shell.mobileNavigation')}>{navItems.map(({ id, label, icon: Icon }) => <a key={id} href={`#${id}`} className={(id === 'settings' ? page === 'settings' : view.page === id && page !== 'settings') ? 'active' : ''} aria-current={(id === 'settings' ? page === 'settings' : view.page === id && page !== 'settings') ? 'page' : undefined}><Icon size={23} /><span>{label}</span>{id === 'today' && waitingCount ? <span className="nav-badge" aria-label={t('shell.yourTurnCount', { count: waitingCount })}>{waitingCount}</span> : null}</a>)}</nav>
    {paletteOpen ? <CommandPalette threads={threads} members={animatedMembers} paused={paused} onClose={() => setPaletteOpen(false)} onThread={openThread} onMember={openMember} onNavigate={navigate} onNewThread={() => setModal({ type: 'new-thread' })} onPause={togglePause} /> : null}
    {modal?.type === 'appearance' ? <Modal title={t('shell.appearanceTitle', { name: memberMap[modal.member].name })} onClose={() => setModal(null)} className="appearance-modal"><AppearanceEditor member={memberMap[modal.member]} onCancel={() => setModal(null)} onSave={async patch => { if (await updateMember(modal.member, patch)) setModal(null); }} /></Modal> : null}
    {modal?.type === 'delete-content' ? <DeleteContentDialog item={modal} onClose={() => setModal(null)} onDelete={item => mutate(() => api(`/${item.kind === 'room' ? 'rooms' : 'artifacts'}/${item.id}`, 'DELETE', {}), t('shell.contentDeleted'))} /> : null}
    {modal?.type === 'artifact' ? <ArtifactPreview key={modal.artifact.id} onOpen={openArtifact} onDelete={() => setModal({ type: 'delete-content', kind: 'artifact', id: modal.artifact.id, title: modal.artifact.name })} artifact={modal.artifact} members={memberMap} onClose={() => setModal(null)} onThread={openThread} /> : null}
    {modal?.type === 'new-thread' ? <NewThreadModal members={animatedMembers} initialScope={modal.scope} initialMember={modal.member} onClose={() => setModal(null)} onCreate={createThread} /> : null}
    {offline ? <div className="offline-notice" role="alert">{t('shell.offline')}<br />{t('shell.offlineRetry')}</div> : null}
    <div className="toast-region" role="status" aria-live="polite">{toast ? <div key={toast.key} className={`toast ${toastOut ? 'out' : ''}`}><CheckCircleIcon size={20} /><span><Sentences>{toast.text}</Sentences></span><IconButton label={t('shell.closeNotice')} onClick={dismissToast}><CloseIcon size={16} /></IconButton><span className="toast-timer" aria-hidden="true" /></div> : null}</div>
  </div>;
}

/** Only a search can hide threads; an empty scope or a first start says how to begin instead of asking to change the search. */
function ThreadListEmpty({ search, scope, onClear, onShowAll, onCreate }) {
  if (search.trim()) return <EmptyState icon={SearchIcon} title={t('shell.noThreadsFound')} action={<button className="text-button" onClick={onClear}>{t('shell.clearFilters')}</button>}>{t('shell.noThreadsFoundBody')}</EmptyState>;
  if (scope === 'archived') return <EmptyState icon={InfoIcon} title={t('shell.noArchivedThreads')}>{t('shell.noArchivedThreadsBody')}</EmptyState>;
  if (scope !== 'all') return <EmptyState icon={ChatIcon} title={scope === 'shared' ? t('shell.noSharedThreads') : t('shell.noPrivateThreads')} action={<button className="text-button" onClick={onShowAll}>{t('shell.showAll')}</button>} />;
  return <EmptyState icon={ChatIcon} title={t('shell.noThreads')} action={<button className="text-button" onClick={onCreate}>{t('shell.startNewThread')}</button>}>{t('shell.noThreadsBody')}</EmptyState>;
}

function NewThreadModal({ members, initialScope = 'shared', initialMember, onCreate, onClose }) {
  const [scope, setScope] = useState(initialScope);
  const [member, setMember] = useState(initialMember || members[0].id);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return <Modal title={t('shell.newThread')} onClose={onClose} className="new-thread-modal"><form onSubmit={async e => { e.preventDefault(); if (busy || !title.trim() || !text.trim()) return; setBusy(true); try { await onCreate({ title: title.trim(), text: text.trim(), scope, member }); } finally { setBusy(false); } }}>
    <div className="modal-body form-stack"><Segmented label={t('shell.newThreadScopeLabel')} className="wide" options={[{ value: 'shared', label: t('shell.shareWithEveryone') }, { value: 'private', label: t('shell.talkPrivately') }]} value={scope} onChange={setScope} />
      <p className="scope-note">{scope === 'private' ? <LockIcon size={16} /> : <UsersIcon size={16} />}{scope === 'private' ? t('shell.privateScopeNote') : t('shell.sharedScopeNote')}</p>
      {scope === 'private' ? <fieldset className="partner-picker"><legend>{t('shell.partner')}</legend><div className="partner-options">{members.map(item => <label key={item.id} className={`partner-option ${member === item.id ? 'selected' : ''}`}><input type="radio" name="partner" value={item.id} checked={member === item.id} onChange={() => setMember(item.id)} /><Avatar member={item} size={38} /><span>{item.name}</span></label>)}</div></fieldset> : null}
      <label className="field"><span>{t('shell.topic')}</span><input autoFocus placeholder={t('shell.topicPlaceholder')} maxLength={80} value={title} onChange={e => setTitle(e.target.value)} required /></label>
      <label className="field"><span>{t('shell.firstMessage')}</span><textarea rows={4} placeholder={t('shell.firstMessagePlaceholder')} value={text} onChange={e => setText(e.target.value)} required /></label>
    </div><div className="form-actions"><button type="button" className="button subtle" onClick={onClose}>{t('shell.cancelAction')}</button><button className="button primary" disabled={busy || !title.trim() || !text.trim()}>{t('shell.startThread')}</button></div>
  </form></Modal>;
}
