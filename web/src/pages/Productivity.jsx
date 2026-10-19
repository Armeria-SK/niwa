import {SettingDisclosure} from '../SettingDisclosure.jsx';
import {Markdown} from '../Markdown.jsx';
import {artifactGroups,documentName,kindGroup,kindLabel,qualityLabel} from '../artifact-display.js';
import { formatNumber, locale, serverText, t } from '../i18n.js';
import { rich } from '../i18n-react.js';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Avatar, EmptyState, Modal, Segmented, Switch } from '../components.jsx';
import { CheckCircleIcon, FileIcon, SearchIcon, DownloadIcon, ChatIcon } from '../icons.jsx';
import { WorkspaceFiles } from '../WorkspaceFiles.jsx';
import { ModelCheck } from '../ModelCheck.jsx';

// 記録に入っている値から、画面の言葉の名前を引く表。言葉そのものは描くときに引く（言語を切り替えたときに変わるように）。
const CRITERION_KINDS = { source: 'criterionSource', execution: 'criterionExecution', review: 'criterionReview' };
const EVIDENCE_KINDS = { execution: 'evidenceExecution', source: 'evidenceSource', self_report: 'evidenceSelfReport', unverified_result: 'evidenceUnverified' };
const EVIDENCE_RESULTS = { passed: 'resultPassed', failed: 'resultFailed', retrieved: 'resultRetrieved', wrong_version: 'resultWrongVersion', not_executed: 'resultNotExecuted', unknown: 'resultUnknown', unavailable: 'resultUnavailable', unverifiable: 'resultUnverifiable' };
const ASSESSMENTS = { supports: 'assessmentSupports', contradicts: 'assessmentContradicts', uncertain: 'assessmentUncertain' };
const CHECK_VERDICTS = { pass: 'verdictPass', fail: 'needsChanges', unknown: 'verdictUnknown' };
const label = (keys, value) => Object.hasOwn(keys, value) ? t(`artifacts.${keys[value]}`) : undefined;


const READY = 'ができました';
/** できごとの見出し。言い換えるのはサーバーが作った見出しだけで、依頼の文やBotが書いた見出しはそのまま出す。
 * 成果物ができた知らせ（「名前ができました」）は、名前を入れて今の言語の文にする。 */
function updateTitle(item) {
  if (item.kind === 'done' && item.artifact && item.title.endsWith(READY)) return t('artifacts.outputReady', { name: item.title.slice(0, -READY.length) });
  return item.kind === 'done' ? item.title : serverText(item.title);
}
export function Recap({ updates, seen, onRead, members, onThread, onArtifact, onActivity }) {
  const [showRead, setShowRead] = useState(false);
  const unread = updates.filter(item => !seen[item.id]);
  const visible = showRead ? updates : unread;
  return <section className="recap-view">
    <div className="section-toolbar"><div><h2>{t('artifacts.recapTitle')}</h2><p className="muted">{t('artifacts.recapLead')}</p></div><button className="button secondary" disabled={!unread.length} onClick={() => onRead(unread.map(item => item.id))}>{t('artifacts.markAllSeen')}</button></div>
    <div className="recap-counts" aria-label={t('artifacts.unseenRecapLabel')}>{[['decision', t('artifacts.unseenDecisions')]].map(([kind, label]) => <span key={kind}>{label}<strong>{unread.filter(item => item.kind === kind).length}</strong></span>)}</div>
    <label className="read-toggle"><input type="checkbox" checked={showRead} onChange={e => setShowRead(e.target.checked)} />{t('artifacts.showSeen')}</label>
    {visible.length ? <div className="update-list">{visible.map(item => <article className={`update-item ${seen[item.id] ? 'is-read' : ''}`} key={item.id}><Avatar member={members[item.member]} size={36} /><div><div className="update-meta"><span>{({ done: t('artifacts.updateDone'), decision: t('artifacts.updateDecision'), question: t('artifacts.updateQuestion') })[item.kind]}</span><time>{new Date(item.created_at).toLocaleString(locale())}</time>{seen[item.id] ? <span>{t('artifacts.seen')}</span> : null}</div><h3>{updateTitle(item)}</h3><p>{serverText(item.detail)}</p><div className="inline-actions">{item.artifact ? <button className="text-button" onClick={() => onArtifact(item.artifact)}><FileIcon size={16} />{t('artifacts.viewOutput')}</button> : null}{item.activity ? <button className="text-button" onClick={() => onActivity(item.activity)}>{t('artifacts.viewTask')}</button> : null}{item.thread ? <button className="text-button" onClick={() => onThread(item.thread)}><ChatIcon size={16} />{t('artifacts.originalConversation')}</button> : null}{!seen[item.id] ? <button className="text-button" onClick={() => onRead([item.id])}>{t('artifacts.markSeen')}</button> : null}</div></div></article>)}</div> : <EmptyState icon={CheckCircleIcon} title={t('artifacts.recapEmptyTitle')}>{t('artifacts.recapEmptyBody')}</EmptyState>}
  </section>;
}

