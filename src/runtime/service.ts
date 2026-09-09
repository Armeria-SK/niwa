import {workareaClient} from '../tools/workareas/client.ts';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { initializeProduct } from '../config/paths.ts';
import { adminKey, readInstallation } from '../config/installation.ts';
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
import { braveSearch } from '../tools/web/search.ts';
import { configuredWorkspaceReader, configuredWorkspaceWriter, configuredWorkspaceDownloader } from '../tools/files/client.ts';
import { configuredProgramExecutor } from '../sandbox/client.ts';
import { configuredBrowserExecutor } from '../tools/browser/client.ts';
import { XOAuth } from '../auth/x-oauth.ts';
import { readXClient } from '../auth/x-client.ts';
import { XApi } from '../tools/x/api.ts';
import { XPostLog } from '../tools/x/post-log.ts';
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
  let xPosts: XPostLog | undefined;
  let xAuth: XOAuth | undefined;
  let forms: FormLog | undefined;
  let executionPoll:ReturnType<typeof setInterval>|undefined;let executionPending=Promise.resolve();
  let workareaCleanup:ReturnType<typeof setInterval>|undefined;
  let cleanupPending=Promise.resolve();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    clearInterval(workareaCleanup);clearInterval(executionPoll);await executionPending;await cleanupPending;
    const closed = server ? new Promise<void>(done => { server!.close(() => done()); server!.closeAllConnections(); }) : Promise.resolve();
    xAuth?.close(); await scheduler?.stop(); await forms?.close(); await xPosts?.close(); await subscription?.close(); await backups?.stop(); await closed;
    runtime?.close(); unlock();
  })();
  try {
    const config = readInstallation(root);
    const auth = new WebAuth(config.origin, adminKey(paths));
    runtime = new Runtime(paths.state);
    const admin = runtime.administrator(); runtime.bootstrap(admin); runtime.tasks.recover(admin);
    subscription = new Subscription(new FileCredentialStore(join(paths.secrets, 'codex.json')), () => runtime!.invalidateProvider(admin, 'openai_subscription'));
    const models = new ModelGateway(runtime, fetch, subscription);
    backups = new Backups(runtime, paths, config);
    const searchKey = readSearchKey(paths.secrets);
    const xClient = config.xAccountId ? readXClient(paths.secrets) : undefined;
    xAuth = config.xAccountId && xClient ? new XOAuth(new FileCredentialStore(join(paths.secrets, 'x.json')), xClient, config.xAccountId) : undefined;
    const xApi = xAuth ? new XApi(xAuth) : undefined;
    if (xAuth && xApi) xPosts = new XPostLog(join(paths.runtime, 'x-posts.db'), xAuth.accountId, (post, signal) => xApi.post(post, signal));
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
      ...(xApi && xPosts ? { x: { api: xApi, posts: xPosts } } : {}),
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
    },{promptVersion:config.promptVersion??'legacy-v4'}));
    server = createApiServer(runtime, auth, models, fileURLToPath(new URL('../client/', import.meta.url)), backups,
      config.workspaceExecutorUid ? { read: configuredWorkspaceReader(join(paths.runtime, 'sockets', 'workspace.sock'), config.workspaceExecutorUid),
        download: configuredWorkspaceDownloader(join(paths.runtime, 'sockets', 'workspace.sock'), config.workspaceExecutorUid) } : undefined, xAuth, workareas);
    await new Promise<void>((done, reject) => {
      server!.once('error', reject);
      server!.listen(portOverride ?? config.port, '127.0.0.1', () => { server!.removeListener('error', reject); done(); });
    });
    scheduler.start();
    backups.start();
    return { paths, runtime, server, backups, close };
  } catch (error) { await close(); throw error; }
}
