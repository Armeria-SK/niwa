import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Avatar, IconButton, Modal, StatusLabel } from '../components.jsx';
import { BackIcon, UsersIcon, PauseIcon, PlayIcon, MoonIcon, PlusIcon, ReplyIcon, CloseIcon, FileIcon, LockIcon, PaletteIcon, PaperclipIcon, PinIcon, ArchiveIcon } from '../icons.jsx';
import { uid } from '../data.js';
import { ConversationWork } from '../ConversationWork.jsx';
import { MentionText } from '../MentionText.jsx';
import { useConversationMessages } from '../useConversationMessages.js';
import './Conversation.css';

export function Conversation({ thread, tasks, onWork, onNewSession, members, memberMap, paused, onPause, onSend, onAppearance, onMember, onBack, onArtifact, onThreadAction }) {
  const [showPresence, setShowPresence] = useState(false);
  const visibleMembers = thread.scope === 'private' ? members.filter(item => thread.members.includes(item.id)) : members;
  const presenceProps = { members: visibleMembers, paused, onPause, onAppearance, onMember, isPrivate: thread.scope === 'private' };
  return <>
    <main className="conversation" id="main-content" tabIndex={-1} aria-label={thread.title}>
      <div className="conversation-mobile-tools"><button className="text-button" onClick={onBack}><BackIcon size={20} />スレッド</button><IconButton label="メンバーの様子" onClick={() => setShowPresence(true)}><UsersIcon size={22} /></IconButton></div>
      <ThreadBody onThreadAction={onThreadAction} key={thread.id} thread={thread} tasks={tasks} onWork={onWork} onNewSession={onNewSession} memberMap={memberMap} paused={paused} onSend={onSend} onMember={onMember} onArtifact={onArtifact} />
    </main>
    <aside className="presence-rail" aria-label="メンバーの様子"><Presence {...presenceProps} /></aside>
    {showPresence ? <Modal title="メンバーの様子" onClose={() => setShowPresence(false)} className="presence-modal"><Presence {...presenceProps} noHeading onMember={id => { setShowPresence(false); onMember(id); }} onAppearance={id => { setShowPresence(false); onAppearance(id); }} /></Modal> : null}
  </>;
}

