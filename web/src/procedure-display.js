import { locale, t } from './i18n.js';

const day = value => { const time = Number(value); return Number.isFinite(time) && time > 0 ? new Date(time).toLocaleDateString(locale(), { month: 'numeric', day: 'numeric' }) : ''; };

/** 手順を何回使ったかと、止めているかを一言で表す。 */
export function procedureUse(item) {
  const last = day(item.last_used_at);
  const use = item.uses ? last ? t('bots.procedureUsesLast', { count: item.uses, last }) : t('bots.procedureUses', { count: item.uses }) : t('bots.procedureNeverUsed');
  return item.enabled ? use : t('bots.procedureStopped', { use });
}
