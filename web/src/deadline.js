import {NO_DEADLINE} from '../../src/domain/deadline.ts';
import {locale,t} from './i18n.js';
export const validTime=value=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<NO_DEADLINE;
export const deadlineLabel=value=>value==null||value===NO_DEADLINE?t('today.noDeadline'):validTime(value)?t('today.deadlineAt',{time:new Date(value).toLocaleString(locale())}):t('today.deadlineUnknown');
