// Blockchain storage, indexing, mempool and fork choice for one node.
import { Emitter } from '../core/emitter.js';
import { createGenesisState, cloneState, applyTx, peekAccount } from '../core/state.js';
import { applyBlock, buildBlock, genesisHash } from '../core/consensus.js';
import { verifyTxEnvelope } from '../core/transaction.js';

const MAX_MEMPOOL = 10_000;

export class Chain extends Emitter {
  constructor(genesis, storage, log = console) {
    super();
    this.genesis = genesis;
    this.storage = storage;
    this.log = log;
    this.genesisHash = genesisHash(genesis);
    this.reset();
  }

  reset() {
    this.state = createGenesisState(this.genesis);
    this.blocks = [];          // blocks[i] has height i + 1
    this.txIndex = new Map();  // hash -> { height, index, receipt }
    this.addrIndex = new Map(); // address -> [tx hashes]
    this.mempool = new Map();  // hash -> tx
    this.rejected = new Map(); // hash -> error
  }

  get height() {
    return this.state.height;
  }
  get tip() {
    return this.blocks[this.blocks.length - 1] || null;
  }

  async load() {
    await this.storage.init?.();
    for (const block of this.storage.load()) {
      try {
        this._commit(block, false);
      } catch (e) {
        this.log.warn(`stored block ${block.header.height} invalid (${e.message}); truncating`);
        break;
      }
    }
    this._rewriteFile();
    this.log.info(`loaded ${this.height} blocks from disk`);
  }

  _rewriteFile() {
    this.storage.rewrite(this.blocks);
  }

  _commit(block, persist = true) {
    const next = cloneState(this.state);
    const r = applyBlock(next, block);
    this.state = next;
    this.blocks.push(block);
    r.receipts.forEach((receipt, index) => {
      const tx = block.txs[index];
      this.txIndex.set(tx.hash, { height: block.header.height, index, receipt });
      this._indexAddr(tx.from, tx.hash);
      for (const ev of receipt.events) {
        for (const k of ['to', 'buyer', 'seller', 'owner', 'auditor', 'generator']) {
          if (typeof ev[k] === 'string' && ev[k].startsWith('0x') && ev[k] !== tx.from) this._indexAddr(ev[k], tx.hash);
        }
      }
      this.mempool.delete(tx.hash);
    });
    if (persist) this.storage.append(block);
    this._pruneMempool();
    return r;
  }

  _indexAddr(addr, hash) {
    if (!this.addrIndex.has(addr)) this.addrIndex.set(addr, []);
    const list = this.addrIndex.get(addr);
    if (list[list.length - 1] !== hash) list.push(hash);
  }

  _pruneMempool() {
    for (const [hash, tx] of this.mempool) {
      if (tx.nonce < peekAccount(this.state, tx.from).nonce) this.mempool.delete(hash);
    }
  }

  /** Append a block that extends our tip. Throws if invalid. */
  addBlock(block) {
    const r = this._commit(block, true);
    this.emit('block', block, r);
    return r;
  }

  /**
   * Fork choice: adopt `candidate` (consecutive blocks from a peer) if it
   * forks from our chain and ends higher than our tip.
   */
  tryReorg(candidate) {
    if (!candidate.length) return false;
    const first = candidate[0].header.height;
    const last = candidate[candidate.length - 1].header.height;
    if (last <= this.height) return false;
    const forkParent = first - 1;
    const parentHash = forkParent === 0 ? this.genesisHash : this.blocks[forkParent - 1]?.hash;
    if (candidate[0].header.prevHash !== parentHash) return false; // need older blocks
    const keep = this.blocks.slice(0, forkParent);
    const dropped = this.blocks.slice(forkParent);
    const oldMempool = this.mempool;
    this.reset();
    try {
      for (const b of keep) this._commit(b, false);
      for (const b of candidate) this._commit(b, false);
    } catch (e) {
      this.log.warn(`reorg candidate invalid: ${e.message}; restoring`);
      this.reset();
      for (const b of keep.concat(dropped)) this._commit(b, false);
      this.mempool = oldMempool;
      return false;
    }
    this.mempool = oldMempool;
    for (const b of dropped) for (const tx of b.txs) if (!this.txIndex.has(tx.hash)) this.mempool.set(tx.hash, tx);
    this._pruneMempool();
    this._rewriteFile();
    this.log.info(`reorg: replaced ${dropped.length} blocks from height ${first}, new tip ${this.height}`);
    this.emit('reorg', { from: first, to: this.height });
    this.emit('block', this.tip, null);
    return true;
  }

  /** Validate a transaction against current state plus the sender's pending txs. */
  addTx(tx) {
    const hash = verifyTxEnvelope(tx, this.state.chainId);
    tx.hash = hash;
    if (this.mempool.has(hash) || this.txIndex.has(hash)) return { hash, duplicate: true };
    if (this.mempool.size >= MAX_MEMPOOL) throw new Error('mempool full');
    const sim = cloneState(this.state);
    const ctx = { height: sim.height + 1, timestamp: Date.now(), collectFee: () => {} };
    const pending = [...this.mempool.values()].filter((t) => t.from === tx.from).sort((a, b) => a.nonce - b.nonce);
    for (const p of pending) {
      try {
        applyTx(sim, p, ctx);
      } catch {
        /* earlier pending tx will be rejected by the producer */
      }
    }
    applyTx(sim, tx, ctx); // throws with a readable reason
    this.mempool.set(hash, tx);
    this.rejected.delete(hash);
    this.emit('tx', tx);
    return { hash };
  }

  nextNonce(addr) {
    let n = peekAccount(this.state, addr).nonce;
    const pending = new Set([...this.mempool.values()].filter((t) => t.from === addr).map((t) => t.nonce));
    while (pending.has(n)) n++;
    return n;
  }

  pendingForBlock() {
    const bySender = new Map();
    for (const tx of this.mempool.values()) {
      if (!bySender.has(tx.from)) bySender.set(tx.from, []);
      bySender.get(tx.from).push(tx);
    }
    for (const list of bySender.values()) list.sort((a, b) => a.nonce - b.nonce);
    const out = [];
    let added = true;
    while (added) {
      added = false;
      for (const list of bySender.values()) {
        if (list.length) {
          out.push(list.shift());
          added = true;
        }
      }
    }
    return out.slice(0, this.state.params.maxTxPerBlock);
  }

  /** Try to produce a block for the current slot. Returns the block or null. */
  produce({ timestamp, btcHeaders, privKey }) {
    const work = cloneState(this.state);
    let built;
    try {
      built = buildBlock(work, { timestamp, btcHeaders, txs: this.pendingForBlock(), privKey });
    } catch (e) {
      if (/not this generator's slot|slot already used|timestamp must increase/.test(e.message)) return null;
      throw e;
    }
    for (const r of built.rejected) {
      this.rejected.set(r.hash, r.error);
      this.mempool.delete(r.hash);
    }
    this.addBlock(built.block);
    return built.block;
  }

  getBlock(id) {
    if (/^\d+$/.test(String(id))) return this.blocks[Number(id) - 1] || null;
    return this.blocks.find((b) => b.hash === id) || null;
  }
}
