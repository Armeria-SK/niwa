import {memberWork,presenceCounts,shortWork,workLabel} from '../work-display.js';
import {WorkFacts} from '../WorkFacts.jsx';
import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import { Avatar, IconButton, Modal, StatusLabel } from '../components.jsx';
import { BackIcon, UsersIcon, PauseIcon, PlayIcon, MoonIcon, PlusIcon, ReplyIcon, CloseIcon, FileIcon, LockIcon, PaletteIcon, PaperclipIcon, PinIcon, ArchiveIcon, DownloadIcon, CompareIcon, EditIcon } from '../icons.jsx';
import { SecondOpinion } from '../SecondOpinion.jsx';
import { ATTACHMENT_LIMITS, formatSize, readAttachments, unseenNotice } from '../attachments.js';
import { documentName } from '../artifact-display.js';
import { Markdown } from '../Markdown.jsx';
import { useConversationMessages } from '../useConversationMessages.js';
import './Conversation.css';
import {CoordinationBoard} from '../CoordinationBoard.jsx';
import { t, serverText } from '../i18n.js';
import { rich } from '../i18n-react.js';
import { nameList } from '../conversationText.js';

export function Conversation({ notice, thread, tasks, artifacts = [], drafts = [], onNewSession, members, memberMap, paused, onPause, onSend, onAppearance, onMember, onBack, onArtifact, onThreadAction, onRename }) {
  const [showPresence, setShowPresence] = useState(false);
  const [showWork, setShowWork] = useState(false);
  const visibleMembers = thread.scope === 'private' ? members.filter(item => thread.members.includes(item.id)) : members;
  const scopedMembers = visibleMembers.map(member => {
    const work=memberWork(tasks.filter(task=>task.member===member.id&&task.thread===thread.id),paused,member.status==='sleeping');
    return {...member,...work,workKind:work.kind};
  });
  const presenceProps = { members: scopedMembers, paused, onPause, onAppearance, onMember, isPrivate: thread.scope === 'private' };
  return <>
    <main className="conversation" id="main-content" tabIndex={-1} aria-label={thread.title}>
      <div className="conversation-mobile-tools"><button className="text-button" onClick={onBack}><BackIcon size={20} />{t('conversation.chatList')}</button><IconButton label={t('conversation.botStatus')} onClick={() => setShowPresence(true)}><UsersIcon size={22} /></IconButton></div>
      {notice ? <div className="conversation-notice">{notice}</div> : null}
      <ThreadBody onShowWork={() => setShowWork(true)} onThreadAction={onThreadAction} onRename={onRename} key={thread.id} thread={thread} tasks={tasks} artifacts={artifacts} drafts={drafts} onNewSession={onNewSession} memberMap={memberMap} paused={paused} onSend={onSend} onMember={onMember} onArtifact={onArtifact} />
    </main>
    {showWork ? <CoordinationBoard roomId={thread.id} members={memberMap} onClose={() => setShowWork(false)} onArtifact={onArtifact}/> : null}
    <aside className="presence-rail" aria-label={t('conversation.botStatus')}><Presence {...presenceProps} /></aside>
    {showPresence ? <Modal title={t('conversation.botStatus')} onClose={() => setShowPresence(false)} className="presence-modal"><Presence {...presenceProps} noHeading onMember={id => { setShowPresence(false); onMember(id); }} onAppearance={id => { setShowPresence(false); onAppearance(id); }} /></Modal> : null}
  </>;
}

