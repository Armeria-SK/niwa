import {ChevronRightIcon} from './icons.jsx';
import './SettingDisclosure.css';
export function SettingDisclosure({title,value,children,className='',busy=false}) {
 return <details className={`setting-disclosure ${className}`} aria-busy={busy}>
  <summary><span className="setting-name">{title}</span><span className="setting-value">{value}</span><ChevronRightIcon size={16} aria-hidden="true"/></summary>
  <div className="setting-content">{children}</div>
 </details>;
}
