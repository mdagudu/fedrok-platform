// The Fedrok chain: EVM execution with Proof of Authority block production.
//
// Execution layer: an ethereumjs EVM (Shanghai). Transactions are ordinary
// signed Ethereum transactions (EIP-155 legacy or EIP-1559), so ethers.js,
// MetaMask and any Ethereum tooling can sign for Fedrok. FDK is the native gas
// token; the registry lives in Solidity system contracts (contracts/).
//
// Consensus layer: Proof of Authority. The validator set is held by the
// FedrokGovernance contract. Time is divided into slots (blockTimeMs); the
// validator at index slot % count is the only one allowed to seal a block in
// that slot. Every node re-executes each block and rejects any block sealed
// by the wrong validator or whose state root does not match.
import { Emitter } from '../core/emitter.js';
import { canonical, keccakHex, signDigest, verifyDigest, addressOf, publicKeyOf, merkleRoot } from '../core/crypto.js';
import { createTxFromRLP } from '@ethereumjs/tx';
import { createGenesisVM, blockContext, runTx, bytesToHex, hexToBytes, addrOf, viewCall, CALL_GAS, BLOCK_GAS_LIMIT } from './vm.js';

/** The validator allowed to seal a block in `slot`. */
export const leaderFor = (validators, slot) => validators[slot % validators.length];
import { revertReason } from './contracts.js';
import { decodeAction } from './actions.js';
import { Indexer, peekAccount } from './indexer.js';

const MAX_MEMPOOL = 10_000;
const lc = (a) => a.toLowerCase();

/** Mutex: EVM state is shared, so every state operation runs one at a time. */
class Lock {
  constructor() {
    this.p = Promise.resolve();
  }
  run(fn) {
    const r = this.p.then(fn, fn);
    this.p = r.catch(() => {});
    return r;
  }
}

export function genesisHash(genesis) {
  return keccakHex(canonical(genesis));
}

export function blockHash(header) {
  return keccakHex(canonical(header));
}

function logJSON(l) {
  return { address: lc(bytesToHex(l[0])), topics: l[1].map((t) => bytesToHex(t)), data: bytesToHex(l[2]) };
}

export class Chain extends Emitter {
  constructor(genesis, storage, log = console) {
    super();
    this.genesis = genesis;
    this.storage = storage;
    this.log = log;
    this.genesisHash = genesisHash(genesis);
    this.lock = new Lock();
  }

  async _reset() {
    const { vm, common, stateRoot } = await createGenesisVM(this.genesis);
    this.vm = vm;
    this.common = common;
    this.genesisStateRoot = stateRoot;
    this.indexer = new Indexer(this.genesis, this.genesisHash);
    await this.indexer.init(vm, blockContext(common, { number: 0, timestampSec: Math.floor(this.genesis.timestamp / 1000) }));
    this.blocks = [];          // blocks[i] has height i + 1
    this.txIndex = new Map();  // hash -> { height, index, receipt }
    this.addrIndex = new Map(); // address -> [tx hashes]
    this.mempool = new Map();  // hash -> tx view
    this.rejected = new Map(); // hash -> error
  }

  get state() {
    return this.indexer.state;
  }
  get height() {
    return this.state.height;
  }
  get tip() {
    return this.blocks[this.blocks.length - 1] || null;
  }

  async load() {
    await this.storage.init?.();
    await this.lock.run(async () => {
      await this._reset();
      for (const block of this.storage.load()) {
        try {
          await this._commit(block, false);
        } catch (e) {
          this.log.warn(`stored block ${block.header.height} invalid (${e.message}); truncating`);
          break;
        }
      }
    });
    this.storage.rewrite(this.blocks.map(stripBlock));
    this.log.info(`loaded ${this.height} blocks from disk`);
  }

