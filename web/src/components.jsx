import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { SHAPES, PALETTE, MOTIONS } from './data.js';
import { CloseIcon, UserIcon, CheckIcon, InfoIcon } from './icons.jsx';
import { splitSentences } from './sentences.js';
import { avatarMotion, avatarParts, blinkTiming } from './avatar.js';
import { t } from './i18n.js';

// 形のSVGは、ビルド時に文字列として取り込み、体と目に分けておく。
const SHAPE_PARTS = Object.fromEntries(Object.entries(import.meta.glob('./avatars/avatar-*.svg', { query: '?raw', import: 'default', eager: true }))
  .map(([path, svg]) => [/avatar-([a-z]+)\.svg$/.exec(path)[1], avatarParts(svg)]));

/** Botのアイコン。体の形に色を塗り、目は穴として抜く。目は別の部品なので、瞬きや、休眠中に閉じることができる。
 * motion を渡すと見本として表示し（プロフィールの編集など）、渡さなければ member の状態に合わせて動く。 */
export function Avatar({ member, shape, color, motion, size = 48, className = '' }) {
  const mask = `avatar-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  if (!member && !shape) return <span className={`human-avatar ${className}`} style={{ width: size, height: size }} aria-hidden="true"><UserIcon size={size * .8} weight="light" /></span>;
  const parts = SHAPE_PARTS[shape || member?.shape] || SHAPE_PARTS.pebble;
  const animation = motion !== undefined ? avatarMotion({ preference: motion, preview: true })
    : avatarMotion({ preference: member?.motion || 'auto', runtime: member?.runtimeMotion, sleeping: member?.status === 'sleeping', paused: member?.activity === t('shell.statusPaused') });
  const blink = blinkTiming(member?.id || `${shape}${color}`);
  return <svg className={`bot-avatar ${className}`} data-motion={animation} aria-hidden="true" focusable="false" viewBox="0 0 100 100" width={size} height={size}
    style={{ width: size, height: size, '--blink-period': `${blink.period}s`, '--blink-delay': `${blink.delay}s` }}>
    <mask id={mask}><path d={parts.body} fill="#fff" />{parts.eyes.map((eye, index) => <path key={index} className="bot-eye" d={eye} fill="#000" />)}</mask>
    <rect width="100" height="100" fill={color || member?.color || '#61B8A5'} mask={`url(#${mask})`} />
  </svg>;
}

export function IconButton({ label, children, className = '', ...props }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

/** 動きを減らす設定の端末では、出し入れの動きを待たずに閉じる。 */
export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** 重ねて出す窓。drawer は画面の右から出る脇の欄（スマートフォンでは全面）で、後ろの画面を見失わずに詳しく読むためのもの。
 * 閉じる・Esc・外側を押したときは、さっと下がる動きを見せてから閉じる（呼び出し側が直接閉じたときは、すぐに消える）。 */
export function Modal({ title, children, onClose, className = '', drawer = false }) {
  const ref = useRef(null);
  const titleId = useId();
  const [closing, setClosing] = useState(false);
  const timer = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog.showModal();
    return () => { clearTimeout(timer.current); dialog.close(); previous?.focus?.(); };
  }, []);
  // 脇の欄では見出しの高さを --modal-top-height に置き、中で上に留まる欄（記憶の検索など）が見出しの下で止まるようにする。
  useEffect(() => {
    const dialog = ref.current, top = dialog?.querySelector(':scope > .modal-top');
    if (!drawer || !top || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => dialog.style.setProperty('--modal-top-height', `${top.offsetHeight}px`));
    observer.observe(top);
    return () => observer.disconnect();
  }, [drawer]);
  function requestClose() {
    if (timer.current) return;
    if (reducedMotion()) { onClose(); return; }
    setClosing(true);
    timer.current = setTimeout(() => { timer.current = null; setClosing(false); onClose(); }, drawer ? 260 : 190);
  }
  return <dialog ref={ref} className={`modal ${drawer ? 'drawer' : ''} ${closing ? 'closing' : ''} ${className}`} aria-labelledby={titleId} onCancel={e => { e.preventDefault(); requestClose(); }} onClick={e => { if (e.target === e.currentTarget) { const box = e.currentTarget.getBoundingClientRect(); if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) requestClose(); } }}>
    <div className="modal-top"><h2 id={titleId}>{title}</h2><IconButton label={t('common.close')} onClick={requestClose}><CloseIcon size={21} /></IconButton></div>
    {children}
  </dialog>;
}

