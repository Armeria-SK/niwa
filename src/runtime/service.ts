import {workareaClient} from '../tools/workareas/client.ts';
import {McpSettings} from '../tools/mcp/settings.ts';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { initializeProduct } from '../config/paths.ts';
import { readInstallation } from '../config/installation.ts';
import { WebAuth } from '../web/auth.ts';
import { createApiServer } from '../web/api.ts';
import { Runtime } from './runtime.ts';
import { Scheduler } from './scheduler.ts';
import { TurnRunner, type ResolveAdapter } from './turns.ts';
import { acquireProcessLock } from './process-lock.ts';
import { ModelGateway } from '../providers/gateway.ts';
import { Backups } from '../backup/backups.ts';
import { Subscription } from '../auth/subscription.ts';
import { FileCredentialStore } from '../auth/credential-store.ts';
import { readSearchKey } from '../auth/search-key.ts';
import { FileApiKeyStore } from '../auth/api-key.ts';
import { braveSearch } from '../tools/web/search.ts';
import { configuredWorkspaceReader, configuredWorkspaceWriter, configuredWorkspaceDownloader } from '../tools/files/client.ts';
import { configuredProgramExecutor } from '../sandbox/client.ts';
import { configuredBrowserExecutor } from '../tools/browser/client.ts';
import { configuredPackageExecutor } from '../tools/packages/client.ts';
import { FormLog } from '../tools/browser/form-log.ts';
import { submitPublicForm } from '../tools/browser/form.ts';

/** All paths originate at the product root. Listening is loopback-only for the HTTPS proxy. */
export async function startService(root: string, resolve?: ResolveAdapter, portOverride?: number) {
  const paths = initializeProduct(root);
  const unlock = acquireProcessLock(join(paths.runtime, 'sockets', 'service-lock.db'));
  let runtime: Runtime | undefined; let scheduler: Scheduler | undefined; let server: Server | undefined;
  let backups: Backups | undefined;
  let subscription: Subscription | undefined;
  let forms: FormLog | undefined;
  let mcpSettings:McpSettings|undefined;
  let executionPoll:ReturnType<typeof setInterval>|undefined;let executionPending=Promise.resolve();
  let workareaCleanup:ReturnType<typeof setInterval>|undefined;
  let cleanupPending=Promise.resolve();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    mcpSettings?.close();
    clearInterval(workareaCleanup);clearInterval(executionPoll);await executionPending;await cleanupPending;
    const closed = server ? new Promise<void>(done => { server!.close(() => done()); server!.closeAllConnections(); }) : Promise.resolve();
    await scheduler?.stop(); await forms?.close(); await subscription?.close(); await backups?.stop(); await closed;
    runtime?.close(); unlock();
  })();
  try {
    const config = readInstallation(root);
    mcpSettings=await McpSettings.open(root,servers=>{config.mcpServers=servers;});
    const auth = new WebAuth(config.origin, config.tailscaleLogins);
    runtime = new Runtime(paths.state);
    const admin = runtime.administrator(); runtime.bootstrap(admin); runtime.tasks.recover(admin); runtime.tasks.recoverProviderWaits(admin,true);
    subscription = new Subscription(new FileCredentialStore(join(paths.secrets, 'codex.json')), () => runtime!.invalidateProvider(admin, 'openai_subscription'), {}, config.reasoningSummary===true);
    const models = new ModelGateway(runtime, fetch, subscription, new FileApiKeyStore(join(paths.secrets, 'openai-compatible-key.json')),
      { key: new FileApiKeyStore(join(paths.secrets, 'anthropic-key.json')), reasoningSummary: config.reasoningSummary === true });
    backups = new Backups(runtime, paths, config);
    const searchKey = readSearchKey(paths.secrets);
    const workareas=config.workareasEnabled&&config.programExecutorUid ? workareaClient(join(paths.runtime,'sockets','program.sock'),config.programExecutorUid):undefined;
    if(workareas){
      await runtime.workareas.syncExecutions(workareas);
      executionPoll=setInterval(()=>{executionPending=executionPending.then(()=>runtime!.workareas.syncExecutions(workareas)).catch(()=>{});},1000);executionPoll.unref();
      await runtime.workareas.purgeRetired(workareas);
      workareaCleanup=setInterval(()=>{cleanupPending=cleanupPending.then(()=>runtime!.workareas.purgeRetired(workareas)).catch(()=>{});},30_000);workareaCleanup.unref();
    }
    if (config.browserExecutorUid) forms = new FormLog(join(paths.runtime, 'forms.db'), (form, signal, scopedReader) => submitPublicForm(form, signal, undefined, undefined,
      scopedReader ?? (config.workspaceExecutorUid ? async (path, signal, area) => {
        if(area)throw new Error('Scoped file reader required');
        const file = await configuredWorkspaceDownloader(join(paths.runtime, 'sockets', 'workspace.sock'), config.workspaceExecutorUid!)(path, signal);
        return {data: file.data as string, revision: file.revision as string};
      } : undefined)));
    scheduler = new Scheduler(runtime, new TurnRunner(runtime, resolve ?? models.resolve, {
      get mcp(){return mcpSettings!.connector;},
      ...(forms ? { forms } : {}),
      ...(workareas ? {workareas}:{}),
      ...(config.browserExecutorUid ? { browser: configuredBrowserExecutor(join(paths.runtime, 'sockets', 'browser.sock'), config.browserExecutorUid) } : {}),
      ...(config.programExecutorUid ? { program: configuredProgramExecutor(join(paths.runtime, 'sockets', 'program.sock'), config.programExecutorUid) } : {}),
      ...(config.packagesEnabled && config.programExecutorUid ? { packages: configuredPackageExecutor(join(paths.runtime, 'sockets', 'program.sock'), config.programExecutorUid) } : {}),
      ...(searchKey ? { search: braveSearch(searchKey) } : {}),
      ...(config.workspaceExecutorUid ? {
        workspace: configuredWorkspaceReader(join(paths.runtime, 'sockets', 'workspace.sock'), config.workspaceExecutorUid),
        workspaceWrite: configuredWorkspaceWriter(join(paths.runtime, 'sockets', 'workspace.sock'), config.workspaceExecutorUid),
      } : {}),
    },{promptVersion:config.promptVersion??'legacy-v4'}), Date.now, resolve ? undefined : () => models.readyProviders());
    server = createApiServer(runtime, auth, models, fileURLToPath(new URL('../client/', import.meta.url)), backups,
      config.workspaceExecutorUid ? { read: configuredWorkspaceReader(join(paths.runtime, 'sockets', 'workspace.sock'), config.workspaceExecutorUid),
        download: configuredWorkspaceDownloader(join(paths.runtime, 'sockets', 'workspace.sock'), config.workspaceExecutorUid) } : undefined, workareas, undefined, mcpSettings);
    await new Promise<void>((done, reject) => {
      server!.once('error', reject);
      server!.listen(portOverride ?? config.port, '127.0.0.1', () => { server!.removeListener('error', reject); done(); });
    });
    scheduler.start();
    backups.start();
    return { paths, runtime, server, backups, close };
  } catch (error) { await close(); throw error; }
}
