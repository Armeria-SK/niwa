import { useEffect, useId, useRef, useState } from 'react';
import { SHAPES, PALETTE } from './data.js';
import { CloseIcon, UserIcon, CheckIcon, InfoIcon } from './icons.jsx';

export function Avatar({ member, shape, color, motion, size = 48, className = '' }) {
  if (!member && !shape) return <span className={`human-avatar ${className}`} style={{ width: size, height: size }} aria-hidden="true"><UserIcon size={size * .8} weight="light" /></span>;
  const preference = motion ?? member?.motion ?? 'auto';
  const stopped = motion === undefined && (member?.status === 'sleeping' || member?.activity === '一時停止中');
  const animation = stopped ? 'none' : preference === 'auto' ? (motion !== undefined ? 'sway' : member?.runtimeMotion || 'none') : preference;
  return <span className={`bot-avatar ${className}`} data-motion={animation} aria-hidden="true" style={{ width: size, height: size, backgroundColor: color || member?.color, maskImage: `url(/assets/avatar-${shape || member?.shape || 'pebble'}.png)` }} />;
}

export function IconButton({ label, children, className = '', ...props }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

export function Modal({ title, children, onClose, className = '' }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus?.(); };
  }, []);
  return <dialog ref={ref} className={`modal ${className}`} aria-labelledby={titleId} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) { const box = e.currentTarget.getBoundingClientRect(); if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) onClose(); } }}>
    <div className="modal-top"><h2 id={titleId}>{title}</h2><IconButton label="閉じる" onClick={onClose}><CloseIcon size={21} /></IconButton></div>
    {children}
  </dialog>;
}

export function Segmented({ label, options, value, onChange, className = '' }) {
  return <div className={`segmented ${className}`} role="group" aria-label={label}>{options.map(option => {
    const item = typeof option === 'string' ? { value: option, label: option } : option;
    return <button key={item.value} type="button" aria-pressed={item.value === value} className={value === item.value ? 'selected' : ''} onClick={() => onChange(item.value)}>{item.label}{item.count != null ? <span className="segment-count">{item.count}</span> : null}</button>;
  })}</div>;
}

export function EmptyState({ icon: Icon = InfoIcon, title, children, action }) {
  return <div className="empty-state"><Icon size={34} weight="light" /><h3>{title}</h3>{children ? <p>{children}</p> : null}{action}</div>;
}

export function AppearanceEditor({ member, onSave, onCancel }) {
  const [version, setVersion] = useState(member.profile_version);
  const [shape, setShape] = useState(member.shape);
  const [motion, setMotion] = useState(member.motion || 'auto');
  const [color, setColor] = useState(member.color);
  const [hex, setHex] = useState(member.color.toUpperCase());
  const valid = /^#[0-9a-f]{6}$/i.test(hex);
  const chooseColor = next => { setColor(next); setHex(next.toUpperCase()); };
  return <form className="appearance-editor" onSubmit={async e => { e.preventDefault(); if (valid) { const next = await onSave({ shape, color: hex, motion, profile_version: version }); if (next) setVersion(next); } }}>
    <div className="avatar-preview"><Avatar shape={shape} color={color} motion={motion} size={88} /><div><strong>{member.name}</strong><span>あなたらしい、かたちと色。</span></div></div>
    <fieldset><legend>かたち</legend><div className="shape-picker">{SHAPES.map(item => <button key={item.id} type="button" className={shape === item.id ? 'shape-option selected' : 'shape-option'} aria-label={item.name} aria-pressed={shape === item.id} onClick={() => setShape(item.id)}><Avatar shape={item.id} color={color} size={47} /><span>{item.name}</span></button>)}</div></fieldset>
    <fieldset><legend>動き</legend><MotionPicker value={motion} onChange={setMotion} /></fieldset>
    <fieldset><legend>カラー</legend><div className="swatches">{PALETTE.map(item => <button key={item.color} type="button" title={item.name} aria-label={item.name} aria-pressed={color.toLowerCase() === item.color.toLowerCase()} className={color.toLowerCase() === item.color.toLowerCase() ? 'swatch selected' : 'swatch'} style={{ '--swatch': item.color }} onClick={() => chooseColor(item.color)}>{color.toLowerCase() === item.color.toLowerCase() ? <CheckIcon size={16} weight="bold" /> : null}</button>)}</div></fieldset>
    <label className="field"><span>好きな色を指定</span><div className="color-custom"><input type="color" aria-label="カラーピッカー" value={color} onChange={e => chooseColor(e.target.value)} /><input aria-label="カラーコード" value={hex} maxLength={7} spellCheck="false" onChange={e => { setHex(e.target.value); if (/^#[0-9a-f]{6}$/i.test(e.target.value)) setColor(e.target.value); }} /></div>{!valid ? <small className="field-error">#と6桁の英数字で指定してください。</small> : null}</label>
    <p className="field-hint">形・色・動きは、いつでも変更できます。端末で動きを減らす設定をしている場合は静止します。</p>
    <div className="form-actions">{onCancel ? <button type="button" className="button subtle" onClick={onCancel}>キャンセル</button> : null}<button type="button" className="button subtle" onClick={() => { setShape(member.shape); setMotion(member.motion || 'auto'); chooseColor(member.color); setVersion(member.profile_version); }}>最新の内容を読み込む</button><button className="button primary" disabled={!valid}>保存</button></div>
  </form>;
}

export function Switch({ checked, onChange, label, description, disabled = false }) {
  return <label className="switch-row"><span><strong>{label}</strong>{description ? <small>{description}</small> : null}</span><input type="checkbox" role="switch" disabled={disabled} checked={checked} onChange={e => onChange(e.target.checked)} /><span className="switch-track" aria-hidden="true" /></label>;
}

export function StatusLabel({ member, paused = false, showDescription = true }) {
  const sleeping = member.status === 'sleeping';
  const activity = sleeping ? '休眠中' : paused ? '一時停止中' : (member.activity || '');
  const separator = activity.indexOf(' · ');
  const status = separator < 0 ? activity : activity.slice(0, separator);
  const description = !showDescription || separator < 0 ? '' : activity.slice(separator + 3).trim();
  return <span title={activity} className={`status-label ${sleeping || paused ? 'muted-status' : ''}`}><span className="status-dot" /><span className="status-copy"><span className="status-name">{status}{description ? '：' : ''}</span>{description ? <span className="status-description">{description}</span> : null}</span></span>;
}

export function MotionPicker({ value, onChange }) {
  return <Segmented label="アイコンの動き" className="motion-picker" value={value} onChange={onChange} options={[{ value: 'auto', label: '状態に合わせる' }, { value: 'none', label: 'なし' }, { value: 'float', label: 'ふわふわ' }, { value: 'sway', label: 'ゆらゆら' }, { value: 'pulse', label: 'ぽよぽよ' }]} />;
}
