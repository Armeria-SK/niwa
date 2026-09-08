import {Type,type Static} from '@sinclair/typebox';
const note=Type.String({maxLength:1000});
const recipient=Type.Union([Type.Null(),Type.String({minLength:1,maxLength:100})]);
export const coordinationUpdateSchema=Type.Object({
 expected_revision:Type.Integer({minimum:0}),
 completion_condition:note,stop_condition:note,blocker:note,
 waiting_for:recipient,next_agent_id:recipient,
 notify:Type.Union([Type.Literal('none'),Type.Literal('involved'),Type.Literal('leader')]),
},{additionalProperties:false});
export type CoordinationUpdate=Static<typeof coordinationUpdateSchema>;
const acknowledgments=new Set(['受領しました','了解しました','承知しました','確認しました','受領です','了解です','承知です','確認です','ありがとうございます','状態を維持します','待機します','引き続き待機します','了解','承知','受領','確認済み']);
export function isAcknowledgment(body:string):boolean {
 const parts=body.trim().split(/[。！!、\s]+/u).filter(Boolean);
 return body.length<=200 && parts.length>0 && parts.every(part=>acknowledgments.has(part));
}
