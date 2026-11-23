// Transport-independent API: views, REST routes and JSON-RPC.
// Used by the Node HTTP server and by the in-browser node.
import { isAddress } from '../core/crypto.js';
import { peekAccount } from '../evm/indexer.js';
import { gardenView, gardenStats, maintenanceStatus, PACKAGES } from '../evm/garden-views.js';
import { EthRpc } from './eth-rpc.js';
import { ARTIFACTS } from '../evm/contracts.js';
import { leaderFor } from '../evm/chain.js';
import { projectContentHash } from '../evm/actions.js';

export const slotOf = (timestamp, s) => Math.floor(timestamp / s.params.blockTimeMs);

const R = (code, body) => ({ code, body });
export const toJSON = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x));

export class ApiCore {
  constructor({ node }) {
    this.node = node;
    this.chain = node.chain;
    this.faucetLog = new Map();
    this.eth = new EthRpc(node.chain);
  }

  // ---------------------------------------------------------------- views
  _blockSummary(b) {
    const h = b.header;
    return { height: h.height, hash: b.hash, timestamp: h.timestamp, validator: h.validator, validatorName: this.chain.state.validatorInfo[h.validator]?.name || null, txCount: h.txCount, fees: h.fees, gasUsed: h.gasUsed };
  }

  status() {
    const s = this.chain.state;
    const nowSlot = slotOf(Date.now(), s);
    const projects = Object.values(s.projects);
    return {
      node: this.node.name,
      chainId: s.chainId,
      network: s.network,
      execution: { vm: 'EVM', hardfork: 'shanghai', gasToken: 'FDK', baseFeePerGas: s.params.minGasPrice, rpc: '/rpc' },
      consensus: {
        type: 'Proof of Authority',
        validators: s.validators.map((a) => ({ address: a, ...s.validatorInfo[a] })),
        currentLeader: leaderFor(s.validators, nowSlot),
        nextLeader: leaderFor(s.validators, nowSlot + 1),
      },
      contracts: s.contracts,
      genesisHash: this.chain.genesisHash,
      height: s.height,
      tipHash: s.tipHash,
      lastBlockTime: s.lastTimestamp,
      params: s.params,
      stable: s.stable,
      admin: s.admin,
      stableIssuer: s.stableIssuer,
      supply: s.supply,
      fdkCirculating: s.supply.fdkMinted - s.supply.fdkBurned,
      fdkCap: s.fdkCap,
      counters: s.counters,
      projectTypes: s.projectTypes,
      projectStats: {
        total: projects.length,
        draft: projects.filter((p) => p.status === 'draft').length,
        locked: projects.filter((p) => p.status === 'locked').length,
        retired: projects.filter((p) => p.status === 'retired').length,
        registered: projects.filter((p) => p.kind === 'registered').length,
        proposed: projects.filter((p) => p.kind === 'proposed').length,
        types: new Set(projects.map((p) => p.projectType)).size,
      },
      mempool: this.chain.mempool.size,
      peers: this.node.p2p.peers(),
      validator: this.node.validatorAddress,
      faucet: Boolean(this.node.faucetKey),
      assistant: this.node.assistant ? { proxy: '/api/assistant' } : null,
    };
  }

  accountView(addr) {
    const s = this.chain.state;
    const a = peekAccount(s, addr);
    const history = (this.chain.addrIndex.get(addr) || []).slice(-100).reverse().map((h) => this.txView(h));
    const roles = [];
    if (addr === s.admin) roles.push('governance');
    if (addr === s.stableIssuer) roles.push('stablecoin-issuer');
    if (s.validators.includes(addr)) roles.push('validator');
    const projects = Object.values(s.projects).filter((p) => p.owner === addr).reverse().map((p) => this._projectSummary(p));
    if (projects.length) roles.push('project-owner');
    const G = gardenView(s);
    for (const g of Object.values(G.gardens)) {
      if (g.operator === addr) roles.push('garden-operator');
      else if (g.stewards[addr]?.active) roles.push('garden-steward');
    }
    const dedications = Object.values(G.dedications).filter((d) => d.holder === addr).map((d) => this.dedicationView(d.id));
    if (dedications.length) roles.push('garden-member');
    const pending = [...this.chain.mempool.values()].filter((t) => t.from === addr).map((t) => ({ hash: t.hash, type: t.type, nonce: t.nonce }));
    return { address: addr, fdk: a.fdk, stable: a.stable, nonce: a.nonce, nextNonce: this.chain.nextNonce(addr), allowances: a.allowances || {}, roles, projects, dedications, history, pending };
  }

