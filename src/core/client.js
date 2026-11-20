// Minimal JavaScript SDK for Fedrok nodes. Works in Node 20+ and browsers.
import { signTx } from './transaction.js';
import { addressFromPrivate } from './crypto.js';

export class FedrokClient {
  constructor(baseUrl = '') {
    this.base = baseUrl.replace(/\/$/, '');
    this._status = null;
  }

  async get(path) {
    const r = await fetch(this.base + path);
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }

  async post(path, data) {
    const r = await fetch(this.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }

  async status() {
    this._status = await this.get('/api/status');
    return this._status;
  }

  account(addr) {
    return this.get('/api/account/' + addr);
  }

  /** Sign and submit a transaction. Returns { hash }. */
  async send(privKey, type, payload, { fee } = {}) {
    const st = this._status || (await this.status());
    const from = addressFromPrivate(privKey);
    const acct = await this.account(from);
    const tx = signTx({ chainId: st.chainId, type, nonce: acct.nextNonce, fee: fee || st.params.minFee, payload }, privKey);
    return this.post('/api/tx', tx);
  }

  /** Wait until a transaction is confirmed (or rejected). */
  async wait(hash, timeoutMs = 60_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        const t = await this.get('/api/tx/' + hash);
        if (t.status === 'confirmed') return t;
        if (t.status === 'rejected') throw new Error(`transaction rejected: ${t.error}`);
      } catch (e) {
        if (e.message.startsWith('transaction rejected')) throw e;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`timed out waiting for ${hash}`);
  }

  async sendAndWait(privKey, type, payload, opts) {
    const { hash } = await this.send(privKey, type, payload, opts);
    return this.wait(hash);
  }
}
