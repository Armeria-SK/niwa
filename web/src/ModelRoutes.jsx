import { useEffect, useState } from 'react';
import { api } from './api.js';
import { providerLabel as providerName } from './providers.js';
import { locale, serverText, t } from './i18n.js';

export function ModelRoutes() {
  const [routes, setRoutes] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; let timer;
    async function refresh() {
      try { const next = await api('/model-routes'); if (active) { setRoutes(next); setError(''); } }
      catch (error) { if (active) setError(error.message); }
      if (active) timer = setTimeout(refresh, 2000);
    }
    void refresh(); return () => { active = false; clearTimeout(timer); };
  }, []);
  return <>
    <p className="field-hint">{t('settings.routesHint1')}<br />{t('settings.routesHint2')}</p>
    {routes.map(route => <div key={route.id}>
      <strong>{route.name}</strong>
      <p className="field-hint">{t('settings.routeConfigured', { provider: providerName(route.configured_provider), model: route.configured_model })}</p>
      <p className="field-hint">{route.attempted_at ? <>{t('settings.routeRecent', { provider: providerName(route.provider), model: route.model, reason: t(route.reason === 'quota' ? 'settings.routeQuota' : 'settings.routeConfiguredModel') })}<br /><time dateTime={new Date(route.attempted_at).toISOString()}>{new Date(route.attempted_at).toLocaleString(locale())}</time></> : t('settings.routeNever')}</p>
    </div>)}
    {error ? <p className="field-error" role="alert">{serverText(error)}</p> : null}
  </>;
}
