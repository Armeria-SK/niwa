/** Only unambiguous short status questions get a model-free, read-only answer. */
export function isStatusInquiry(body: string): boolean {
 const value=body.trim().replace(/[？?！!。\s]+$/u,'').replace(/^(?:今|現在)(?:は|、)?\s*/u,'');
 // Whole utterance grammar: never swallow an appended action or a quoted question.
 const ending='(?:の|か|ん|ですか|でしょうか|かな|ね)?';
 const silence='(?:反応|返事|応答)(?:が)?(?:ない|なくね|なくない|まだ|止まってる)';
 const assignee='誰(?:が|かが|に|かに)(?:今)?(?:仕事(?:を)?|作業(?:を)?)?(?:担当(?:している|してる)?|投げて(?:いる|る)|依頼して(?:いる|る)|頼んで(?:いる|る)|作業して(?:いる|る))';
 const progress='(?:進捗|状況|担当状況)(?:は|どう|どうなってる|を(?:教えて|確認)(?:ください)?)?';
 return new RegExp('^(?:'+silence+'|'+assignee+'|'+progress+'|どうなって(?:いる|る))'+ending+'$','u').test(value);
}
export type SubmissionContext={kind:'status'|'new'|'amend'|'cancel';task_id?:string;expected_revision?:number};
