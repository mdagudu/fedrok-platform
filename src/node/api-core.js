// Transport-independent API: views, REST routes and JSON-RPC.
// Used by the Node HTTP server and by the in-browser node.
import { schedule, slotOf, leaderFor } from '../core/consensus.js';
import { peekAccount, yearlyEmission } from '../core/state.js';
import { isAddress } from '../core/crypto.js';
import { gardenView, gardenStats, maintenanceStatus, isSteward, PACKAGES } from '../core/garden.js';

const R = (code, body) => ({ code, body });
export const toJSON = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x));

export class ApiCore {
  constructor({ node }) {
    this.node = node;
    this.chain = node.chain;
    this.faucetLog = new Map();
  }

  // ---------------------------------------------------------------- views
  _btcSummary(h) {
    const minerId = this.chain.state.btcToMiner[h.minerAddress];
    const m = minerId && this.chain.state.miners[minerId];
    return { height: h.height, hash: h.hash, time: h.time, minerAddress: h.minerAddress, green: Boolean(m && m.active), minerId: minerId || null, minerName: m ? m.name : null };
  }

  _blockSummary(b) {
    const h = b.header;
    return { height: h.height, hash: b.hash, timestamp: h.timestamp, generator: h.generator, mode: h.mode, activeMiner: h.activeMiner, txCount: h.txCount, reward: h.reward, fees: h.fees, btcAnchor: h.btcAnchor, btcHeaders: b.btcHeaders.length };
  }

  status() {
    const s = this.chain.state;
    const sched = schedule(s);
    const nowSlot = slotOf(Date.now(), s);
    return {
      node: this.node.name,
      chainId: s.chainId,
      genesisHash: this.chain.genesisHash,
      height: s.height,
      tipHash: s.tipHash,
      lastBlockTime: s.lastTimestamp,
      params: s.params,
      stable: s.stable,
      admin: s.admin,
      stableIssuer: s.stableIssuer,
      fallbackValidator: s.fallbackValidator,
      supply: s.supply,
      fdkCirculating: s.supply.fdkMinted - s.supply.fdkBurned - s.piggyBank,
      piggyBank: s.piggyBank,
      yearlyEmission: yearlyEmission(s),
      counters: s.counters,
      pog: s.pog,
      schedule: { ...sched, currentLeader: leaderFor(sched, nowSlot), nextLeader: leaderFor(sched, nowSlot + 1) },
      activeMiners: Object.values(s.miners).filter((m) => m.active).length,
      auditors: Object.values(s.auditors).filter((a) => a.active).length,
      generators: Object.keys(s.generators).length,
      btc: { tip: this.node.btc.tip ? this._btcSummary(this.node.btc.tip) : null, synced: this.node.btc.synced },
      mempool: this.chain.mempool.size,
      peers: this.node.p2p.peers(),
      validator: this.node.validatorAddress,
      faucet: Boolean(this.node.faucetKey),
    };
  }

  accountView(addr) {
    const s = this.chain.state;
    const a = peekAccount(s, addr);
    const credits = Object.entries(a.credits).map(([batchId, kg]) => ({ batchId, kg, batch: s.batches[batchId] }));
    const history = (this.chain.addrIndex.get(addr) || []).slice(-100).reverse().map((h) => this.txView(h));
    const roles = [];
    if (addr === s.admin) roles.push('governance');
    if (s.auditors[addr]?.active) roles.push('auditor');
    if (addr === s.stableIssuer) roles.push('stablecoin-issuer');
    if (addr === s.fallbackValidator) roles.push('fallback-validator');
    if (s.generators[addr]) roles.push('block-generator');
    const miners = Object.values(s.miners).filter((m) => m.owner === addr).map((m) => m.id);
    if (miners.length) roles.push('green-miner');
    const G = gardenView(s);
    for (const g of Object.values(G.gardens)) {
      if (g.operator === addr) roles.push('garden-operator');
      else if (g.stewards[addr]?.active) roles.push('garden-steward');
    }
    const dedications = Object.values(G.dedications).filter((d) => d.holder === addr).map((d) => this.dedicationView(d.id));
    if (dedications.length) roles.push('garden-member');
    const pending = [...this.chain.mempool.values()].filter((t) => t.from === addr).map((t) => ({ hash: t.hash, type: t.type, nonce: t.nonce }));
    return { address: addr, fdk: a.fdk, stable: a.stable, nonce: a.nonce, nextNonce: this.chain.nextNonce(addr), credits, roles, miners, generator: s.generators[addr] || null, listings: Object.values(s.listings).filter((l) => l.seller === addr), dedications, history, pending };
  }

