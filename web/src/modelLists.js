import { api } from './api.js';
import { modelListPath } from './providers.js';

/** 接続先の設定が変わったことを、モデルを選ぶ欄へ知らせる。知らせると、使い回していた一覧も捨てる。 */
export const MODELS_CHANGED = 'niwa:models-changed';
const cache = new Map();
export const notifyModelsChanged = () => { cache.clear(); window.dispatchEvent(new Event(MODELS_CHANGED)); };

/** 同じ画面に選ぶ欄がいくつあっても、接続先へ聞くのは1分に1回にする。失敗した答えは使い回さない。 */
function cached(path, now = Date.now()) {
  const hit = cache.get(path);
  if (hit && now - hit.at < 60_000) return hit.promise;
  const promise = api(path);
  promise.catch(() => { if (cache.get(path)?.promise === promise) cache.delete(path); });
  cache.set(path, { at: now, promise });
  return promise;
}

/** 保存済みの接続先（つながっているはずのもの）。 */
export const readyProviders = async () => (await cached('/model-ready')).providers;
/** その接続先で使えるモデルの一覧。名前を読むだけで、応答の生成（課金対象）はしない。 */
export const providerModels = async provider => (await cached(modelListPath(provider))).map(item => ({ ...item, provider, model: item.model || item.model_id }));
