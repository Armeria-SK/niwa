import type { CredentialStore, OAuthCredential } from './credential-store.ts';
import { validateCredential } from './credential-store.ts';

/** One coordinator per configured account, shared by catalog and model requests. */
export class OAuthAccount implements CredentialStore {
  #store: CredentialStore;
  #exchange: (credential: OAuthCredential) => Promise<OAuthCredential>;
  #pending: Promise<OAuthCredential> | undefined;
  #epoch = 0;
  #issued = new WeakMap<OAuthCredential, number>();
  constructor(store: CredentialStore, exchange: (credential: OAuthCredential) => Promise<OAuthCredential>) {
    this.#store = store;
    this.#exchange = exchange;
  }
  read(): Promise<OAuthCredential | undefined> { return this.#store.read(); }
  async login(credential: OAuthCredential): Promise<void> {
    validateCredential(credential);
    this.#epoch++;
    this.#pending = undefined;
    await this.#store.write(credential);
  }
  async clear(): Promise<void> {
    this.#epoch++;
    this.#pending = undefined;
    await this.#store.clear();
  }
  async write(credential: OAuthCredential): Promise<void> {
    if (this.#issued.get(credential) !== this.#epoch) throw new Error('Credential update belongs to an expired login.');
    await this.#store.write(credential);
  }
  refresh = async (refreshToken: string, previous?: OAuthCredential): Promise<OAuthCredential> => {
    const epoch = this.#epoch;
    const current = await this.#store.read();
    if (!current || epoch !== this.#epoch) throw new Error('Login is no longer available.');
    if (current.refresh_token !== refreshToken || (previous && current.access_token !== previous.access_token)) {
      this.#issued.set(current, epoch);
      return current; // Another request already rotated this refresh token.
    }
    if (this.#pending) return this.#pending;
    const pending = this.#exchange(current).then(async credential => {
      validateCredential(credential);
      if (epoch !== this.#epoch) throw new Error('Login changed during refresh.');
      this.#issued.set(credential, epoch);
      await this.#store.write(credential);
      return credential;
    });
    this.#pending = pending;
    try { return await pending; }
    finally { if (this.#pending === pending) this.#pending = undefined; }
  };
}