  // ------------------------------------------------- Legacy Garden views
  _treeSummary(t) {
    const G = gardenView(this.chain.state);
    const d = G.dedications[t.dedicationId];
    const cur = t.plantings[t.plantings.length - 1];
    const last = t.monitoring[t.monitoring.length - 1];
    return { id: t.id, compartment: t.compartment, number: t.number, species: t.species, scientific: t.scientific, status: t.status, gps: cur.gps, plantedOn: cur.plantedOn, plantings: t.plantings.length, heightCm: last ? last.heightCm : null, health: last ? last.health : 'healthy', dedicationId: t.dedicationId, publicName: d.publicName, dedicatedTo: d.dedicatedTo, descriptor: d.descriptor, package: d.package };
  }

  gardenSummary(g) {
    const s = this.chain.state;
    const G = gardenView(s);
    const batches = Object.values(G.batches).filter((b) => b.gardenId === g.id);
    return { ...g, stewards: Object.entries(g.stewards).map(([address, x]) => ({ address, ...x })), stats: gardenStats(s, g.id), open: G.batches[g.openBatch], batches: batches.reverse() };
  }

  gardenView(id) {
    const G = gardenView(this.chain.state);
    const g = G.gardens[id];
    if (!g) return null;
    const trees = Object.values(G.trees).filter((t) => t.gardenId === id).map((t) => this._treeSummary(t));
    const activity = [];
    for (const t of Object.values(G.trees)) {
      if (t.gardenId !== id) continue;
      for (const p of t.plantings) activity.push({ date: p.plantedOn, kind: p.n === 1 ? 'planted' : 'replaced', treeId: t.id, tx: p.tx });
      for (const m of t.monitoring) activity.push({ date: m.date, kind: m.health === 'dead' ? 'died' : 'inspected', treeId: t.id, tx: m.tx, note: m.health === 'dead' ? m.cause : `${m.heightCm} cm, ${m.health}` });
    }
    activity.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return { ...this.gardenSummary(g), trees, activity: activity.slice(0, 15) };
  }

  treeView(id) {
    const s = this.chain.state;
    const G = gardenView(s);
    const t = G.trees[id];
    if (!t) return null;
    const d = G.dedications[t.dedicationId];
    const g = G.gardens[t.gardenId];
    return { ...t, garden: { id: g.id, name: g.name, location: g.location, country: g.country, lifespanYears: g.lifespanYears, replacementMonths: g.replacementMonths }, dedication: this._publicDedication(d) };
  }

  _publicDedication(d) {
    return { id: d.id, package: d.package, packageName: PACKAGES[d.package], purpose: d.purpose, publicName: d.publicName, dedicatedTo: d.dedicatedTo, descriptor: d.descriptor, inscription: d.inscription, subscribedAt: d.subscribedAt };
  }

  dedicationView(id) {
    const s = this.chain.state;
    const G = gardenView(s);
    const d = G.dedications[id];
    if (!d) return null;
    const g = G.gardens[d.gardenId];
    const b = G.batches[d.batchId];
    return { ...d, packageName: PACKAGES[d.package], maintenance: maintenanceStatus(d), garden: { id: g.id, name: g.name, location: g.location, country: g.country, lifespanYears: g.lifespanYears, replacementMonths: g.replacementMonths, maintenanceGBP: g.maintenanceGBP }, batch: { id: b.id, window: b.window, status: b.status, paid: b.dedications.length, size: b.size }, tree: d.treeId ? this._treeSummary(G.trees[d.treeId]) : null };
  }

  txView(hash) {
    const idx = this.chain.txIndex.get(hash);
    if (idx) {
      const b = this.chain.blocks[idx.height - 1];
      return { status: 'confirmed', height: idx.height, blockHash: b.hash, timestamp: b.header.timestamp, confirmations: this.chain.height - idx.height + 1, tx: b.txs[idx.index], events: idx.receipt.events };
    }
    if (this.chain.mempool.has(hash)) return { status: 'pending', tx: this.chain.mempool.get(hash) };
    if (this.chain.rejected.has(hash)) return { status: 'rejected', hash, error: this.chain.rejected.get(hash) };
    return null;
  }

