import assert from 'node:assert/strict';
import { readInstallation } from '../../dist/config/installation.js';
import { configuredPackageExecutor } from '../../dist/tools/packages/client.js';
import { configuredBrowserExecutor } from '../../dist/tools/browser/client.js';
import './wait-executors.mjs';
const root='/home/niwa/niwa', config=readInstallation(root);
assert.ok(config.browserExecutorUid && config.packagesEnabled);
const packages=configuredPackageExecutor(`${root}/runtime/sockets/program.sock`,config.programExecutorUid);
const list=await packages.list();
assert.ok(Array.isArray(list.available) && Array.isArray(list.installed));
// Snapshot without navigation must reject; proves real IPC without any external page request.
const browser=configuredBrowserExecutor(`${root}/runtime/sockets/browser.sock`,config.browserExecutorUid);
await assert.rejects(browser({agent_id:'local-acceptance',room_id:'local-acceptance',task_id:'local-acceptance',action:{kind:'snapshot'}}),/unavailable|expired/);
console.log(`PASS: enabled package catalog (${list.available.length} available) and browser IPC; missing session rejected`);
