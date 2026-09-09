/** Only unambiguous short status questions get a model-free, read-only answer. */
export function isStatusInquiry(body: string): boolean {
 const value=body.trim().replace(/[？?！!。\s]+$/u,'');
 return /^(?:今(?:は|、)?\s*)?(?:反応がない|返事がない|進捗は|進捗を教えて|状況を教えて|誰が担当(?:している|してる)?(?:の|か)?|誰に仕事を投げて(?:いる|る)(?:の|か)?|誰に依頼して(?:いる|る)(?:の|か)?|担当状況(?:を教えて|を確認)?|今どうなって(?:いる|る)(?:の|か)?)$/u.test(value);
}
export type SubmissionContext={kind:'status'|'new'|'amend'|'cancel';task_id?:string;expected_revision?:number};