function ThreadBody({ thread, tasks, onWork, onNewSession, memberMap, paused, onSend, onMember, onArtifact, onThreadAction }) {
  const history = useConversationMessages(thread);
  const deletedConversation = thread.scope === 'private' && thread.members.length > 0 && thread.members.every(id => memberMap[id]?.deleted);
  const readOnly = thread.archived || deletedConversation;
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [sending, setSending] = useState(false);
  const [recipients, setRecipients] = useState([]);
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const mention = draft.slice(0, caret).match(/(?:^|\s)@([^@\n]*)$/);
  const candidates = mention ? Object.values(memberMap).filter(member => !member.deleted && (thread.scope === 'shared' || thread.members.includes(member.id)) && member.name.toLowerCase().includes(mention[1].toLowerCase())) : [];
  function chooseRecipient(member) {
    const start = caret - mention[1].length - 1; const replacement = `@${member.name} `;
    setDraft(draft.slice(0, start) + replacement + draft.slice(caret)); setRecipients(current => [...current.filter(item => item.id !== member.id), { id: member.id, name: member.name }]); setCaret(0);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(start + replacement.length, start + replacement.length); });
  }
  const previousLast = useRef(null); const prependPosition = useRef(null);
  const lastId = history.items.at(-1)?.id || history.first?.id;
  useEffect(() => { if (lastId && lastId !== previousLast.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: previousLast.current ? 'smooth' : 'instant' }); previousLast.current = lastId; }, [lastId]);
  useLayoutEffect(() => {
    if (prependPosition.current && listRef.current) listRef.current.scrollTop = prependPosition.current.top + listRef.current.scrollHeight - prependPosition.current.height;
    prependPosition.current = null;
  }, [history.olderVersion]);
  async function loadEarlier() {
    const position = { top: listRef.current.scrollTop, height: listRef.current.scrollHeight }; prependPosition.current = position;
    if (!await history.loadMore() && prependPosition.current === position) prependPosition.current = null;
  }
  async function submit(e) {
    e?.preventDefault(); if (readOnly || sending || (!draft.trim() && !attachments.length)) return;
    setSending(true);
    try { if (await onSend(draft.trim(), attachments.map(({ name, size }) => ({ name, size })), replyTo ? { author: replyTo.author, text: replyTo.text } : null, recipients.map(item => item.id))) {
      setDraft(''); setAttachments([]); setReplyTo(null); setRecipients([]); setCaret(0); inputRef.current?.focus();
    } } finally { setSending(false); }
  }
  return <>
    <header className="message-scroll conversation-header" aria-label="会話のヘッダー">
      <div className="thread-date"><time>{thread.day}</time><div className="thread-tools"><button className="text-button" disabled={deletedConversation} onClick={onNewSession}><PlusIcon size={15} />新規セッション</button><button className="text-button" aria-pressed={thread.pinned} onClick={() => onThreadAction(thread.id, 'pinned')}><PinIcon size={15} />{thread.pinned ? 'ピン解除' : 'ピン留め'}</button><button className="text-button" onClick={() => onThreadAction(thread.id, 'archived')}><ArchiveIcon size={15} />{thread.archived ? '保管から戻す' : 'アーカイブ'}</button></div>{thread.scope === 'private' ? <span className="private-label"><LockIcon size={14} />個別の会話</span> : null}</div>
      <Message message={history.first} isRoot title={thread.title} memberMap={memberMap} onMember={onMember} onReply={message => { setReplyTo(message); inputRef.current?.focus(); }} onArtifact={onArtifact} />
    </header>
    <div className="message-scroll conversation-replies" ref={listRef}>
      <div className="reply-divider"><span>{Math.max(0, thread.message_count - 1)}件の返信</span><span /></div>
      {history.loading ? <p role="status">発言を読み込み中…</p> : null}
      {history.error ? <p role="alert">{history.error}<button className="text-button" onClick={history.reload}>再読み込み</button></p> : null}
      {history.next !== null ? <button className="text-button" disabled={history.loading} onClick={loadEarlier}>以前の返信を50件読み込む</button> : null}
      <div className="replies">{history.items.map(message => <Message key={message.id} message={message} memberMap={memberMap} onMember={onMember} onReply={message => { setReplyTo(message); inputRef.current?.focus(); }} onArtifact={onArtifact} />)}</div>
      {thread.message_count === 1 && !tasks.some(task => !['done', 'canceled'].includes(task.status)) ? <p className="first-reply-hint">ここから、会話が始まります。</p> : null}
      <ConversationWork tasks={tasks} members={memberMap} onOpen={onWork} />
    </div>
    <div className="composer-wrap">{thread.archived ? <p className="archive-note"><ArchiveIcon size={16} />保管中のスレッドです。返信するには「保管から戻す」を選んでください。</p> : null}
      {deletedConversation ? <p className="archive-note" role="status">相手のBotは削除されています。この会話は履歴として読むことができます。</p> : null}
      {paused && !readOnly ? <div className="pause-notice"><PauseIcon size={14} />Botの活動は一時停止中です。返信は残せます。</div> : null}
      {replyTo ? <div className="reply-preview"><ReplyIcon size={16} /><div><strong>{memberMap[replyTo.author]?.name || 'あなた'}に返信</strong><span>{replyTo.text}</span></div><IconButton label="返信先を解除" onClick={() => setReplyTo(null)}><CloseIcon size={16} /></IconButton></div> : null}
      {attachments.length ? <div className="attachment-previews">{attachments.map(file => <span key={file.id}><PaperclipIcon size={15} />{file.name}<IconButton label={`${file.name}を外す`} onClick={() => setAttachments(current => current.filter(item => item.id !== file.id))}><CloseIcon size={13} /></IconButton></span>)}</div> : null}
      {recipients.length ? <div className="reply-preview mention-recipients">{recipients.map(recipient => <span key={recipient.id}>依頼先：{recipient.name}<IconButton label={`${recipient.name}の指定を解除`} onClick={() => setRecipients(current => current.filter(item => item.id !== recipient.id))}><CloseIcon size={14} /></IconButton></span>)}</div> : null}
      {candidates.length ? <div className="mention-picker" role="listbox" aria-label="依頼するBot">{candidates.map((member, index) => <button type="button" role="option" aria-selected={index === mentionIndex} key={member.id} onClick={() => chooseRecipient(member)}>{member.name}<span className="muted">{member.role}</span></button>)}</div> : null}
      <form className="composer" onSubmit={submit}><textarea disabled={readOnly} ref={inputRef} aria-label="このスレッドに返信" placeholder="このスレッドに返信…（@でBotを指定）" value={draft} rows={1} onChange={e => { setDraft(e.target.value); setCaret(e.target.selectionStart); setMentionIndex(0); setRecipients(current => current.filter(item => e.target.value.includes(`@${item.name}`))); }} onKeyDown={e => {
        if (e.nativeEvent.isComposing) return;
        if (candidates.length && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key) && !e.ctrlKey && !e.metaKey) {
          e.preventDefault(); if (e.key === 'Escape') setCaret(0); else if (e.key === 'Enter') chooseRecipient(candidates[mentionIndex % candidates.length]);
          else setMentionIndex((mentionIndex + (e.key === 'ArrowDown' ? 1 : candidates.length - 1)) % candidates.length); return;
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
      }} />
        <input className="visually-hidden" ref={fileRef} type="file" multiple aria-label="添付ファイル" onChange={e => { const next = Array.from(e.target.files || []).map(file => ({ id: uid('file'), name: file.name, size: file.size })); setAttachments(current => [...current, ...next]); e.target.value = ''; }} />
        <IconButton label="ファイルを添付" disabled={readOnly} className="attach-button" onClick={() => fileRef.current?.click()}><PlusIcon size={23} /></IconButton><button className="button primary send-button" disabled={readOnly || sending || (!draft.trim() && !attachments.length)}>送信</button>
      </form>
      <span className="composer-hint">{thread.scope === 'private' ? 'この会話は、あなたと相手のBotだけに表示されます。' : 'メンバー全員が読んで参加できるスレッドです。'}<span>Ctrl / ⌘ + Enter で送信</span></span>
    </div>
  </>;
}

