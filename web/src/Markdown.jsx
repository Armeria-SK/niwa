import {Children} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {MentionText} from './MentionText.jsx';
import {safeUrl} from './markdown-url.js';
import {remarkChatBreaks} from './markdown-breaks.js';
import {t} from './i18n.js';
import './Markdown.css';
/** No raw HTML or remote image fetches. Links leave Niwa explicitly. */
export function Markdown({text,members,breaks=false}) {
 const inline=children=>members?Children.toArray(children).map((child,i)=>typeof child==='string'?<MentionText key={i} text={child} members={members}/>:child):children;
 return <div className="markdown-body"><ReactMarkdown remarkPlugins={breaks?[remarkGfm,remarkChatBreaks]:[remarkGfm]} skipHtml urlTransform={safeUrl} components={{
  a:({href,children})=>href?<a href={href} target="_blank" rel="noopener noreferrer" download={href.startsWith('/') ? '' : undefined}>{children}</a>:<span>{children}</span>,
  img:({alt})=><span className="muted">{alt ? t('conversation.imageAlt',{alt}) : t('conversation.imageBlocked')}</span>,
  p:({children})=><p>{inline(children)}</p>,
  table:({children})=><div className="markdown-table" tabIndex={0} role="region" aria-label={t('conversation.tableRegion')}><table>{children}</table></div>
 }}>{text}</ReactMarkdown></div>;
}