  // ------------------------------------------------------------ transactions
  /** Decode and check a raw signed Ethereum transaction. */
  _parseTx(raw) {
    if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error('raw transaction must be 0x-prefixed hex');
    if (raw.length > 262_144) throw new Error('tx too large');
    let tx;
    try {
      tx = createTxFromRLP(hexToBytes(raw), { common: this.common });
    } catch (e) {
      throw new Error(`invalid transaction: ${e.message}`);
    }
    if (!tx.isSigned()) throw new Error('transaction is not signed');
    if (tx.type === 0 && !tx.supports(155)) throw new Error('only EIP-155 replay-protected transactions are accepted');
    if (!tx.verifySignature()) throw new Error('invalid signature');
    const from = lc(tx.getSenderAddress().toString());
    const to = tx.to ? lc(tx.to.toString()) : null;
    const data = bytesToHex(tx.data);
    const view = {
      hash: bytesToHex(tx.hash()), raw, from, to, nonce: Number(tx.nonce), value: tx.value.toString(), data,
      gasLimit: tx.gasLimit.toString(), evmType: tx.type,
      maxFeePerGas: (tx.maxFeePerGas ?? tx.gasPrice).toString(), maxPriorityFeePerGas: (tx.maxPriorityFeePerGas ?? tx.gasPrice).toString(),
      ...decodeAction({ from, to, data, value: tx.value }),
    };
    view.fee = (tx.gasLimit * BigInt(view.maxFeePerGas)).toString();
    return { tx, view };
  }