function ThreadBody({ onShowWork, thread, tasks, artifacts, drafts, onNewSession, memberMap, paused, onSend, onMember, onArtifact, onThreadAction, onRename }) {
  const [renaming, setRenaming] = useState(false);
  const history = useConversationMessages(thread);
  const followBottom=useRef(true);
  const deletedConversation = thread.scope === 'private' && thread.members.length > 0 && thread.members.every(id => memberMap[id]?.deleted);
  const readOnly = thread.archived || deletedConversation;
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [attachmentErrors, setAttachmentErrors] = useState([]);
  const [openFile, setOpenFile] = useState(null);
  const [comparing, setComparing] = useState(null);
  const [sending, setSending] = useState(false);
  const [recipients, setRecipients] = useState([]);
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionListId = useId();
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const mention = draft.slice(0, caret).match(/(?:^|\s)@([^@\n]*)$/);
  const candidates = mention ? Object.values(memberMap).filter(member => !member.deleted && (thread.scope === 'shared' || thread.members.includes(member.id)) && member.name.toLowerCase().includes(mention[1].toLowerCase())) : [];
  const activeMentionIndex = candidates.length ? mentionIndex % candidates.length : 0;
  const activeMentionId = candidates.length ? `${mentionListId}-${candidates[activeMentionIndex].id}` : undefined;
  useEffect(() => { if (activeMentionId) document.getElementById(activeMentionId)?.scrollIntoView({ block: 'nearest' }); }, [activeMentionId]);
  function chooseRecipient(member) {
    const start = caret - mention[1].length - 1; const replacement = `@${member.name} `;
    setDraft(draft.slice(0, start) + replacement + draft.slice(caret)); setRecipients(current => [...current.filter(item => item.id !== member.id), { id: member.id, name: member.name }]); setCaret(0);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(start + replacement.length, start + replacement.length); });
  }
  const previousLast = useRef(null); const prependPosition = useRef(null);
  const lastId = history.items.at(-1)?.id || history.first?.id;
  useEffect(() => { if (lastId && lastId !== previousLast.current && followBottom.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: previousLast.current ? 'smooth' : 'instant' }); previousLast.current = lastId; }, [lastId]);
  // A posted reply from the same Bot after the draft started replaces the draft bubble.
  const liveDrafts = drafts.filter(item => item.text && !history.items.some(message => message.author_id === item.agent_id && Date.parse(message.created_at) >= item.started_at));
  const draftLength = liveDrafts.reduce((sum, item) => sum + item.text.length, 0);
  useEffect(() => { if (draftLength && followBottom.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [draftLength]);
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
    try { if (await onSend(draft.trim(), attachments.map(({ name, content }) => ({ name, content })), replyTo ? { id: replyTo.id, author: replyTo.author } : null, recipients.map(item => item.id))) {
      setDraft(''); setAttachments([]); setAttachmentErrors([]); setReplyTo(null); setRecipients([]); setCaret(0); inputRef.current?.focus();
    } } finally { setSending(false); }
  }
  return <>
    <header className="conversation-head" aria-label={t('conversation.headerLabel')}>
      <div className="conversation-head-text"><h1><span>{thread.title}</span>{thread.scope === 'private' ? <LockIcon size={16} aria-label={t('conversation.privateConversation')} /> : null}</h1><p>{thread.scope === 'private' ? t('conversation.privateConversation') : t('conversation.sharedConversation')}{thread.day ? ` · ${t('conversation.since', { day: thread.day })}` : ''}{thread.members.length ? ` · ${t('common.bots', { count: thread.members.length })}` : ''}</p></div>
      <span className="conversation-faces" aria-hidden="true">{thread.members.slice(0, 4).map(id => memberMap[id] ? <span key={id}><Avatar member={memberMap[id]} motion="none" size={24} /></span> : null)}</span>
      <div className="conversation-head-actions"><button className="button subtle" onClick={onShowWork}>{t('conversation.collaboration')}</button><IconButton label={t('conversation.rename')} disabled={deletedConversation} onClick={() => setRenaming(true)}><EditIcon size={19} /></IconButton><IconButton label={thread.pinned ? t('conversation.unpin') : t('conversation.pin')} aria-pressed={thread.pinned} onClick={() => onThreadAction(thread.id, 'pinned')}><PinIcon size={19} /></IconButton><IconButton label={thread.archived ? t('conversation.unarchive') : t('conversation.archive')} aria-pressed={thread.archived} onClick={() => onThreadAction(thread.id, 'archived')}><ArchiveIcon size={19} /></IconButton><IconButton label={t('conversation.newConversation')} disabled={deletedConversation} onClick={onNewSession}><PlusIcon size={20} /></IconButton></div>
    </header>
    {renaming ? <RenameThread title={thread.title} onClose={() => setRenaming(false)} onSave={async title => { if (await onRename(thread.id, title)) setRenaming(false); }} /> : null}
    <div className="message-scroll conversation-replies" ref={listRef} onScroll={()=>{const node=listRef.current;followBottom.current=node.scrollHeight-node.scrollTop-node.clientHeight<80;}}>
      <Message acknowledgments={thread.acknowledgments} message={history.first} isRoot title={thread.title} memberMap={memberMap} artifacts={artifacts} onAttachment={setOpenFile} onMember={onMember} onReply={message => { setReplyTo(message); inputRef.current?.focus(); }} onArtifact={onArtifact} />
      <div className="reply-divider"><span>{t('conversation.replyCount', { count: Math.max(0, thread.message_count - 1) })}</span><span /></div>
      {history.loading ? <p role="status">{t('conversation.loadingMessages')}</p> : null}
      {history.error ? <p role="alert">{serverText(history.error)}<button className="text-button" onClick={history.reload}>{t('conversation.reload')}</button></p> : null}
      {history.next !== null ? <button className="text-button" disabled={history.loading} onClick={loadEarlier}>{t('conversation.loadEarlier', { count: 50 })}</button> : null}
      <div className="replies">{history.items.map(message=><Message key={message.id} acknowledgments={thread.acknowledgments} message={message} memberMap={memberMap} artifacts={artifacts} onAttachment={setOpenFile} onMember={onMember} onReply={message=>{setReplyTo(message);inputRef.current?.focus();}} onArtifact={onArtifact} onCompare={readOnly?undefined:setComparing}/>)}{liveDrafts.map(item => <DraftMessage key={item.task_id} draft={item} member={memberMap[item.agent_id]} />)}</div>
      {thread.message_count === 1 && !tasks.some(task => !['done', 'canceled'].includes(task.status)) ? <p className="first-reply-hint">{t('conversation.firstReplyHint')}</p> : null}
    </div>
    <div className="composer-wrap">{thread.archived ? <p className="archive-note"><ArchiveIcon size={16} />{rich('conversation.archivedNote', { br: <br /> })}</p> : null}
      {deletedConversation ? <p className="archive-note" role="status">{rich('conversation.deletedNote', { br: <br /> })}</p> : null}
      {paused && !readOnly ? <div className="pause-notice"><PauseIcon size={14} />{rich('conversation.pausedNote', { br: <br /> })}</div> : null}
      {replyTo ? <div className="reply-preview"><ReplyIcon size={16} /><div><strong>{memberMap[replyTo.author] ? t('conversation.replyingTo', { name: memberMap[replyTo.author].name }) : t('conversation.replyingToYou')}</strong><span>{replyTo.text}</span></div><IconButton label={t('conversation.cancelReply')} onClick={() => setReplyTo(null)}><CloseIcon size={16} /></IconButton></div> : null}
      {attachmentErrors.length ? <div className="attachment-errors" role="alert"><div>{attachmentErrors.map((error, index) => <p key={index}>{error}</p>)}</div><IconButton label={t('conversation.dismissErrors')} onClick={() => setAttachmentErrors([])}><CloseIcon size={13} /></IconButton></div> : null}
      {attachments.length ? <div className="attachment-previews">{attachments.map(file => <span key={file.id}><PaperclipIcon size={15} />{file.name}<small>{formatSize(file.size)}</small><IconButton label={t('conversation.removeAttachment', { name: file.name })} onClick={() => setAttachments(current => current.filter(item => item.id !== file.id))}><CloseIcon size={13} /></IconButton></span>)}</div> : null}
      {recipients.length ? <div className="reply-preview mention-recipients">{recipients.map(recipient => <span key={recipient.id}>{t('conversation.recipient', { name: recipient.name })}<IconButton label={t('conversation.removeRecipient', { name: recipient.name })} onClick={() => setRecipients(current => current.filter(item => item.id !== recipient.id))}><CloseIcon size={14} /></IconButton></span>)}</div> : null}
      {candidates.length ? <div id={mentionListId} className="mention-picker" role="listbox" aria-label={t('conversation.mentionList')}>{candidates.map((member, index) => <button type="button" role="option" id={`${mentionListId}-${member.id}`} tabIndex={-1} aria-selected={index === activeMentionIndex} key={member.id} onMouseDown={e => e.preventDefault()} onMouseEnter={() => setMentionIndex(index)} onClick={() => chooseRecipient(member)}>{member.name}<span className="muted">{member.role}</span></button>)}</div> : null}
      <form className="composer" onSubmit={submit}><textarea disabled={readOnly || sending} ref={inputRef} aria-controls={candidates.length ? mentionListId : undefined} aria-activedescendant={activeMentionId} aria-describedby={candidates.length ? `${mentionListId}-hint` : undefined} onBlur={() => setCaret(0)} aria-label={t('conversation.replyLabel')} placeholder={t('conversation.replyPlaceholder')} value={draft} rows={1} onChange={e => { setDraft(e.target.value); setCaret(e.target.selectionStart); setMentionIndex(0); setRecipients(current => current.filter(item => e.target.value.includes(`@${item.name}`))); }} onKeyDown={e => {
        if (e.nativeEvent.isComposing) return;
        if (candidates.length && ['ArrowDown', 'ArrowUp', 'Tab', 'Enter', 'Escape'].includes(e.key) && !e.ctrlKey && !e.metaKey) {
          e.preventDefault(); if (e.key === 'Escape') setCaret(0); else if (e.key === 'Enter') chooseRecipient(candidates[activeMentionIndex]);
          else setMentionIndex((activeMentionIndex + (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) ? candidates.length - 1 : 1)) % candidates.length); return;
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
      }} />
        <input className="visually-hidden" ref={fileRef} type="file" multiple aria-label={t('conversation.attachInput')} onChange={async e => { const files = Array.from(e.target.files || []); e.target.value = ''; const { accepted, errors } = await readAttachments(files, attachments.length, attachments.reduce((sum, file) => sum + file.size, 0)); setAttachments(current => [...current, ...accepted].slice(0, ATTACHMENT_LIMITS.count)); setAttachmentErrors(errors); }} />
        <IconButton label={t('conversation.attachButton', { count: ATTACHMENT_LIMITS.count })} disabled={readOnly || sending || attachments.length >= ATTACHMENT_LIMITS.count} className="attach-button" onClick={() => fileRef.current?.click()}><PlusIcon size={23} /></IconButton><button className="button primary send-button" disabled={readOnly || sending || (!draft.trim() && !attachments.length)}>{t('conversation.send')}</button>
      </form>
      {candidates.length ? <span className="composer-hint" id={`${mentionListId}-hint`}>{t('conversation.mentionHint')}</span> : null}
      {openFile ? <AttachmentPreview file={openFile} onClose={() => setOpenFile(null)} /> : null}
      {comparing ? <SecondOpinion roomId={thread.id} message={comparing} member={memberMap[comparing.author]} onClose={() => setComparing(null)} onKept={history.reload} /> : null}
      <span className="composer-hint">{thread.scope === 'private' ? t('conversation.privateHint') : t('conversation.sharedHint')}<span>{t('conversation.sendShortcut')}</span></span>
    </div>
  </>;
}

