import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { Runtime } from '../runtime/runtime.ts';
import { assertDirectoryPath, type ProductPaths } from '../config/paths.ts';
import type { Installation } from '../config/installation.ts';

export interface BackupManifest {
  version: 1; id: string; created_at: number; installation: Installation;
  files: { path: string; bytes: number; sha256: string }[];
}
const validId = (id: string) => /^[0-9a-f-]{36}$/.test(id);

/** Only the trusted service uses this object; no paths or credentials come from a model. */
export class Backups {
  #runtime: Runtime;
  #paths: ProductPaths;
  #installation: Installation;
  #job: Promise<BackupManifest> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopped = false;
  error: string | null = null;
  constructor(runtime: Runtime, paths: ProductPaths, installation: Installation) {
    this.#runtime = runtime; this.#paths = paths; this.#installation = installation;
  }
  async list(): Promise<BackupManifest[]> {
    assertDirectoryPath(this.#paths.backups);
    const manifests: BackupManifest[] = [];
    for (const entry of await fs.readdir(this.#paths.backups, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validId(entry.name)) continue;
      const file = join(this.#paths.backups, entry.name, 'manifest.json');
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid backup manifest');
      const value = JSON.parse(await fs.readFile(file, 'utf8')) as BackupManifest;
      if (value.version !== 1 || value.id !== entry.name || !Number.isSafeInteger(value.created_at)) throw new Error('Invalid backup manifest');
      manifests.push(value);
    }
    return manifests.sort((a, b) => b.created_at - a.created_at);
  }
  create(): Promise<BackupManifest> {
    if (this.#job) return this.#job;
    this.#job = this.#create().finally(() => { this.#job = undefined; });
    return this.#job;
  }
  async #create(): Promise<BackupManifest> {
    const admin = this.#runtime.administrator();
    const id = randomUUID(); const created_at = Date.now();
    const parent = join(this.#paths.runtime, 'backup-staging');
    assertDirectoryPath(parent); await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const stage = join(parent, id);
    try {
      // No await inside snapshot: control and private DBs represent one application boundary.
      const names = this.#runtime.snapshot(admin, stage);
      const manifest: BackupManifest = { version: 1, id, created_at, installation: this.#installation, files: [] };
      for (const name of names) {
        const raw = join(stage, name); const compressed = `${raw}.gz`;
        await pipeline(createReadStream(raw), createGzip(), createWriteStream(compressed, { flags: 'wx', mode: 0o600 }));
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(compressed)) hash.update(chunk as Buffer);
        manifest.files.push({ path: `${name}.gz`, bytes: (await fs.stat(compressed)).size, sha256: hash.digest('hex') });
        await fs.unlink(raw);
      }
      await fs.writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
      assertDirectoryPath(this.#paths.backups);
      await fs.rename(stage, join(this.#paths.backups, id));
      const cutoff = created_at - this.#runtime.settings(admin).backupDays * 86_400_000;
      for (const old of await this.list()) if (old.id !== id && old.created_at < cutoff) {
        const target = resolve(this.#paths.backups, old.id);
        if (!validId(old.id) || target !== join(this.#paths.backups, old.id)) throw new Error('Invalid backup path');
        assertDirectoryPath(target); await fs.rm(target, { recursive: true });
      }
      this.error = null;
      return manifest;
    } catch (error) {
      this.error = 'バックアップを保存できませんでした。保存先と空き容量を確認してください。';
      throw error;
    } finally {
      assertDirectoryPath(stage); await fs.rm(stage, { recursive: true, force: true });
    }
  }
  start(): void {
    if (this.#timer) return;
    this.#stopped = false;
    const tick = async () => {
      try { const last = (await this.list())[0]?.created_at ?? 0; if (!this.#stopped && Date.now() - last >= 86_400_000) await this.create(); }
      catch { this.error = 'バックアップを保存できませんでした。保存先と空き容量を確認してください。'; }
    };
    this.#timer = setInterval(() => { void tick(); }, 60_000);
    void tick();
  }
  async stop(): Promise<void> { this.#stopped = true; clearInterval(this.#timer); this.#timer = undefined; await this.#job?.catch(() => {}); }
}
