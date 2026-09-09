const terminal = task => ['completed','cancelled','failed'].includes(task.state) || ['done','canceled','failed'].includes(task.status);
export const activityTime = task => Math.max(task.updated_at || 0, task.progress?.last_activity_at || 0);
export function groupThreadWork(tasks, threads) {
 const rooms=new Map();
 for(const task of tasks.filter(t=>t.business)) {
  const roomId=task.thread||task.room_id,root=task.work_root_id||task.id;
  if(!rooms.has(roomId))rooms.set(roomId,{id:roomId,title:threads.find(t=>t.id===roomId)?.title||'関連するスレッド',purposes:new Map()});
  const room=rooms.get(roomId);if(!room.purposes.has(root))room.purposes.set(root,{id:root,tasks:[]});room.purposes.get(root).tasks.push(task);
 }
 return [...rooms.values()].map(room=>{
  const purposes=[...room.purposes.values()].map(p=>{
   const owner=p.tasks.find(t=>t.id===p.id)||p.tasks[0],active=p.tasks.filter(t=>!terminal(t)),history=p.tasks.filter(terminal);
   const latest=[...p.tasks].sort((a,b)=>activityTime(b)-activityTime(a))[0];
   return {...p,title:owner.title,active,history,latest,members:[...new Set(p.tasks.map(t=>t.member))]};
  }).sort((a,b)=>Number(!!b.active.length)-Number(!!a.active.length)||activityTime(b.latest)-activityTime(a.latest));
  const active=purposes.filter(p=>p.active.length),history=purposes.filter(p=>!p.active.length),latest=purposes.map(p=>p.latest).sort((a,b)=>activityTime(b)-activityTime(a))[0];
  return {...room,purposes,active,history,latest,members:[...new Set(purposes.flatMap(p=>p.members))]};
 }).sort((a,b)=>Number(!!b.active.length)-Number(!!a.active.length)||activityTime(b.latest)-activityTime(a.latest));
}
