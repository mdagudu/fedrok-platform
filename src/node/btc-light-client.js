// Bitcoin light client: follows the header chain and verifies linkage and
// proof of work. Every Fedrok full node runs one (see spec section 8).
import { EventEmitter } from 'node:events';
import { btcHeaderHash, meetsDifficulty } from '../core/btc.js';

export class BtcLightClient extends EventEmitter {
  constructor({ url, difficulty, log = console }) {
    super();
    this.url = url.replace(/\/$/, '');
    this.difficulty = difficulty;
    this.log = log;
    this.headers = [];
    this.synced = false;
  }

  get tip() {
    return this.headers[this.headers.length - 1] || null;
  }

  start(intervalMs = 1000) {
    const tick = async () => {
      try {
        await this.poll();
      } catch (e) {
        if (this.synced) this.log.warn(`btc light client: ${e.message}`);
        this.synced = false;
      }
      this.timer = setTimeout(tick, intervalMs);
    };
    tick();
  }

  stop() {
    clearTimeout(this.timer);
  }

  async poll() {
    for (;;) {
      const from = this.headers.length;
      const res = await fetch(`${this.url}/headers?from=${from}&limit=500`);
      const batch = await res.json();
      if (!batch.length) break;
      for (const h of batch) {
        const prev = this.headers[this.headers.length - 1];
        const ok = h.height === this.headers.length && (!prev || h.prevHash === prev.hash) && btcHeaderHash(h) === h.hash && meetsDifficulty(h.hash, this.difficulty);
        if (!ok) {
          this.log.warn(`btc header ${h.height} failed verification; resyncing`);
          this.headers = [];
          return;
        }
        this.headers.push(h);
        this.emit('header', h);
      }
      if (batch.length < 500) break;
    }
    this.synced = true;
  }

  /** Headers with height in (fromHeight, toHeight]. */
  range(fromHeight, toHeight) {
    return this.headers.slice(fromHeight + 1, toHeight + 1);
  }
}