/** 選んだものの印が、次の選択肢へすべって移る切り替え。underline は下線の印（タブ）、それ以外は面の印。 */
export function Segmented({ label, options, value, onChange, className = '', underline = false }) {
  const ref = useRef(null);
  const [pill, setPill] = useState(null);
  const shape = options.map(option => typeof option === 'string' ? option : `${option.value}:${option.label}:${option.count ?? ''}`).join('|');
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    let frame = 0;
    const measure = () => {
      const button = root.querySelector('button[aria-pressed="true"]');
      if (!button) { setPill(null); return; }
      setPill(current => {
        const next = { x: button.offsetLeft, y: button.offsetTop + (underline ? button.offsetHeight - 3 : 0), w: button.offsetWidth, h: underline ? 3 : button.offsetHeight, ready: current?.ready ?? false };
        return current && ['x', 'y', 'w', 'h'].every(key => current[key] === next[key]) ? current : next;
      });
      frame = requestAnimationFrame(() => setPill(current => current && !current.ready ? { ...current, ready: true } : current));
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(root);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => { observer?.disconnect(); cancelAnimationFrame(frame); };
  }, [value, shape, underline]);
  return <div ref={ref} className={`segmented ${underline ? 'underline' : ''} ${className}`} role="group" aria-label={label}>
    {pill ? <span className={`segmented-pill ${pill.ready ? 'ready' : ''}`} aria-hidden="true" style={{ width: pill.w, height: pill.h, transform: `translate(${pill.x}px, ${pill.y}px)` }} /> : null}
    {options.map(option => {
      const item = typeof option === 'string' ? { value: option, label: option } : option;
      return <button key={item.value} type="button" aria-pressed={item.value === value} className={value === item.value ? 'selected' : ''} onClick={() => onChange(item.value)}>{item.label}{item.count != null ? <span className="segment-count">{item.count}</span> : null}</button>;
    })}
  </div>;
}

/** 文ごとに改行して読みやすくする。文字列でない中身はそのまま出す。 */
export function Sentences({ children }) {
  if (typeof children !== 'string') return children ?? null;
  return splitSentences(children).map((part, index) => <Fragment key={index}>{index ? <br /> : null}{part}</Fragment>);
}

export function SetupNotice({ notice, onConnect }) {
  return <div className="inline-notice setup-notice" role="status"><InfoIcon size={20} /><div><strong>{notice.title}</strong><p><Sentences>{notice.body}</Sentences></p><button type="button" className="button primary" onClick={onConnect}>{t('shell.connectModel')}</button></div></div>;
}

export function EmptyState({ icon: Icon = InfoIcon, title, children, action }) {
  return <div className="empty-state"><Icon size={34} weight="light" /><h3>{title}</h3>{children ? <p><Sentences>{children}</Sentences></p> : null}{action}</div>;
}

