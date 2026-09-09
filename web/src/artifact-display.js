export const qualityLabel = status => ({unchecked:'未確認',checking:'確認中',changes_requested:'変更要求',verified:'確認済み',reviewed:'内容の確認済み（実行証拠は別）'})[status] || '未確認';
export const kindLabel = kind => ({research_and_execution_plan:'調査・実行計画',research_memo:'調査メモ',research:'調査',report:'報告書',plan:'計画',memo:'メモ',code:'コード',markdown:'文書',text:'テキスト',document:'文書',manifest:'ファイル一覧',file:'ファイル'})[kind] || (typeof kind==='string'&&/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(kind)&&!/[\x00-\x1f]/.test(kind)&&kind.length<=60?kind:'その他の資料');
// Display only: immutable filenames and downloads retain their original spelling.
export const documentName = name => name.replace(/(?:[ _-]+|（|\()v\d+(?:\.\d+)*(?:）|\))?(?=\.[a-z]{1,8}$|$)/i,'');
export function artifactGroups(artifacts) {
 const groups=new Map();
 for(const item of artifacts){const key=JSON.stringify([item.room_id||item.thread,item.series_id||item.id]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
 return [...groups.values()].map(versions=>{versions.sort((a,b)=>(b.version||1)-(a.version||1)||b.created_at-a.created_at||a.id.localeCompare(b.id));return {latest:versions[0],versions};}).sort((a,b)=>b.latest.created_at-a.latest.created_at||a.latest.id.localeCompare(b.latest.id));
}