  /** Validate a transaction against current state plus the sender's pending transactions. */
  async addTx(input) {
    const raw = typeof input === 'string' ? input : input?.raw;
    const { tx, view } = this._parseTx(raw);
    const hash = view.hash;
    if (this.mempool.has(hash) || this.txIndex.has(hash)) return { hash, duplicate: true };
    if (this.mempool.size >= MAX_MEMPOOL) throw new Error('mempool full');
    if (BigInt(view.maxFeePerGas) < BigInt(this.state.params.minGasPrice)) throw new Error('fee below network minimum gas price');
    await this.lock.run(async () => {
      const sm = this.vm.stateManager;
      const block = this._nextContext();
      await sm.checkpoint();
      try {
        const pending = [...this.mempool.values()].filter((t) => t.from === view.from).sort((a, b) => a.nonce - b.nonce);
        for (const p of pending) {
          try {
            await runTx(this.vm, { tx: p._tx, block, skipBlockGasLimitValidation: true });
          } catch {
            /* the producer will drop it */
          }
        }
        let r;
        try {
          r = await runTx(this.vm, { tx, block, skipBlockGasLimitValidation: true });
        } catch (e) {
          throw new Error(readableTxError(e.message));
        }
        if (r.execResult.exceptionError) throw new Error(revertReason(r.execResult.returnValue));
      } finally {
        await sm.revert();
      }
    });
    Object.defineProperty(view, '_tx', { value: tx, enumerable: false });
    this.mempool.set(hash, view);
    this.rejected.delete(hash);
    this.emit('tx', view);
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

  _nextContext(timestampMs = Date.now(), coinbase) {
    return blockContext(this.common, { number: this.height + 1, timestampSec: Math.floor(timestampMs / 1000), coinbase, baseFeePerGas: this.state.params.minGasPrice });
  }

  // ------------------------------------------------------------ blocks
  /**
   * Execute a block body on the live state. mode 'build' skips invalid
   * transactions; mode 'verify' throws on any. On error the state is unchanged.
   */
  async _execute({ timestamp, txs, validator }, mode) {
    const s = this.state;
    if (!Number.isInteger(timestamp) || timestamp % 1000 !== 0) throw new Error('timestamp must be whole seconds in ms');
    if (timestamp <= s.lastTimestamp) throw new Error('timestamp must increase');
    const slot = Math.floor(timestamp / s.params.blockTimeMs);
    if (s.height > 0 && slot <= Math.floor(s.lastTimestamp / s.params.blockTimeMs)) throw new Error('slot already used');
    if (leaderFor(s.validators, slot) !== validator) throw new Error("not this validator's slot");
    const sm = this.vm.stateManager;
    const block = this._nextContext(timestamp, validator);
    await sm.checkpoint();
    try {
      const included = [];
      const results = [];
      let gasUsed = 0n;
      let fees = 0n;
      const limit = mode === 'build' ? s.params.maxTxPerBlock : Infinity;
      if (mode === 'verify' && txs.length > s.params.maxTxPerBlock) throw new Error('too many transactions');
      const rejected = [];
      for (const t of txs) {
        if (included.length >= limit) break;
        let r;
        try {
          if (gasUsed + BigInt(t.gasLimit) > BLOCK_GAS_LIMIT) throw new Error('block gas limit reached');
          r = await runTx(this.vm, { tx: t._tx, block, skipBlockGasLimitValidation: true });
        } catch (e) {
          if (mode === 'verify') throw new Error(`tx ${t.hash}: ${readableTxError(e.message)}`);
          rejected.push({ hash: t.hash, error: readableTxError(e.message) });
          continue;
        }
        gasUsed += r.totalGasSpent;
        const tip = BigInt(t.maxPriorityFeePerGas);
        const cap = BigInt(t.maxFeePerGas);
        const base = BigInt(s.params.minGasPrice);
        const fee = r.totalGasSpent * (base + tip < cap ? base + tip : cap);
        fees += fee;
        const failed = Boolean(r.execResult.exceptionError);
        results.push({
          status: failed ? 0 : 1, gasUsed: r.totalGasSpent.toString(), fee: fee.toString(),
          logs: (r.execResult.logs || []).map(logJSON), error: failed ? revertReason(r.execResult.returnValue) : null,
          contractAddress: r.createdAddress ? lc(r.createdAddress.toString()) : null,
        });
        included.push(t);
      }
      await sm.commit();
      const stateRoot = bytesToHex(await sm.getStateRoot());
      return { block, included, results, rejected, gasUsed, fees, stateRoot };
    } catch (e) {
      await sm.revert();
      throw e;
    }
  }

  _header(exec, { timestamp, validator, pubKey }) {
    return {
      chainId: this.state.chainId,
      height: this.height + 1,
      prevHash: this.state.tipHash,
      timestamp,
      slot: Math.floor(timestamp / this.state.params.blockTimeMs),
      consensus: 'authority',
      validator,
      validatorPubKey: pubKey,
      txRoot: merkleRoot(exec.included.map((t) => t.hash)),
      txCount: exec.included.length,
      receiptsRoot: keccakHex(canonical(exec.results.map((r) => [r.status, r.gasUsed, r.logs]))),
      stateRoot: exec.stateRoot,
      gasUsed: exec.gasUsed.toString(),
      baseFeePerGas: this.state.params.minGasPrice.toString(),
      fees: exec.fees.toString(),
    };
  }

  /** Index a block that has been executed (state already advanced). */
  async _index(block, exec) {
    const events = await this.indexer.applyBlock(this.vm, exec.block, block, exec.results);
    this.blocks.push(block);
    block.txs.forEach((tx, index) => {
      const r = exec.results[index];
      const receipt = { status: r.status ? 'ok' : 'failed', error: r.error, gasUsed: r.gasUsed, fee: r.fee, logs: r.logs, contractAddress: r.contractAddress, events: events[index] };
      tx.fee = r.fee;
      this.txIndex.set(tx.hash, { height: block.header.height, index, receipt });
      this._indexAddr(tx.from, tx.hash);
      if (tx.to) this._indexAddr(tx.to, tx.hash);
      for (const ev of receipt.events) {
        for (const k of ['to', 'owner', 'validator', 'holder', 'steward']) {
          if (typeof ev[k] === 'string' && ev[k].startsWith('0x') && ev[k] !== tx.from) this._indexAddr(ev[k], tx.hash);
        }
      }
      this.mempool.delete(tx.hash);
    });
    for (const [hash, tx] of this.mempool) if (tx.nonce < peekAccount(this.state, tx.from).nonce) this.mempool.delete(hash);
  }

  _indexAddr(addr, hash) {
    if (!this.addrIndex.has(addr)) this.addrIndex.set(addr, []);
    const list = this.addrIndex.get(addr);
    if (list[list.length - 1] !== hash) list.push(hash);
  }

  _hydrate(block) {
    // Rebuild transaction objects from their raw bytes (never trust peer-supplied views).
    return { ...block, txs: block.txs.map((t) => {
      const { tx, view } = this._parseTx(t.raw);
      Object.defineProperty(view, '_tx', { value: tx, enumerable: false });
      return view;
    }) };
  }

  /** Validate and apply a block extending our tip (caller holds the lock). */
  async _commit(input, persist = true) {
    const block = this._hydrate(input);
    const h = block.header;
    if (h.chainId !== this.state.chainId) throw new Error('wrong chain');
    if (h.height !== this.height + 1) throw new Error(`expected height ${this.height + 1}`);
    if (h.prevHash !== this.state.tipHash) throw new Error('prevHash does not match tip');
    if (blockHash(h) !== block.hash) throw new Error('block hash mismatch');
    if (addressOf(h.validatorPubKey) !== h.validator) throw new Error('validator key mismatch');
    if (!verifyDigest(block.sig, block.hash, h.validatorPubKey)) throw new Error('bad block signature');
    if (merkleRoot(block.txs.map((t) => t.hash)) !== h.txRoot) throw new Error('txRoot mismatch');
    const exec = await this._execute({ timestamp: h.timestamp, txs: block.txs, validator: h.validator }, 'verify');
    const expect = this._header(exec, { timestamp: h.timestamp, validator: h.validator, pubKey: h.validatorPubKey });
    for (const k of ['slot', 'consensus', 'stateRoot', 'receiptsRoot', 'fees', 'gasUsed', 'baseFeePerGas']) {
      if (String(expect[k]) !== String(h[k])) {
        // State already advanced: rebuild from scratch to undo.
        await this._rebuild(this.blocks.slice());
        throw new Error(`${k} mismatch`);
      }
    }
    await this._index(block, exec);
    if (persist) this.storage.append(stripBlock(block));
    return block;
  }

  async _rebuild(blocks) {
    const mempool = this.mempool;
    await this._reset();
    for (const b of blocks) await this._commit(b, false);
    this.mempool = mempool;
  }

  /** Append a block that extends our tip. Throws if invalid. */
  async addBlock(input) {
    const block = await this.lock.run(() => this._commit(input, true));
    this.emit('block', block);
    return block;
  }

  /** Fork choice: adopt `candidate` if it forks from our chain and ends higher. */
  async tryReorg(candidate) {
    if (!candidate.length) return false;
    const ok = await this.lock.run(async () => {
      const first = candidate[0].header.height;
      const last = candidate[candidate.length - 1].header.height;
      if (last <= this.height) return false;
      const forkParent = first - 1;
      const parentHash = forkParent === 0 ? this.genesisHash : this.blocks[forkParent - 1]?.hash;
      if (candidate[0].header.prevHash !== parentHash) return false;
      const keep = this.blocks.slice(0, forkParent);
      const dropped = this.blocks.slice(forkParent);
      const oldMempool = this.mempool;
      try {
        await this._reset();
        for (const b of keep) await this._commit(b, false);
        for (const b of candidate) await this._commit(b, false);
      } catch (e) {
        this.log.warn(`reorg candidate invalid: ${e.message}; restoring`);
        await this._reset();
        for (const b of keep.concat(dropped)) await this._commit(b, false);
        this.mempool = oldMempool;
        return false;
      }
      this.mempool = oldMempool;
      for (const b of dropped) for (const tx of b.txs) if (!this.txIndex.has(tx.hash)) this.mempool.set(tx.hash, tx);
      this.storage.rewrite(this.blocks.map(stripBlock));
      this.log.info(`reorg: replaced ${dropped.length} blocks from height ${first}, new tip ${this.height}`);
      return true;
    });
    if (ok) {
      this.emit('reorg', { to: this.height });
      this.emit('block', this.tip);
    }
    return ok;
  }

  /** Try to produce a block for the current slot. Returns the block or null. */
  async produce({ timestamp, privKey }) {
    timestamp = Math.floor(timestamp / 1000) * 1000;
    const block = await this.lock.run(async () => {
      const pubKey = publicKeyOf(privKey);
      const validator = addressOf(pubKey);
      let exec;
      try {
        exec = await this._execute({ timestamp, txs: this.pendingForBlock(), validator }, 'build');
      } catch (e) {
        if (/not this validator's slot|slot already used|timestamp must increase/.test(e.message)) return null;
        throw e;
      }
      for (const r of exec.rejected) {
        this.rejected.set(r.hash, r.error);
        this.mempool.delete(r.hash);
      }
      const header = this._header(exec, { timestamp, validator, pubKey });
      const hash = blockHash(header);
      const b = { header, txs: exec.included, hash, sig: signDigest(hash, privKey) };
      await this._index(b, exec);
      this.storage.append(stripBlock(b));
      return b;
    });
    if (block) this.emit('block', block);
    return block;
  }

  getBlock(id) {
    if (/^\d+$/.test(String(id))) return this.blocks[Number(id) - 1] || null;
    return this.blocks.find((b) => b.hash === id) || null;
  }

  // ------------------------------------------------------------ EVM reads (JSON-RPC)
  async call({ from, to, data, value }, opts = {}) {
    return this.lock.run(async () => {
      const block = this._nextContext();
      const sm = this.vm.stateManager;
      await sm.checkpoint();
      try {
        if (opts.withPending && from) {
          // Estimate on top of the sender's pending transactions, which may
          // change what this call does (approvals, filling a batch, ...).
          const pending = [...this.mempool.values()].filter((t) => t.from === from.toLowerCase()).sort((a, b) => a.nonce - b.nonce);
          for (const p of pending) await runTx(this.vm, { tx: p._tx, block, skipBlockGasLimitValidation: true }).catch(() => {});
        }
        const r = await this.vm.evm.runCall({
          caller: addrOf(from || '0x0000000000000000000000000000000000000000'), to: to ? addrOf(to) : undefined, data: hexToBytes(data || '0x'),
          value: BigInt(value || 0), gasLimit: CALL_GAS, block, skipBalance: true,
        });
        if (r.execResult.exceptionError) {
          const e = new Error('execution reverted: ' + revertReason(r.execResult.returnValue));
          e.code = 3;
          e.data = bytesToHex(r.execResult.returnValue);
          throw e;
        }
        return opts.gas ? r.execResult.executionGasUsed : bytesToHex(r.execResult.returnValue);
      } finally {
        await sm.revert();
      }
    });
  }

  async estimateGas(tx) {
    const exec = await this.call(tx, { gas: true, withPending: true });
    const bytes = hexToBytes(tx.data || '0x');
    let intrinsic = tx.to ? 21000n : 53000n;
    for (const b of bytes) intrinsic += b === 0 ? 4n : 16n;
    return ((exec + intrinsic) * 13n) / 10n + 10000n;
  }

  async getAccount(addr) {
    return this.lock.run(async () => {
      const a = await this.vm.stateManager.getAccount(addrOf(addr));
      const code = await this.vm.stateManager.getCode(addrOf(addr));
      return { balance: a ? a.balance : 0n, nonce: a ? a.nonce : 0n, code: bytesToHex(code) };
    });
  }

  async getStorageAt(addr, slot) {
    return this.lock.run(async () => {
      const key = hexToBytes('0x' + BigInt(slot).toString(16).padStart(64, '0'));
      const v = await this.vm.stateManager.getStorage(addrOf(addr), key);
      return '0x' + bytesToHex(v).slice(2).padStart(64, '0');
    });
  }

  async view(contract, fn, args = []) {
    return this.lock.run(() => viewCall(this.vm, this._nextContext(), contract, fn, args));
  }
}

/** Blocks are stored and gossiped with raw transactions only. */
export function stripBlock(b) {
  return { header: b.header, txs: b.txs.map((t) => ({ hash: t.hash, raw: t.raw })), hash: b.hash, sig: b.sig };
}

function readableTxError(msg) {
  const m = String(msg);
  if (/nonce/i.test(m) && /invalid|too low|too high/i.test(m)) {
    const x = m.match(/tx has nonce (\d+).*?account has nonce:? (\d+)/i) || m.match(/account has nonce of: (\d+) tx has nonce of: (\d+)/i);
    return x ? `bad nonce (${x[0]})` : 'bad nonce';
  }
  if (/balance/i.test(m) || /upfront cost/i.test(m)) return 'insufficient FDK for gas and value';
  if (/gasLimit is too low/i.test(m)) return 'gas limit too low';
  return m.split('\n')[0].replace(/ \(block number=.*$/, '').slice(0, 200);
}
