import type { DatabaseSync } from 'node:sqlite';
import type { Actor } from './runtime.ts';
import { check } from '../domain/types.ts';
import { transaction } from '../storage/database.ts';

/** Account hashes only; a reset timestamp permits a probe, not an assumption of recovery. */
export class ProviderLimits {
  constructor(private db: DatabaseSync, private admin: (actor: Actor) => unknown) {}
  private key(actor: Actor, key: string): void { this.admin(actor); check(/^[a-f0-9]{64}$/.test(key), 'invalid', 'Invalid account key'); }
  blocked(actor: Actor, key: string, now = Date.now()): boolean {
    this.key(actor, key);
    return Number(this.db.prepare('SELECT next_probe_at FROM provider_limits WHERE account_key=?').get(key)?.next_probe_at ?? 0) > now;
  }
  begin(actor: Actor, key: string, now = Date.now()): number | undefined {
    this.key(actor, key);
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM provider_limits WHERE account_key=?').get(key);
      if (!row) return 0;
      if (Number(row.next_probe_at) > now) return undefined;
      this.db.prepare('UPDATE provider_limits SET next_probe_at=? WHERE account_key=?').run(now + 60_000, key);
      return Number(row.revision);
    });
  }
  exceeded(actor: Actor, key: string, resetAt?: number): void {
    this.key(actor, key);
    check(resetAt === undefined || (Number.isSafeInteger(resetAt) && resetAt >= 0 && resetAt <= 8_640_000_000_000), 'invalid', 'Invalid reset time');
    const retry = Math.max(Date.now() + 60_000, resetAt === undefined ? Date.now() + 15 * 60_000 : resetAt * 1000);
    this.db.prepare(`INSERT INTO provider_limits VALUES (?,?,1) ON CONFLICT(account_key) DO UPDATE SET
      next_probe_at=max(next_probe_at,excluded.next_probe_at),revision=revision+1`).run(key, retry);
  }
  recovered(actor: Actor, key: string, revision: number): void {
    this.key(actor, key);
    this.db.prepare('DELETE FROM provider_limits WHERE account_key=? AND revision=?').run(key, revision);
  }
}
