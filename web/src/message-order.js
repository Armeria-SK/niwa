export const messageOrder=(a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at)||a.sequence-b.sequence||a.id.localeCompare(b.id);
export const mergeMessages=(...pages)=>[...new Map(pages.flat().map(message=>[message.id,message])).values()].sort(messageOrder);