export function ArtifactLibrary({ onDelete, artifacts, members, onOpen, onThread }) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [quality,setQuality]=useState(null),[qualityError,setQualityError]=useState(''),[qualityBusy,setQualityBusy]=useState(false);
  useEffect(()=>{let active=true;api('/quality').then(data=>{if(active)setQuality(data);}).catch(e=>{if(active)setQualityError(e.message);});return()=>{active=false;};},[]);
  async function changeQuality(enabled){setQualityBusy(true);try{await api('/quality','PATCH',{enabled});setQuality({enabled});setQualityError('');}catch(e){setQualityError(e.message);}finally{setQualityBusy(false);}}
  const [query, setQuery] = useState(''); const [kind, setKind] = useState('all'); const [owner, setOwner] = useState('all');
  const search = query.trim(); const revision = artifacts.map(item => item.id).join(',');
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!search) return;
    let active = true;
    const timer = setTimeout(() => {
      api(`/artifacts?query=${encodeURIComponent(search)}`).then(items => {
        if (active) setResult({ search, revision, ids: new Set(items.map(item => item.id)) });
      }).catch(error => { if (active) setResult({ search, revision, error: error.message }); });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [search, revision]);
  const current = result?.search === search && result?.revision === revision ? result : null;
  const pending = !!search && !current;
  const groups=artifactGroups(artifacts);
  const matches=item=>(kind==='all'||kindGroup(item.kind)===kind)&&(owner==='all'||item.member===owner)&&(!search||current?.ids?.has(item.id)||`${item.name} ${item.description} ${members[item.member]?.name}`.toLowerCase().includes(search.toLowerCase()));
  const visible=groups.map(group=>({...group,matches:(search?group.versions:[group.latest]).filter(matches)})).filter(group=>group.matches.length).map(group=>({...group,item:search?group.matches[0]:group.latest}));
  return <section>
    <SettingDisclosure title={t('artifacts.qualityTitle')} value={qualityBusy?t('artifacts.savingShort'):quality?quality.enabled?t('artifacts.enabled'):t('artifacts.disabled'):qualityError?t('artifacts.loadFailedShort'):t('artifacts.loadingShort')} busy={qualityBusy}>{quality?<Switch label={t('artifacts.qualitySwitch')} checked={quality.enabled} disabled={qualityBusy} onChange={changeQuality}/>:null}<p className="muted">{t('artifacts.qualityNoteNewTasks')}<br />{t('artifacts.qualityNoteLightChats')}</p>{qualityError?<p role="alert">{qualityError}</p>:null}</SettingDisclosure>{workspaceOpen ? <WorkspaceFiles onClose={() => setWorkspaceOpen(false)} /> : null}<div className="section-toolbar"><div><h2>{t('artifacts.title')}</h2><p className="muted">{t('artifacts.libraryLead')}</p></div><div className="inline-actions"><span className="muted">{t('common.items', { count: visible.length })}</span><button className="button secondary" onClick={() => setWorkspaceOpen(true)}>{t('artifacts.sharedFolder')}</button></div></div>
    <div className="artifact-filters"><div className="search-field"><SearchIcon size={18} /><input type="search" aria-label={t('artifacts.searchLabel')} placeholder={t('artifacts.searchPlaceholder')} maxLength={200} value={query} onChange={e => setQuery(e.target.value)} /></div><label className="field"><span>{t('artifacts.creator')}</span><select aria-label={t('artifacts.creator')} value={owner} onChange={e => setOwner(e.target.value)}><option value="all">{t('artifacts.everyone')}</option>{Object.values(members).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label></div>
    <Segmented className="artifact-kinds" label={t('artifacts.kindsLabel')} value={kind} onChange={setKind} options={[{ value: 'all', label: t('artifacts.allKinds') }, ...[...new Map(artifacts.map(item => [kindGroup(item.kind), kindLabel(item.kind)]))].map(([value, label]) => ({ value, label }))]} />
    {pending ? <p role="status">{t('artifacts.searching')}</p> : current?.error ? <p role="alert">{t('artifacts.searchFailed', { message: current.error })}</p> : null}
    {visible.length ? <div className="artifact-grid">{visible.map(({item,latest,versions,matches}) => <article className="artifact-card" key={item.id}><div className="artifact-card-meta"><FileIcon size={25} /><span>{kindLabel(item.kind)} · {item.scope === 'shared' ? t('artifacts.scopeShared') : t('artifacts.scopePrivate')}</span></div><button className="artifact-title" onClick={() => onOpen(item.id)}>{documentName(item.name)}</button><div className="artifact-version-badges"><span>{t('artifacts.versionNumber', { version: item.version||1 })} · {item.id===latest.id?t('artifacts.latestVersion'):t('artifacts.pastVersionMatch')}</span><span>{qualityLabel(item.quality_status)}</span></div><p>{item.description}</p><details><summary>{t('artifacts.versionHistory', { count: versions.length })}</summary>{versions.map(version=><p key={version.id}><button className="text-button" onClick={()=>onOpen(version.id)}>{t('artifacts.versionNumber', { version: version.version||1 })}{version.id===latest.id?t('artifacts.latestSuffix'):''} · {qualityLabel(version.quality_status)}{search&&matches.some(m=>m.id===version.id)?` · ${t('artifacts.searchMatch')}`:''}</button></p>)}</details><div className="artifact-owner"><Avatar member={members[item.member]} size={24} /><span>{members[item.member]?.name}</span><time>{new Date(item.created_at).toLocaleString(locale())}</time></div><div className="inline-actions"><button className="button secondary" onClick={() => onOpen(item.id)}>{t('common.open')}</button><button className="text-button" onClick={() => onThread(item.thread)}>{t('artifacts.relatedConversation')}</button><button className="text-button" onClick={() => onDelete(item.id)} aria-label={t('artifacts.deleteNamed', { name: item.name })}>{t('common.delete')}</button></div></article>)}</div> : pending || current?.error ? null : query.trim() || kind !== 'all' || owner !== 'all' ? <EmptyState icon={SearchIcon} title={t('artifacts.noMatchTitle')} action={<button className="text-button" onClick={() => { setQuery(''); setKind('all'); setOwner('all'); }}>{t('artifacts.clearFilters')}</button>}>{t('artifacts.noMatchBody')}</EmptyState>
      : <EmptyState icon={FileIcon} title={t('artifacts.emptyTitle')}>{t('artifacts.emptyBody')}<br />{t('artifacts.emptyHint')}</EmptyState>}
  </section>;
}

export function ArtifactPreview({ onDelete, artifact, members, onClose, onThread, onOpen }) {
  const [checks,setChecks]=useState({});const [raw,setRaw]=useState(false);
  useEffect(()=>setChecks({}),[artifact.id]);
  const [note,setNote]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function record(action,verdict) {
    if(busy)return;setBusy(true);setError('');
    try {await api(`/artifacts/${artifact.id}/${action}`,'POST',{expected_sha256:artifact.sha256,...(action==='review'?{verdict,note,...(artifact.quality?{checks:artifact.quality.plan.criteria.map(c=>({criterion:c.id,verdict:checks[c.id]?.verdict||'unknown',note:checks[c.id]?.note||''}))}:{})}: {})});await onOpen(artifact.id);setNote('');}
    catch(e){setError(e.message);}finally{setBusy(false);}
  }
  async function download() {
    setBusy(true);setError('');
    try{const result=artifact.file?await api(`/artifacts/${artifact.id}/file`):null;
      const content=result?Uint8Array.from(atob(result.data),c=>c.charCodeAt(0)):artifact.content;
      const url=URL.createObjectURL(new Blob([content],{type:artifact.file?'application/octet-stream':'text/plain;charset=utf-8'}));
      const a=document.createElement('a');a.href=url;a.download=artifact.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){setError(e.message);}finally{setBusy(false);}
  }
  return <Modal drawer title={`${documentName(artifact.name)} · ${t('artifacts.versionNumber', { version: artifact.version||1 })}`} onClose={onClose} className="artifact-modal"><div className="modal-body"><p className="muted">{members[artifact.member || artifact.author_id]?.name} · {t('artifacts.updatedAt', { time: new Date(artifact.created_at).toLocaleString(locale()) })} · {artifact.scope === 'shared' ? t('artifacts.scopeShared') : t('artifacts.scopePrivate')}</p>
    {artifact.sha256 ? <div className="form-stack artifact-version-info"><p>{t('artifacts.versionNumber', { version: artifact.version })}{artifact.versions[0]?.id===artifact.id?t('artifacts.latestSuffix'):t('artifacts.pastSuffix')} · {qualityLabel(artifact.quality_status)} · {artifact.frozen?t('artifacts.frozen'):t('artifacts.notFrozen')} · {t('artifacts.referencedBy', { count: artifact.referenced_by.length })}</p>
      {artifact.quality?<div className="artifact-quality-summary"><p>{artifact.quality.verified?t('artifacts.evidenceComplete'):t('artifacts.evidenceIncomplete')}</p><details><summary>{t('artifacts.criteriaCount', { count: artifact.quality.plan.criteria.length })}</summary>{artifact.quality.plan.criteria.map(c=><p key={c.id}>{c.condition} · {label(CRITERION_KINDS,c.kind)}</p>)}</details><details><summary>{t('artifacts.evidenceSummary')}</summary>{artifact.quality.evidence.length?artifact.quality.evidence.map(e=><div key={e.id}><p>{rich('artifacts.evidenceLine', { kind: label(EVIDENCE_KINDS,e.kind), result: label(EVIDENCE_RESULTS,e.result)||e.result })}</p><p>{rich('artifacts.evidenceMethod', { method: e.method })}</p>{e.claim?<p>{rich('artifacts.evidenceClaim', { claim: e.claim })}</p>:null}{e.excerpt?<blockquote>{e.excerpt}</blockquote>:null}<p>{rich('artifacts.assessmentLine', { assessment: label(ASSESSMENTS,e.assessment), limits: e.limits||t('artifacts.notStated') })}</p><details><summary>{t('artifacts.evidenceDetails')}</summary><p>{e.url||''}</p>{e.source?<p>{rich('artifacts.savedSource', { kind: e.source.kind, id: e.source.source_id })}<br/>{rich('artifacts.sourceRevision', { revision: e.source.revision })}</p>:null}{e.command_sha256?<p>{rich('artifacts.commandHash', { hash: e.command_sha256 })}</p>:null}<p>{e.executed_at||e.fetched_at||new Date(e.created_at).toLocaleString(locale())}</p>{e.image?<p>{rich('artifacts.evidenceImage', { image: e.image })}<br/>{rich('artifacts.environmentVersion', { environment: e.environment||t('artifacts.baseEnvironment') })}</p>:null}<p>{rich('artifacts.targetSha256', { hash: e.sha256 })}</p></details></div>):<p>{t('artifacts.noEvidence')}</p>}<p>{rich('artifacts.stopCondition', { condition: artifact.quality.plan.stop_condition })}</p></details></div>:null}
      <details><summary>{t('artifacts.versionsAndReviews')}</summary><p>{rich('artifacts.savedName', { name: artifact.name })}</p><p>{rich('artifacts.fixedId', { id: artifact.id })}<br/>{rich('artifacts.sha256', { hash: artifact.sha256 })}</p>
        {artifact.versions.map(version=><p key={version.id}><button className="text-button" disabled={version.id===artifact.id} onClick={()=>onOpen(version.id)}>{t('artifacts.versionNumber', { version: version.version })}{version.id===artifact.id?t('artifacts.currentSuffix'):''}</button> · {new Date(version.created_at).toLocaleString(locale())}{version.frozen?` · ${t('artifacts.frozen')}`:''} · {qualityLabel(version.quality_status)}</p>)}
        {artifact.reviews.length ? artifact.reviews.map(review=><p key={review.reviewer_id}>{rich('artifacts.reviewLine', { reviewer: review.reviewer_id==='administrator'?t('artifacts.administrator'):members[review.reviewer_id]?.name || t('artifacts.deletedBot'), verdict: review.verdict==='approved'?(artifact.quality&&review.evidence_revision!==artifact.quality.revision?t('artifacts.reviewOldEvidence'):t('artifacts.reviewApproved')):t('artifacts.needsChanges'), time: new Date(review.created_at).toLocaleString(locale()) })}<br/>{review.review_model&&review.review_model!=='administrator'?t('artifacts.modelJudgment', { model: review.review_model }):t('artifacts.reviewerJudgment')}<br/>{review.note}{review.checks?JSON.parse(review.checks).map(check=><span key={check.criterion}><br/>{rich('artifacts.checkLine', { condition: artifact.quality?.plan.criteria.find(c=>c.id===check.criterion)?.condition||t('artifacts.criterionFallback'), verdict: label(CHECK_VERDICTS,check.verdict), note: check.note })}</span>):null}</p>) : <p>{t('artifacts.noReviews')}</p>}
        <form className="form-stack" onSubmit={e=>{e.preventDefault();void record('review','approved');}}><label className="field"><span>{t('artifacts.reviewNoteLabel')}</span><textarea value={note} onChange={e=>setNote(e.target.value)} required maxLength={1000} rows={2}/></label>{artifact.quality?.plan.criteria.map(c=><fieldset className="form-stack" key={c.id}><legend>{c.condition}</legend><label className="field"><span>{t('artifacts.verdictLabel')}</span><select value={checks[c.id]?.verdict||'unknown'} onChange={e=>setChecks(v=>({...v,[c.id]:{...v[c.id],verdict:e.target.value}}))}><option value="unknown">{t('artifacts.verdictUnknown')}</option><option value="pass">{t('artifacts.verdictPass')}</option><option value="fail">{t('artifacts.needsChanges')}</option></select></label><label className="field"><span>{t('artifacts.checkedDetails')}</span><textarea rows={2} required minLength={12} maxLength={1000} value={checks[c.id]?.note||''} onChange={e=>setChecks(v=>({...v,[c.id]:{...v[c.id],note:e.target.value}}))}/></label></fieldset>)}<div className="inline-actions"><button className="button secondary" disabled={busy || !note.trim()}>{t('artifacts.recordApproved')}</button><button type="button" className="button subtle" disabled={busy || !note.trim()} onClick={()=>record('review','changes_requested')}>{t('artifacts.recordChanges')}</button></div></form>
        <p className="muted">{t('artifacts.reviewNoteRecord')}<br />{t('artifacts.reviewNoteNotApproval')}<br />{t('artifacts.reviewNoteFreeze')}</p>
        {!artifact.frozen ? <button className="button secondary" disabled={busy || (artifact.quality&&!artifact.quality.verified) || !artifact.reviews.some(item=>item.verdict==='approved') || artifact.reviews.some(item=>item.verdict==='changes_requested')} onClick={()=>record('freeze')}>{t('artifacts.freezeVersion')}</button> : null}
      </details>{error ? <p role="alert">{error}</p> : null}
    </div> : null}{artifact.sha256 && !artifact.file ? <ModelCheck artifact={artifact} authorName={members[artifact.member || artifact.author_id]?.name} onChanged={() => onOpen(artifact.id)} /> : null}{artifact.file?<p>{t(artifact.file.available?'artifacts.fixedFile':'artifacts.fixedFileRestored', { size: formatNumber(artifact.file.size) })}</p>:<div className="artifact-document-view"><label className="read-toggle"><input type="checkbox" checked={raw} onChange={e=>setRaw(e.target.checked)}/>{t('artifacts.showRaw')}</label>{raw||['code','csv','json'].includes(artifact.kind)?<pre className="artifact-document">{artifact.content}</pre>:<Markdown text={artifact.content}/>}</div>}</div><div className="form-actions"><button className="button subtle" onClick={() => { onClose(); onThread(artifact.thread || artifact.room_id); }}>{t('artifacts.relatedConversation')}</button><button className="button subtle" onClick={onDelete}>{t('artifacts.deleteVersion')}</button><button className="button primary" disabled={busy||artifact.file?.available===0} onClick={download}><DownloadIcon size={17} />{t('artifacts.download')}</button></div></Modal>;
}
