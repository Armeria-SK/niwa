/** Night hours for unattended work, in Japan time like the backup schedule. The preview opens in the evening before the night starts. */
export const NIGHT_START_HOUR = 22, NIGHT_END_HOUR = 7, PREVIEW_FROM_HOUR = 18;
const HOUR = 3_600_000, JST = 9 * HOUR, DAY = 24 * HOUR;

export interface NightWindow { key: string; start: number; end: number }
const dayStart = (now: number) => Math.floor((now + JST) / DAY) * DAY - JST;
const hourOf = (now: number) => new Date(now + JST).getUTCHours();
const windowFrom = (day: number): NightWindow => ({ key: new Date(day + JST).toISOString().slice(0, 10), start: day + NIGHT_START_HOUR * HOUR, end: day + DAY + NIGHT_END_HOUR * HOUR });

/** The night that is running now, or the next one during the day. Its key is the date the night begins. */
export function currentNight(now: number): NightWindow {
  return windowFrom(dayStart(now) - (hourOf(now) < NIGHT_END_HOUR ? DAY : 0));
}
/** The last night that has already ended. */
export function lastNight(now: number): NightWindow {
  return windowFrom(dayStart(now) - (hourOf(now) < NIGHT_END_HOUR ? 2 * DAY : DAY));
}
export const inNight = (now: number) => { const hour = hourOf(now); return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR; };
/** From the evening until the night ends, tonight's plan can be previewed. */
export const previewOpen = (now: number) => { const hour = hourOf(now); return hour >= PREVIEW_FROM_HOUR || hour < NIGHT_END_HOUR; };