function Message({ message, isRoot = false, title, memberMap, onMember, onReply, onArtifact }) {
  if (!message) return <h1>{title}</h1>;
  const member = memberMap[message.author];
  return <article className={`message ${isRoot ? 'root-message' : ''}`}>
    {member ? <button className="avatar-button" aria-label={`${member.name}のプロフィール`} onClick={() => onMember(member.id)}><Avatar member={member} size={60} /></button> : <Avatar size={60} />}
    <div className="message-content"><div className="message-meta"><strong>{member?.name || 'あなた'}</strong><time>{message.time}</time><IconButton label={`${member?.name || 'あなた'}のメッセージに返信`} className="message-reply" onClick={() => onReply(message)}><ReplyIcon size={18} /></IconButton></div>
      {isRoot ? <h1>{title}</h1> : null}
      {(message.text || message.replyTo || message.artifact || message.attachments?.length) ? <div className="message-bubble">
      {message.replyTo ? <blockquote><span>{memberMap[message.replyTo.author]?.name || 'あなた'}</span>{message.replyTo.text}</blockquote> : null}
      {message.text ? <p><MentionText text={message.text} members={memberMap} /></p> : null}
      {message.artifact ? <button className="file-link" onClick={onArtifact}><FileIcon size={19} />雨音の調査メモ.md</button> : null}
      {message.attachments?.map((file, index) => <span className="file-link local-attachment" key={`${file.name}-${index}`}><FileIcon size={18} />{file.name}<small>{Math.max(1, Math.round(file.size / 1024))} KB · 添付の表示例</small></span>)}
      </div> : null}
    </div>
  </article>;
}

function Presence({ members, paused, onPause, onAppearance, onMember, isPrivate, noHeading = false }) {
  const active = members.filter(item => item.status !== 'sleeping');
  return <div className="presence-content">
    {!noHeading ? <h2>メンバーの様子</h2> : null}
    <div className="presence-summary"><span>{paused ? '活動を一時停止中' : `${active.length}人が活動中`}</span><IconButton label={paused ? '全体の活動を再開' : '全体の活動を一時停止'} className={paused ? 'resume-button' : ''} onClick={onPause}>{paused ? <PlayIcon size={19} weight="fill" /> : <PauseIcon size={19} weight="fill" />}</IconButton></div>
    {isPrivate ? <p className="presence-scope"><LockIcon size={14} />あなたとの個別の会話</p> : null}
    <div className="presence-members">{members.map(member => <div key={member.id} className={`presence-member ${member.status === 'sleeping' ? 'sleeping' : ''}`}>
      <button className="avatar-button presence-avatar" aria-label={`${member.name}のアイコンを変更`} title="アイコンを変更" onClick={() => onAppearance(member.id)}><Avatar member={member} size={57} /><span className="avatar-edit-hint"><PaletteIcon size={12} /></span></button>
      <button className="presence-member-info" onClick={() => onMember(member.id)}><strong>{member.name}</strong><StatusLabel member={member} paused={paused} /></button>{member.status === 'sleeping' ? <MoonIcon size={19} className="sleep-icon" /> : null}
    </div>)}</div>
  </div>;
}
