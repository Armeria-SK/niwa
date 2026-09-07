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

/** All paths originate at the product root. Listening is loopback-only for the HTTPS proxy. */
export async function startService(root: string, resolve?: ResolveAdapter, portOverride?: number) {
  const paths = initializeProduct(root);
  const unlock = acquireProcessLock(join(paths.runtime, 'sockets', 'service-lock.db'));
  let runtime: Runtime | undefined; let scheduler: Scheduler | undefined; let server: Server | undefined;
  let backups: Backups | undefined;
  let subscription: Subscription | undefined;
  let xPosts: XPostLog | undefined;
  let xAuth: XOAuth | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const closed = server ? new Promise<void>(done => { server!.close(() => done()); server!.closeAllConnections(); }) : Promise.resolve();
    xAuth?.close(); await scheduler?.stop(); await xPosts?.close(); await subscription?.close(); await backups?.stop(); await closed;
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
    scheduler = new Scheduler(runtime, new TurnRunner(runtime, resolve ?? models.resolve, {
      ...(xApi && xPosts ? { x: { api: xApi, posts: xPosts } } : {}),
      ...(config.browserExecutorUid ? { browser: configuredBrowserExecutor(join(paths.runtime, 'sockets', 'browser.sock'), config.browserExecutorUid) } : {}),
      ...(config.programExecutorUid ? { program: configuredProgramExecutor(join(paths.runtime, 'sockets', 'program.sock'), config.programExecutorUid) } : {}),
      ...(searchKey ? { search: braveSearch(searchKey) } : {}),
      ...(config.workspaceExecutorUid ? {
        workspace: configuredWorkspaceReader(join(paths.runtime, 'sockets', 'workspace.sock'), config.workspaceExecutorUid),
        workspaceWrite: configuredWorkspaceWriter(join(paths.runtime, 'sockets', 'workspace.sock'), config.workspaceExecutorUid),
      } : {}),
    }));
    server = createApiServer(runtime, auth, models, fileURLToPath(new URL('../client/', import.meta.url)), backups,
      config.workspaceExecutorUid ? { read: configuredWorkspaceReader(join(paths.runtime, 'sockets', 'workspace.sock'), config.workspaceExecutorUid),
        download: configuredWorkspaceDownloader(join(paths.runtime, 'sockets', 'workspace.sock'), config.workspaceExecutorUid) } : undefined, xAuth);
    await new Promise<void>((done, reject) => {
      server!.once('error', reject);
      server!.listen(portOverride ?? config.port, '127.0.0.1', () => { server!.removeListener('error', reject); done(); });
    });
    scheduler.start();
    backups.start();
    return { paths, runtime, server, backups, close };
  } catch (error) { await close(); throw error; }
}
