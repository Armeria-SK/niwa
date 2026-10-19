import { t } from './i18n.js';

// 仕事の状態の呼び名。言語を切り替えたときに変わるよう、読むたびに辞書から引く。
export const taskStatus = {
  get running() { return t('records.statusRunning'); },
  get waiting() { return t('records.statusWaiting'); },
  get paused() { return t('records.statusPaused'); },
  get failed() { return t('records.statusFailed'); },
  get canceled() { return t('records.statusCanceled'); },
  get approval() { return t('records.statusApproval'); },
  get done() { return t('records.statusDone'); },
  get approved() { return t('records.statusApproved'); },
  get declined() { return t('records.statusDeclined'); },
};
