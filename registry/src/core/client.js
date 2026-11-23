// Minimal JavaScript SDK for Fedrok nodes. Works in Node 20+ and browsers.
//
// `send(privKey, type, payload)` turns a Fedrok action (see src/evm/actions.js)
// into a signed EIP-1559 transaction to the right system contract and submits
// it. Actions that pay in the settlement stablecoin first approve the paying
// contract once. Any Ethereum library can do the same through /rpc.
import { addressFromPrivate } from './crypto.js';
import { encodeAction } from '../evm/actions.js';
import { signEvmTx } from '../evm/signer.js';

const MAX = (1n << 256n) - 1n;
// Fallback gas limits when estimation is not possible (e.g. it depends on a
// pending approval). Unused gas is refunded, as on Ethereum.
const GAS = { transfer: 100_000n, stable_approve: 100_000n, garden_register: 6_000_000n, dedication_create: 3_000_000n, planting_window_close: 5_000_000n };

export class FedrokClient {
  constructor(baseUrl = '') {
    this.base = baseUrl.replace(/\/$/, '');
    this._status = null;
    this._approved = new Set();
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

  async rpc(method, params = []) {
    const r = await this.post('/rpc', { jsonrpc: '2.0', id: 1, method, params });
    if (r.error) throw new Error(r.error.message);
    return r.result;
  }

  async status() {
    this._status = await this.get('/api/status');
    return this._status;
  }

  account(addr) {
    return this.get('/api/account/' + addr);
  }

  /** Sign and submit a Fedrok action as an EVM transaction. Returns { hash }. */
  async send(privKey, type, payload, { gasLimit } = {}) {
    const st = this._status || (await this.status());
    const from = addressFromPrivate(privKey);
    const acct = await this.account(from);
    let nonce = acct.nextNonce;
    const call = encodeAction(type, payload, { from });
    const sign = (c, n, gas) => signEvmTx({ chainId: st.chainId, nonce: n, to: c.to, data: c.data, value: c.value, gasLimit: gas, minGasPrice: st.params.minGasPrice }, privKey);
    if (call.spends) {
      const spender = st.contracts[call.spends];
      const key = `${from}:${spender}`;
      if (BigInt(acct.allowances?.[spender] || 0) < 1n << 128n && !this._approved.has(key)) {
        await this.post('/api/tx', sign(encodeAction('stable_approve', { spender, amount: MAX.toString() }), nonce++, GAS.stable_approve));
        this._approved.add(key);
      }
    }
    let gas = gasLimit;
    if (!gas && !call.spends) {
      try {
        gas = BigInt(await this.rpc('eth_estimateGas', [{ from, to: call.to, data: call.data, value: '0x' + call.value.toString(16) }]));
      } catch {
        /* fall back to the fixed limit; the node reports the real error */
      }
    }
    const signed = sign(call, nonce, gas || GAS[type] || 3_000_000n);
    return this.post('/api/tx', { raw: signed.raw });
  }

  /** Wait until a transaction is confirmed (or fails). */
  async wait(hash, timeoutMs = 60_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        const t = await this.get('/api/tx/' + hash);
        if (t.status === 'confirmed') return t;
        if (t.status === 'rejected' || t.status === 'failed') throw new Error(`transaction ${t.status}: ${t.error}`);
      } catch (e) {
        if (/^transaction (rejected|failed)/.test(e.message)) throw e;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`timed out waiting for ${hash}`);
  }

  async sendAndWait(privKey, type, payload, opts) {
    const { hash } = await this.send(privKey, type, payload, opts);
    return this.wait(hash);
  }
}
