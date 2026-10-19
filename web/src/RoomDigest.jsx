import { useEffect, useState } from 'react';
import { api } from './api.js';
import { locale, t } from './i18n.js';
import { EmptyState, IconButton, Modal } from './components.jsx';
import { EditIcon, TrashIcon } from './icons.jsx';

/** Shown first: what the administrator said and what was agreed weigh most. */
const SECTIONS = ['administrator', 'agreement', 'decision', 'open_request', 'topic', 'artifact'];
const SECTION_LABEL = { administrator: 'digestSectionAdministrator', agreement: 'digestSectionAgreement', decision: 'digestSectionDecision', open_request: 'digestSectionOpenRequest', topic: 'digestSectionTopic', artifact: 'digestSectionArtifact' };

/** 会話のまとめ: what Bots read in place of older messages. The administrator checks it, corrects or removes items, or starts it over. */
export function RoomDigestDrawer({ roomId, memberMap, onClose, onJump, notify }) {
  const [state, setState] = useState({ loading: true, digest: null, error: '' });
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [resetting, setResetting] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try { const value = await api(`/rooms/${roomId}/digest`); setState({ loading: false, digest: value.digest, error: '' }); }
    catch (error) { setState({ loading: false, digest: null, error: error.message }); }
  };
  useEffect(() => { load(); }, [roomId]);
  const change = async (work, message) => {
    setBusy(true);
    try { await work(); notify(message); setEditing(null); setDeleting(null); setResetting(false); await load(); }
    catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const author = id => id === 'administrator' ? t('conversation.you') : memberMap[id]?.name ?? t('conversation.deletedBot');
  const sources = ids => <span className="digest-sources">{ids.map((id, index) => <button key={id} type="button" className="text-button" onClick={() => onJump(id)}>{t('conversation.digestSource', { n: index + 1 })}</button>)}</span>;
  const digest = state.digest;
  const body = digest?.body;
  return <Modal drawer className="digest-drawer" title={t('conversation.digestTitle')} onClose={onClose}>
    <div className="digest-scroll" aria-busy={state.loading || busy}>
      <p className="digest-intro">{t('conversation.digestIntro')}</p>
      {state.loading ? <p role="status">{t('conversation.digestLoading')}</p> : null}
      {state.error ? <p role="alert">{state.error}</p> : null}
      {!state.loading && !state.error && !digest ? <EmptyState title={t('conversation.digestEmptyTitle')}>{t('conversation.digestEmpty')}</EmptyState> : null}
      {digest ? <>
        <p className="digest-meta">{t('conversation.digestMeta', { revision: digest.revision, time: new Date(digest.updated_at).toLocaleString(locale()) })}</p>
        {body.notices.includes('compacted_authority') ? <p className="digest-notice" role="note">{t('conversation.digestCompacted')}</p> : null}
        {SECTIONS.map(section => {
          const items = body.items.filter(item => item.section === section);
          return items.length ? <section key={section} className="digest-section" aria-label={t(`conversation.${SECTION_LABEL[section]}`)}>
            <h3>{t(`conversation.${SECTION_LABEL[section]}`)}</h3>
            {items.map(item => <article key={item.id} className="digest-item">
              {editing?.id === item.id ? <form className="digest-edit" onSubmit={event => { event.preventDefault(); change(() => api(`/rooms/${roomId}/digest/items/${item.id}`, 'PATCH', { text: editing.text.trim(), section: editing.section }), t('conversation.digestSaved')); }}>
                <label>{t('conversation.digestTextLabel')}<textarea value={editing.text} maxLength={300} rows={3} onChange={event => setEditing({ ...editing, text: event.target.value })} /></label>
                <label>{t('conversation.digestSectionLabel')}<select value={editing.section} onChange={event => setEditing({ ...editing, section: event.target.value })}>
                  {SECTIONS.map(value => <option key={value} value={value}>{t(`conversation.${SECTION_LABEL[value]}`)}</option>)}</select></label>
                <div className="digest-edit-actions"><button type="button" className="button subtle" onClick={() => setEditing(null)}>{t('conversation.digestCancel')}</button><button className="button primary" disabled={busy || !editing.text.trim()}>{t('conversation.digestSave')}</button></div>
              </form> : <>
                <p>{item.text}</p>
                <div className="digest-item-meta"><span>{item.authors.map(author).join('・')}</span>{item.admin_edited ? <span className="digest-edited">{t('conversation.digestEdited')}</span> : null}{sources(item.sources)}</div>
                {deleting === item.id ? <div className="digest-confirm" role="group" aria-label={t('conversation.digestConfirmDelete')}><span>{t('conversation.digestConfirmDelete')}</span>
                  <button className="button subtle" onClick={() => setDeleting(null)}>{t('conversation.digestCancel')}</button><button className="button danger" disabled={busy} onClick={() => change(() => api(`/rooms/${roomId}/digest/items/${item.id}`, 'DELETE', {}), t('conversation.digestDeleted'))}>{t('conversation.digestDeleteItem')}</button></div>
                  : <div className="digest-item-actions"><IconButton label={t('conversation.digestEditItem')} onClick={() => setEditing({ id: item.id, text: item.text, section: item.section })}><EditIcon size={17} /></IconButton><IconButton label={t('conversation.digestDeleteItem')} onClick={() => setDeleting(item.id)}><TrashIcon size={17} /></IconButton></div>}
              </>}
            </article>)}
          </section> : null;
        })}
        {body.stubs.length || body.older_items ? <section className="digest-section digest-older" aria-label={t('conversation.digestStubs')}>
          <h3>{t('conversation.digestStubs')}</h3>
          {body.stubs.map(stub => <p key={stub.id}><span>{stub.excerpt}</span>{sources(stub.sources)}</p>)}
          {body.older_items ? <p>{t('conversation.digestOlder', { count: body.older_items.count })}<button type="button" className="text-button" onClick={() => onJump(body.older_items.from_message_id)}>{t('conversation.digestOlderJump')}</button></p> : null}
        </section> : null}
        {body.resolved.length ? <details className="digest-resolved"><summary>{t('conversation.digestResolved', { count: body.resolved.length })}</summary>
          {body.resolved.map(entry => <p key={entry.id}><span>{entry.excerpt}</span>{sources([entry.source])}</p>)}</details> : null}
      </> : null}
      {digest ? resetting ? <div className="digest-confirm" role="group" aria-label={t('conversation.digestConfirmReset')}><span>{t('conversation.digestConfirmReset')}</span>
        <button className="button subtle" onClick={() => setResetting(false)}>{t('conversation.digestCancel')}</button><button className="button danger" disabled={busy} onClick={() => change(() => api(`/rooms/${roomId}/digest/reset`, 'POST', {}), t('conversation.digestResetDone'))}>{t('conversation.digestReset')}</button></div>
        : <button className="button subtle digest-reset" onClick={() => setResetting(true)}>{t('conversation.digestReset')}</button> : null}
    </div>
  </Modal>;
}