  // --------------------------------------------------------------- routes
  async handle(method, rawUrl, body) {
    const url = new URL(rawUrl, 'http://x');
    const p = url.pathname;
    const s = this.chain.state;
        if (p === '/rpc' && method === 'POST') return R(200, await this.rpc(body));
    if (p.startsWith('/api/')) {
      const parts = p.split('/').slice(2);
      const [r, id] = parts;
      if (method === 'POST' && r === 'tx') {
        const tx = body;
        try {
          return R(200, this.chain.addTx(tx));
        } catch (e) {
          return R(400, { error: e.message });
        }
      }
      if (method === 'POST' && r === 'faucet') return this._faucet(body);
      if (method !== 'GET') return R(405, { error: 'method not allowed' });
      switch (r) {
        case 'status':
          return R(200, this.status());
        case 'blocks': {
          const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
          const before = Number(url.searchParams.get('before') || s.height + 1);
          const out = [];
          for (let h = before - 1; h >= 1 && out.length < limit; h--) out.push(this._blockSummary(this.chain.blocks[h - 1]));
          return R(200, out);
        }
        case 'block': {
          const b = this.chain.getBlock(id);
          return b ? R(200, b) : R(404, { error: 'block not found' });
        }
        case 'tx': {
          const t = this.txView(id);
          return t ? R(200, t) : R(404, { error: 'transaction not found' });
        }
        case 'txs': {
          const out = [];
          for (let h = s.height; h >= 1 && out.length < 25; h--) {
            const b = this.chain.blocks[h - 1];
            for (const t of [...b.txs].reverse()) if (out.length < 25) out.push({ hash: t.hash, type: t.type, from: t.from, height: h, timestamp: b.header.timestamp });
          }
          return R(200, out);
        }
        case 'account':
          if (!isAddress(id)) return R(400, { error: 'invalid address' });
          return R(200, this.accountView(id));
        case 'batches':
          return R(200, Object.values(s.batches).reverse());
        case 'batch': {
          const b = s.batches[id];
          if (!b) return R(404, { error: 'batch not found' });
          const holders = Object.entries(s.accounts).filter(([, a]) => a.credits[id]).map(([address, a]) => ({ address, kg: a.credits[id] }));
          return R(200, { ...b, holders, retirements: Object.values(s.retirements).filter((r) => r.batchId === id), listings: Object.values(s.listings).filter((l) => l.batchId === id && l.status === 'open') });
        }
        case 'listings':
          return R(200, Object.values(s.listings).filter((l) => url.searchParams.get('all') || l.status === 'open').reverse().map((l) => ({ ...l, batch: s.batches[l.batchId] })));
        case 'retirements':
          return R(200, Object.values(s.retirements).reverse().map((r) => ({ ...r, batch: s.batches[r.batchId] })));
        case 'retirement': {
          const r = s.retirements[id];
          return r ? R(200, { ...r, batch: s.batches[r.batchId] }) : R(404, { error: 'retirement not found' });
        }
        case 'gardens':
          return R(200, Object.values(gardenView(s).gardens).map((g) => this.gardenSummary(g)));
        case 'garden': {
          const g = this.gardenView(id);
          return g ? R(200, g) : R(404, { error: 'garden not found' });
        }
        case 'tree': {
          const t = this.treeView(id);
          return t ? R(200, t) : R(404, { error: 'tree not found' });
        }
        case 'dedication': {
          const d = this.dedicationView(id);
          return d ? R(200, d) : R(404, { error: 'dedication not found' });
        }
        case 'dedications': {
          const G = gardenView(s);
          const holder = (url.searchParams.get('holder') || '').toLowerCase();
          const garden = url.searchParams.get('garden');
          return R(200, Object.values(G.dedications).filter((d) => (!holder || d.holder === holder) && (!garden || d.gardenId === garden)).reverse().map((d) => this.dedicationView(d.id)));
        }
        case 'garden-batch': {
          const b = gardenView(s).batches[id];
          return b ? R(200, { ...b, dedications: b.dedications.map((x) => this.dedicationView(x)) }) : R(404, { error: 'batch not found' });
        }
        case 'miners':
          return R(200, Object.values(s.miners));
        case 'generators':
          return R(200, Object.values(s.generators));
        case 'auditors':
          return R(200, Object.entries(s.auditors).map(([address, a]) => ({ address, ...a })));
        case 'btc': {
          const limit = Math.min(Number(url.searchParams.get('limit') || 20), 200);
          return R(200, this.node.btc.headers.slice(-limit).reverse().map((h) => this._btcSummary(h)));
        }
        case 'btc-sim-miners': {
          // Devnet helper for the auditor console (proxied from the simulator).
          try {
            return R(200, await this.node.btcSimMiners());
          } catch {
            return R(503, { error: 'Bitcoin simulator unavailable' });
          }
        }
        case 'search': {
          const q = (url.searchParams.get('q') || '').trim();
          if (/^\d+$/.test(q) && this.chain.getBlock(q)) return R(200, { kind: 'block', id: q });
          if (isAddress(q.toLowerCase())) return R(200, { kind: 'address', id: q.toLowerCase() });
          if (/^0x[0-9a-f]{64}$/i.test(q)) {
            if (this.txView(q.toLowerCase())) return R(200, { kind: 'tx', id: q.toLowerCase() });
            if (this.chain.getBlock(q.toLowerCase())) return R(200, { kind: 'block', id: q.toLowerCase() });
          }
          const up = q.toUpperCase();
          if (s.batches[up]) return R(200, { kind: 'batch', id: up });
          if (s.retirements[up]) return R(200, { kind: 'retirement', id: up });
          if (s.miners[up]) return R(200, { kind: 'miner', id: up });
          const G = gardenView(s);
          if (G.trees[up]) return R(200, { kind: 'tree', id: up });
          if (G.dedications[up]) return R(200, { kind: 'dedication', id: up });
          if (G.gardens[up]) return R(200, { kind: 'garden', id: up });
          return R(404, { error: 'nothing found' });
        }
      }
      return R(404, { error: 'unknown endpoint' });
    }
    return null;
  }

