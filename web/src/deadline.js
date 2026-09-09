import {NO_DEADLINE} from '../../src/domain/deadline.ts';
export const validTime=value=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<NO_DEADLINE;
export const deadlineLabel=value=>value==null||value===NO_DEADLINE?'期限なし':validTime(value)?'期限：'+new Date(value).toLocaleString('ja-JP'):'期限未確認';