function Message({ acknowledgments = [], message, isRoot = false, title, memberMap, artifacts = [], onAttachment, onMember, onReply, onArtifact, onCompare }) {
  if (!message) return null;
  const member = memberMap[message.author];
  // 聞き比べは、いるBotの文章の発言だけ。休んでいるBotは同じ記憶の範囲を読めないので出さない。
  const comparable = onCompare && member && !member.deleted && member.status !== 'sleeping' && !!message.text;
  return <article data-message-id={message.id} className={`message ${isRoot ? 'root-message' : ''} ${member ? '' : 'mine'}`}>
    {member ? <button className="avatar-button" aria-label={t('conversation.profile', { name: member.name })} onClick={() => onMember(member.id)}><Avatar member={member} size={60} /></button> : <Avatar size={60} />}
    <div className="message-content"><div className="message-meta"><strong>{member?.name || t('conversation.you')}</strong><time dateTime={message.created_at}>{message.time}</time><IconButton label={member ? t('conversation.replyToMessage', { name: member.name }) : t('conversation.replyToYourMessage')} className="message-reply" onClick={() => onReply(message)}><ReplyIcon size={18} /></IconButton>{comparable ? <IconButton label={t('conversation.askAnotherModel')} className="message-compare" onClick={() => onCompare(message)}><CompareIcon size={18} /></IconButton> : null}</div>
      {(message.text || message.replyTo || message.artifact || message.attachments?.length) ? <div className="message-bubble">
      {message.reply_to ? <span className="message-reply-label"><ReplyIcon size={13} />{t('conversation.replyTag')}</span> : null}
      {message.replyTo ? <blockquote><span>{memberMap[message.replyTo.author]?.name || t('conversation.you')}</span>{message.replyTo.text}</blockquote> : null}
      {message.text ? <Markdown text={message.text} members={memberMap} /> : null}
      {message.artifact ? <ArtifactLink artifact={message.artifact} artifacts={artifacts} onArtifact={onArtifact} /> : null}
      {message.attachments?.length ? <div className="message-attachments">{message.attachments.map(file => file.media_type?.startsWith('image/')
        ? <figure className="message-image" key={file.id}><button type="button" aria-label={t('conversation.openImage', { name: file.name, size: formatSize(file.size) })} onClick={() => onAttachment(file)}><img src={`/api/attachments/${file.id}?view=1`} alt={file.name} loading="lazy" /></button>
          {file.unseen_by?.length ? <figcaption role="note">{unseenNotice(file.unseen_by.map(id => memberMap[id]?.name || t('conversation.deletedBot')))}</figcaption> : null}</figure>
        : <button type="button" className="file-link message-attachment" key={file.id} aria-label={t('conversation.openFile', { name: file.name, size: formatSize(file.size) })} onClick={() => onAttachment(file)}>{file.media_type === 'application/pdf' ? <FileIcon size={17} /> : <PaperclipIcon size={17} />}{file.name}<small>{file.media_type === 'application/pdf' ? t('conversation.pdfSize', { size: formatSize(file.size) }) : formatSize(file.size)}</small></button>)}</div> : null}
      </div> : null}
      {acknowledgments.some(item => item.message_id === message.id) ? <p className="message-acknowledgments">{t('conversation.acknowledgedBy', { names: nameList(acknowledgments.filter(item => item.message_id === message.id).map(item => memberMap[item.agent_id]?.name || t('conversation.deletedBot'))) })}</p> : null}
    </div>
  </article>;
}