  async _faucet(body) {
    if (!this.node.faucetKey) return R(403, { error: 'faucet disabled on this node' });
    const addr = String(body.address || '').toLowerCase();
    if (!isAddress(addr)) return R(400, { error: 'invalid address' });
    const last = this.faucetLog.get(addr) || 0;
    if (Date.now() - last < 60_000) return R(429, { error: 'faucet used recently, try again in a minute' });
    this.faucetLog.set(addr, Date.now());
    try {
      const hashes = await this.node.faucetSend(addr);
      return R(200, { hashes });
    } catch (e) {
      return R(400, { error: e.message });
    }
  }

  async rpc(body) {
    if (!body || typeof body !== 'object') return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } };
    const one = async (call) => {
      const { id, method, params = [] } = call;
      try {
        const result = await this._rpcCall(method, params);
        return { jsonrpc: '2.0', id, result };
      } catch (e) {
        return { jsonrpc: '2.0', id, error: { code: e.code || -32000, message: e.message } };
      }
    };
    return Array.isArray(body) ? Promise.all(body.map(one)) : one(body);
  }

  async _rpcCall(method, params) {
    const s = this.chain.state;
    const methods = {
      fdk_chainId: () => s.chainId,
      fdk_blockNumber: () => s.height,
      fdk_getBlockByNumber: ([n]) => this.chain.getBlock(n === 'latest' ? s.height : n),
      fdk_getBlockByHash: ([h]) => this.chain.getBlock(h),
      fdk_getTransaction: ([h]) => this.txView(h),
      fdk_sendRawTransaction: ([tx]) => this.chain.addTx(tx),
      fdk_getAccount: ([a]) => this.accountView(a),
      fdk_getBalance: ([a]) => { const x = peekAccount(s, a); return { FDK: x.fdk, STABLE: x.stable }; },
      fdk_getNonce: ([a]) => this.chain.nextNonce(a),
      fdk_status: () => this.status(),
      pog_getSchedule: () => this.status().schedule,
      pog_getMiners: () => Object.values(s.miners),
      pog_getGenerators: () => Object.values(s.generators),
      carbon_getBatches: () => Object.values(s.batches),
      carbon_getBatch: ([id]) => s.batches[id] || null,
      carbon_getListings: () => Object.values(s.listings).filter((l) => l.status === 'open'),
      carbon_getRetirement: ([id]) => s.retirements[id] || null,
      garden_getGarden: ([id]) => this.gardenView(id),
      garden_getTree: ([id]) => this.treeView(id),
      garden_getDedication: ([id]) => this.dedicationView(id),
    };
    if (!methods[method]) {
      const e = new Error(`method ${method} not found`);
      e.code = -32601;
      throw e;
    }
    return methods[method](params);
  }

}