export function AppearanceFields({ draft, onChange }) {
  const { shape, motion = 'auto' } = draft;
  const valid = /^#[0-9a-f]{6}$/i.test(draft.color);
  const color = valid ? draft.color : '#61B8A5';
  const chooseColor = value => onChange('color', value.toUpperCase());
  return <div className="appearance-editor">
    <div className="avatar-preview"><Avatar shape={shape} color={color} motion={motion} size={88} /><div><strong>{draft.name}</strong><span>{t('shell.appearanceTagline')}</span></div></div>
    <fieldset><legend>{t('shell.shapeLegend')}</legend><div className="shape-picker">{SHAPES.map(item => <button key={item.id} type="button" className={shape === item.id ? 'shape-option selected' : 'shape-option'} aria-label={item.name} aria-pressed={shape === item.id} onClick={() => onChange('shape', item.id)}><Avatar shape={item.id} color={color} size={47} /><span>{item.name}</span></button>)}</div></fieldset>
    <fieldset><legend>{t('shell.motionLegend')}</legend><MotionPicker value={motion} onChange={value => onChange('motion', value)} /></fieldset>
    <fieldset><legend>{t('shell.colorLegend')}</legend><div className="swatches">{PALETTE.map(item => <button key={item.color} type="button" title={item.name} aria-label={item.name} aria-pressed={color.toLowerCase() === item.color.toLowerCase()} className={color.toLowerCase() === item.color.toLowerCase() ? 'swatch selected' : 'swatch'} style={{ '--swatch': item.color }} onClick={() => chooseColor(item.color)}>{color.toLowerCase() === item.color.toLowerCase() ? <CheckIcon size={16} weight="bold" /> : null}</button>)}</div></fieldset>
    <label className="field"><span>{t('shell.customColor')}</span><div className="color-custom"><input type="color" aria-label={t('shell.colorPicker')} value={color} onChange={e => chooseColor(e.target.value)} /><input aria-label={t('shell.colorCode')} value={draft.color} maxLength={7} spellCheck="false" onChange={e => { onChange('color', e.target.value); }} /></div>{!valid ? <small className="field-error">{t('shell.colorInvalid')}</small> : null}</label>
    <p className="field-hint"><Sentences>{t('shell.appearanceHint')}</Sentences></p>
  </div>;
}

export function AppearanceEditor({ member, onSave, onCancel }) {
  const [draft, setDraft] = useState(member);
  const [saving, setSaving] = useState(false);
  const working = useRef(false);
  const valid = /^#[0-9a-f]{6}$/i.test(draft.color);
  return <form className="appearance-editor" onSubmit={async e => {
    e.preventDefault();
    if (!valid || working.current) return;
    working.current = true; setSaving(true);
    try {
      const version = await onSave({ shape: draft.shape, color: draft.color, motion: draft.motion || 'auto', profile_version: draft.profile_version });
      if (version) setDraft(current => ({ ...current, profile_version: version }));
    } finally { working.current = false; setSaving(false); }
  }}>
    <AppearanceFields draft={draft} onChange={(key, value) => setDraft(current => ({ ...current, [key]: value }))} />
    <div className="form-actions">{onCancel ? <button type="button" className="button subtle" onClick={onCancel}>{t('shell.cancelAction')}</button> : null}<button type="button" className="button subtle" onClick={() => setDraft(member)}>{t('shell.loadLatest')}</button><button className="button primary" disabled={!valid || saving}>{saving ? t('common.saving') : t('common.save')}</button></div>
  </form>;
}

export function Switch({ checked, onChange, label, description, disabled = false }) {
  return <label className="switch-row"><span><strong>{label}</strong>{description ? <small><Sentences>{description}</Sentences></small> : null}</span><input type="checkbox" role="switch" disabled={disabled} checked={checked} onChange={e => onChange(e.target.checked)} /><span className="switch-track" aria-hidden="true" /></label>;
}

export function StatusLabel({ member, paused = false, showDescription = true }) {
  const sleeping = member.status === 'sleeping';
  const activity = sleeping ? t('shell.statusDormant') : paused ? t('shell.statusPaused') : (member.activity || '');
  const separator = activity.indexOf(' · ');
  const status = separator < 0 ? activity : activity.slice(0, separator);
  const description = !showDescription || separator < 0 ? '' : activity.slice(separator + 3).trim();
  return <span title={activity} className={`status-label ${sleeping || paused ? 'muted-status' : ''}`}><span className="status-dot" /><span className="status-copy"><span className="status-name">{status}{description ? t('shell.statusColon') : ''}</span>{description ? <span className="status-description">{description}</span> : null}</span></span>;
}

export function MotionPicker({ value, onChange }) {
  return <>
    <Segmented label={t('shell.motionLabel')} className="motion-picker" value={value} onChange={onChange} options={MOTIONS} />
    {value === 'auto' ? <p className="field-hint"><Sentences>{t('shell.motionAutoHint')}</Sentences></p> : null}
    <p className="field-hint">{t('shell.motionBlinkHint')}</p>
  </>;
}