// message.artifact is an artifact id (or a loaded artifact); the title comes from the loaded list.
function ArtifactLink({ artifact, artifacts, onArtifact }) {
  const id = typeof artifact === 'string' ? artifact : artifact.id;
  const name = (typeof artifact === 'object' && artifact.name) || artifacts.find(item => item.id === id)?.name;
  return <button className="file-link" onClick={() => onArtifact(id)}><FileIcon size={19} />{name ? documentName(name) : t('conversation.output')}</button>;
}

/** 添付を開く。画像はそのまま見せ、PDFは取り出した文字を、テキストは本文を見せる。どれもダウンロードできる。 */
function AttachmentPreview({ file, onClose }) {
  const [state, setState] = useState({ loading: true, text: '', error: null });
  const href = `/api/attachments/${file.id}`, image = file.media_type?.startsWith('image/'), pdf = file.media_type === 'application/pdf';
  useEffect(() => {
    if (image) return undefined;
    let active = true;
    fetch(pdf ? `${href}?text=1` : href, { credentials: 'same-origin', cache: 'no-store' }).then(async response => {
      // 文言は表示するときに今の言語で引くので、ここでは理由の種類（辞書の名前）だけを持たせる。
      if (!response.ok) throw Object.assign(new Error(String(response.status)), { key: response.status === 404 ? 'conversation.attachmentMissing' : 'conversation.attachmentLoadFailed' });
      const text = await response.text(); if (active) setState({ loading: false, text, error: null });
    }).catch(error => { if (active) setState({ loading: false, text: '', error: { key: error.key, message: error.message } }); });
    return () => { active = false; };
  }, [href, image, pdf]);
  return <Modal title={file.name} onClose={onClose} className="artifact-modal"><div className="modal-body">
    <p className="muted">{image ? t('conversation.attachedImage') : pdf ? t('conversation.attachedPdf') : t('conversation.attachedFile')} · {formatSize(file.size)}{image ? '' : ` · ${pdf ? t('conversation.pdfTextShown') : t('conversation.shownAsText')}`}</p>
    {image ? <img className="attachment-image" src={`${href}?view=1`} alt={file.name} />
      : state.loading ? <p role="status">{t('conversation.loadingShort')}</p> : state.error ? <p role="alert">{state.error.key ? t(state.error.key) : state.error.message}</p>
      : pdf && !state.text ? <p className="field-hint">{rich('conversation.pdfNoText', { br: <br /> })}</p>
      : <pre className="artifact-document attachment-document">{state.text}</pre>}
  </div><div className="form-actions"><a className="button primary" href={href} download={file.name}><DownloadIcon size={17} />{t('conversation.download')}</a></div></Modal>;
}