  // ------------------------------------------------- project registry views
  _projectSummary(p) {
    const { history, details, ...rest } = p;
    return { ...rest, detailCount: Object.keys(details).length };
  }

  projectView(id) {
    const p = this.chain.state.projects[String(id).toUpperCase()];
    if (!p) return null;
    const pending = [...this.chain.mempool.values()].filter((t) => t.type && t.type.startsWith('project_') && t.payload?.projectId === p.id).map((t) => ({ hash: t.hash, type: t.type }));
    return { ...p, contentHash: projectContentHash(p), editable: p.status === 'draft', pending };
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
      const r = idx.receipt;
      return { status: r.status === 'ok' ? 'confirmed' : 'failed', error: r.error, height: idx.height, blockHash: b.hash, timestamp: b.header.timestamp, confirmations: this.chain.height - idx.height + 1, tx: b.txs[idx.index], events: r.events, gasUsed: r.gasUsed, fee: r.fee, logs: r.logs, contractAddress: r.contractAddress };
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
        try {
          return R(200, await this.chain.addTx(body));
        } catch (e) {
          return R(400, { error: e.message });
        }
      }
      if (method === 'POST' && r === 'faucet') return this._faucet(body);
      if (method === 'POST' && r === 'assistant') {
        if (!this.node.assistant) return R(404, { error: 'this node has no assistant proxy configured (set ANTHROPIC_API_KEY)' });
        return this.node.assistant(body);
      }
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
        case 'projects': {
          const owner = (url.searchParams.get('owner') || '').toLowerCase();
          const type = url.searchParams.get('type');
          const status = url.searchParams.get('status');
          const kind = url.searchParams.get('kind');
          return R(200, Object.values(s.projects).filter((p) => (!owner || p.owner === owner) && (!type || p.projectType === type) && (!status || p.status === status) && (!kind || p.kind === kind)).reverse().map((p) => this._projectSummary(p)));
        }
        case 'project': {
          const p = this.projectView(id);
          return p ? R(200, p) : R(404, { error: 'project not found' });
        }
        case 'project-types':
          return R(200, s.projectTypes);
        case 'validators':
          return R(200, this.status().consensus.validators);
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
        case 'contracts':
          return R(200, Object.entries(s.contracts).map(([name, address]) => ({ name, address, ...(url.searchParams.get('abi') ? { abi: ARTIFACTS[name]?.abi } : {}) })));
        case 'search': {
          const q = (url.searchParams.get('q') || '').trim();
          if (/^\d+$/.test(q) && this.chain.getBlock(q)) return R(200, { kind: 'block', id: q });
          if (isAddress(q.toLowerCase())) return R(200, { kind: 'address', id: q.toLowerCase() });
          if (/^0x[0-9a-f]{64}$/i.test(q)) {
            if (this.txView(q.toLowerCase())) return R(200, { kind: 'tx', id: q.toLowerCase() });
            if (this.chain.getBlock(q.toLowerCase())) return R(200, { kind: 'block', id: q.toLowerCase() });
          }
          const up = q.toUpperCase();
          if (s.projects[up]) return R(200, { kind: 'project', id: up });
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
      fdk_network: () => s.network,
      fdk_blockNumber: () => s.height,
      fdk_getBlockByNumber: ([n]) => this.chain.getBlock(n === 'latest' ? s.height : n),
      fdk_getBlockByHash: ([h]) => this.chain.getBlock(h),
      fdk_getTransaction: ([h]) => this.txView(h),
      fdk_sendRawTransaction: ([raw]) => this.chain.addTx(raw),
      fdk_getAccount: ([a]) => this.accountView(a),
      fdk_getBalance: ([a]) => { const x = peekAccount(s, String(a).toLowerCase()); return { FDK: x.fdk, STABLE: x.stable }; },
      fdk_getNonce: ([a]) => this.chain.nextNonce(a),
      fdk_status: () => this.status(),
      poa_getValidators: () => this.status().consensus,
      registry_getProjects: () => Object.values(s.projects).map((p) => this._projectSummary(p)),
      registry_getProject: ([id]) => this.projectView(id),
      garden_getGarden: ([id]) => this.gardenView(id),
      garden_getTree: ([id]) => this.treeView(id),
      garden_getDedication: ([id]) => this.dedicationView(id),
    };
    if (!methods[method] && this.eth.has(method)) return this.eth.call(method, params);
    if (!methods[method]) {
      const e = new Error(`method ${method} not found`);
      e.code = -32601;
      throw e;
    }
    return methods[method](params);
  }

}
