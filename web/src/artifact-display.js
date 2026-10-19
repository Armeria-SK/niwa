import {t} from './i18n.js';
const QUALITY={unchecked:'qualityUnchecked',checking:'qualityChecking',changes_requested:'qualityChangesRequested',verified:'qualityVerified',reviewed:'qualityReviewed'};
export const qualityLabel = status => t(`artifacts.${QUALITY[status]||'qualityUnchecked'}`);
const KINDS={research_and_execution_plan:'kindResearchPlan',research_memo:'kindResearchMemo',research:'kindResearch',report:'kindReport',plan:'kindPlan',memo:'kindMemo',code:'kindCode',markdown:'kindDocument',text:'kindText',document:'kindDocument',manifest:'kindManifest',file:'kindFile'};
// Botが自分の言葉で書いた種類の名前（漢字・かな・ハングル）はそのまま見せ、内部の値らしいものは「その他の資料」にまとめる。
const ownKind = kind => typeof kind==='string'&&/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(kind)&&!/[\x00-\x1f]/.test(kind)&&kind.length<=60;
/** 種類で絞り込むときの値。別名（markdown と document）は同じ値にまとめ、言語を切り替えても変わらない。 */
export const kindGroup = kind => Object.hasOwn(KINDS,kind) ? KINDS[kind] : ownKind(kind) ? kind : 'kindOther';
export const kindLabel = kind => { const group=kindGroup(kind); return group==='kindOther'||Object.hasOwn(KINDS,kind) ? t(`artifacts.${group}`) : group; };
// Display only: immutable filenames and downloads retain their original spelling.
export const documentName = name => name.replace(/(?:[ _-]+|（|\()v\d+(?:\.\d+)*(?:）|\))?(?=\.[a-z]{1,8}$|$)/i,'');
export function artifactGroups(artifacts) {
 const groups=new Map();
 for(const item of artifacts){const key=JSON.stringify([item.room_id||item.thread,item.series_id||item.id]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
 return [...groups.values()].map(versions=>{versions.sort((a,b)=>(b.version||1)-(a.version||1)||b.created_at-a.created_at||a.id.localeCompare(b.id));return {latest:versions[0],versions};}).sort((a,b)=>b.latest.created_at-a.latest.created_at||a.latest.id.localeCompare(b.latest.id));
}