function DraftMessage({ draft, member }) {
  const sending = draft.state === 'sending';
  const label = sending ? t('conversation.draftSending') : t('conversation.draftWriting');
  return <article className="message draft-message" aria-busy="true" aria-label={t(sending ? 'conversation.draftSendingAria' : 'conversation.draftWritingAria', { name: member?.name || t('conversation.botFallback') })}>
    {member ? <Avatar member={member} size={60} /> : <Avatar size={60} />}
    <div className="message-content"><div className="message-meta"><strong>{member?.name || t('conversation.deletedBot')}</strong><span className="draft-status"><span className="typing-dots" aria-hidden="true"><span /><span /><span /></span>{label}</span></div>
      <div className="message-bubble draft-bubble"><p className="draft-text">{draft.text}{draft.truncated ? '…' : ''}</p></div>
    </div>
  </article>;
}

function Presence({ members, paused, onPause, onAppearance, onMember, isPrivate, noHeading = false }) {
  const [openJobs,setOpenJobs]=useState({});

  return <div className="presence-content">
    {!noHeading ? <h2>{t('conversation.botStatus')}</h2> : null}
    <div className="presence-summary"><span>{paused ? t('conversation.activityPaused') : presenceCounts(members)}</span><IconButton label={paused ? t('conversation.resumeAll') : t('conversation.pauseAll')} className={paused ? 'resume-button' : ''} onClick={onPause}>{paused ? <PlayIcon size={19} weight="fill" /> : <PauseIcon size={19} weight="fill" />}</IconButton></div>
    {isPrivate ? <p className="presence-scope"><LockIcon size={14} />{t('conversation.privateWithYou')}</p> : null}
    <div className="presence-members">{members.map(member => <div key={member.id} className={`presence-member ${member.status === 'sleeping' ? 'sleeping' : ''}`}>
      <button className="avatar-button presence-avatar" aria-label={t('conversation.changeIconFor', { name: member.name })} title={t('conversation.changeIcon')} onClick={() => onAppearance(member.id)}><Avatar member={member} size={57} /><span className="avatar-edit-hint"><PaletteIcon size={12} /></span></button>
      <button className="presence-member-info" onClick={() => onMember(member.id)}><strong>{member.name}</strong><StatusLabel member={member} paused={paused} /></button>{member.jobs?.length ? <button className="presence-job-count" aria-label={t('conversation.memberJobs', { name: member.name, count: member.jobs.length })} aria-expanded={!!openJobs[member.id]} aria-controls={`jobs-${member.id}`} onClick={()=>setOpenJobs(current=>({...current,[member.id]:!current[member.id]}))}>{t('conversation.jobCount', { count: member.jobs.length })}<span className="progress-chevron" aria-hidden="true" /></button> : null}
      {openJobs[member.id]&&member.jobs?.length ? <div className="presence-job-list" id={`jobs-${member.id}`}>{member.jobs.map(job=><div key={job.id}><span>{job.progress?.work_acknowledged?t('conversation.acknowledgedWork',{label:serverText(workLabel(job,paused))}):serverText(workLabel(job,paused))}</span><WorkFacts task={job} compact/><details className="presence-job-request"><summary><span className="request-preview">{shortWork(job.title)}</span><span className="request-open-label">{t('conversation.fullRequest')}</span></summary><p>{job.prompt||job.title}</p></details></div>)}</div>:null}{member.status === 'sleeping' ? <MoonIcon size={19} className="sleep-icon" /> : null}
    </div>)}</div>
  </div>;
}

/** 会話の名前を変える窓。今の名前から書き直し、空白だけのときは保存できない。 */
function RenameThread({ title, onSave, onClose }) {
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);
  const field = useRef(null);
  // The dialog opens after this mounts and takes focus, so select the name right after that to retype it at once.
  useEffect(() => { const timer = setTimeout(() => { field.current?.focus(); field.current?.select(); }); return () => clearTimeout(timer); }, []);
  const next = value.trim();
  return <Modal title={t('conversation.renameTitle')} onClose={onClose} className="rename-thread-modal"><form onSubmit={async e => { e.preventDefault(); if (busy || !next) return; if (next === title) { onClose(); return; } setBusy(true); try { await onSave(next); } finally { setBusy(false); } }}>
    <div className="modal-body form-stack"><label className="field"><span>{t('conversation.renameField')}</span><input ref={field} maxLength={200} value={value} onChange={e => setValue(e.target.value)} required /></label></div>
    <div className="form-actions"><button type="button" className="button subtle" onClick={onClose}>{t('conversation.renameCancel')}</button><button className="button primary" disabled={busy || !next}>{t('conversation.renameSave')}</button></div>
  </form></Modal>;
}
