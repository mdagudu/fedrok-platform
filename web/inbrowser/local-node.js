// In-browser Fedrok network for the hosted demo.
//
// Runs the real node code inside the page: the EVM with the Fedrok system
// contracts (src/evm), Proof of Green block production, the API layer
// (src/node/api-core.js, including Ethereum JSON-RPC), a simulated Bitcoin
// network, three block-generator identities, the faucet and the demo
// scenario. The web app talks to it through the same /api and /rpc routes it
// uses against a server node; only the transport differs.
import { generatePrivateKey, addressFromPrivate, publicKeyOf, btcSimAddressOf, sha256Hex, canonical } from '../../src/core/crypto.js';
import { btcHeaderHash, meetsDifficulty, MAX_BTC_HEADERS_PER_BLOCK } from '../../src/core/btc.js';
import { buildDevnetGenesis } from '../../src/core/genesis.js';
import { runDemoScenario } from '../../src/core/demo-scenario.js';
import { runGardenScenario } from '../../src/core/garden-scenario.js';
import { FedrokClient } from '../../src/core/client.js';
import { Emitter } from '../../src/core/emitter.js';
import { Chain, stripBlock } from '../../src/evm/chain.js';
import { faucetSend } from '../../src/evm/faucet.js';
import { ApiCore, toJSON } from '../../src/node/api-core.js';
import { MINER_PROFILES } from '../../src/btc/profiles.js';

const STORE = 'fedrok.inbrowser.evm.v1';
const BTC_BLOCK_MS = 10_000;
const HEARTBEAT_MS = 30_000;
// Replaying a long saved chain on page load gets slow: past this many blocks
// the demo starts a fresh network (and seeds it again) instead.
const MAX_SAVED_BLOCKS = 4000;
const ROLES = ['governance', 'auditor', 'stable-issuer', 'faucet', 'generator-1', 'generator-2', 'generator-3', 'demo-buyer', 'developer-png', 'developer-kenya', 'developer-peru', 'miner-aurora', 'miner-andes', 'miner-highlands'];
const GARDEN_ROLES = ['garden-operator', 'garden-steward', 'member-mensah', 'member-owusu', 'member-clarke', 'member-diaspora'];

const store = {
  mem: null,
  get() {
    try {
      return JSON.parse(localStorage.getItem(STORE) || 'null') || this.mem;
    } catch {
      return this.mem;
    }
  },
  set(v) {
    this.mem = v;
    try {
      localStorage.setItem(STORE, JSON.stringify(v));
    } catch {
      /* storage blocked or full: keep running in memory */
    }
  },
  clear() {
    this.mem = null;
    try {
      localStorage.removeItem(STORE);
    } catch {}
  },
};

function mineHeader(prev, minerAddress, difficulty) {
  for (let nonce = 0; ; nonce++) {
    const h = { height: prev ? prev.height + 1 : 0, prevHash: prev ? prev.hash : '0x' + '0'.repeat(64), time: Date.now(), nonce, minerAddress, merkle: sha256Hex(canonical({ h: prev ? prev.height + 1 : 0, r: Math.random() })) };
    const hash = btcHeaderHash(h);
    if (meetsDifficulty(hash, difficulty)) return { ...h, hash };
  }
}

class BrowserBtc extends Emitter {
  constructor(data) {
    super();
    this.miners = data.miners;
    this.headers = data.headers;
    this.synced = true;
    this.url = null;
  }
  get tip() {
    return this.headers[this.headers.length - 1];
  }
  range(fromHeight, toHeight) {
    return this.headers.slice(fromHeight + 1, toHeight + 1);
  }
  produce() {
    const total = this.miners.reduce((a, m) => a + m.share, 0);
    let r = Math.random() * total;
    let m = this.miners[0];
    for (const x of this.miners) if ((r -= x.share) <= 0) { m = x; break; }
    const h = mineHeader(this.tip, m.address, 3);
    this.headers.push(h);
    this.emit('header', h);
  }
}

function freshNetwork() {
  const keys = Object.fromEntries([...ROLES, ...GARDEN_ROLES].map((r) => [r, generatePrivateKey()]));
  const miners = MINER_PROFILES.map((p) => {
    const privKey = generatePrivateKey();
    const pubKey = publicKeyOf(privKey);
    return { ...p, privKey, pubKey, address: btcSimAddressOf(pubKey) };
  });
  const btcGenesis = mineHeader(null, 'genesis', 3);
  const A = Object.fromEntries(Object.entries(keys).map(([r, k]) => [r, addressFromPrivate(k)]));
  const genesis = buildDevnetGenesis(A, btcGenesis, Date.now(), 'fedrok-devnet-web');
  return { keys, genesis, btc: { miners, headers: [btcGenesis] }, blocks: [], seeded: false };
}

class LocalStorageBlocks {
  constructor(saved) {
    this.saved = saved;
  }
  load() {
    return this.saved.blocks || [];
  }
  append() {}
  rewrite() {}
}

// snapshot: a network already seeded with the demo data at build time
// (scripts/build-artifact.js), so a first visit opens on a working network
// instead of waiting for the setup to run in the page.
export async function startLocalNetwork({ snapshot = null } = {}) {
  let data = store.get();
  if (!data || !data.genesis || (data.blocks || []).length > MAX_SAVED_BLOCKS) data = snapshot ? JSON.parse(JSON.stringify(snapshot)) : freshNetwork();
  // Networks saved before the Legacy Garden existed: add its identities.
  for (const r of GARDEN_ROLES) if (!data.keys[r]) data.keys[r] = generatePrivateKey();
  const events = new Emitter();
  const log = { info: () => {}, warn: (...m) => console.warn('[fedrok]', ...m) };
  const btc = new BrowserBtc(data.btc);
  const chain = new Chain(data.genesis, new LocalStorageBlocks(data), log);
  await chain.load();
  const genKeys = ['generator-1', 'generator-2', 'generator-3'].map((r) => data.keys[r]);

  const node = {
    name: 'In-browser node',
    chain,
    btc,
    p2p: { peers: () => [] },
    validatorAddress: addressFromPrivate(genKeys[0]),
    faucetKey: data.keys.faucet,
    async btcSimMiners() {
      return btc.miners;
    },
    async faucetSend(to) {
      return faucetSend(chain, this.faucetKey, to, data.genesis.faucet);
    },
  };
  const api = new ApiCore({ node });

  // Persist (debounced): blocks + Bitcoin headers, so a reload continues the same chain.
  let saveTimer = null;
  const snapshotNow = () => ({ ...data, btc: { miners: btc.miners, headers: btc.headers }, blocks: chain.blocks.map(stripBlock) });
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set(snapshotNow()), 500);
  };
  chain.on('block', (b) => {
    if (b) events.emit('message', { type: 'block', block: api._blockSummary(b) });
    save();
  });
  btc.on('header', save);

  // Catch up the Bitcoin simulator after the tab was closed (max 5 blocks).
  const behind = Math.min(5, Math.floor((Date.now() - btc.tip.time) / BTC_BLOCK_MS));
  for (let i = 0; i < behind; i++) btc.produce();
  setInterval(() => btc.produce(), BTC_BLOCK_MS);

  // Block production: try each generator identity for the current slot.
  // Blocks are produced when there are transactions or Bitcoin headers to
  // record, and otherwise as a heartbeat.
  let lastSlot = -1;
  let producing = false;
  setInterval(async () => {
    const now = Date.now();
    const bt = chain.state.params.blockTimeMs;
    const slot = Math.floor(now / bt);
    if (slot === lastSlot || producing) return;
    lastSlot = slot;
    const anchor = chain.state.pog.anchorHeight;
    const headers = btc.range(anchor, Math.min(btc.tip.height, anchor + MAX_BTC_HEADERS_PER_BLOCK));
    if (!chain.mempool.size && !headers.length && now - chain.state.lastTimestamp < HEARTBEAT_MS) return;
    producing = true;
    try {
      for (const k of genKeys) {
        if (await chain.produce({ timestamp: now, btcHeaders: headers, privKey: k })) break;
      }
    } catch (e) {
      log.warn('block production failed', e.message);
    } finally {
      producing = false;
    }
  }, 150);

  // Route same-origin /api and /rpc requests to the in-page API.
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('/api/') || url.startsWith('/rpc')) {
      const method = (init.method || 'GET').toUpperCase();
      let body = {};
      try {
        body = init.body ? JSON.parse(init.body) : {};
      } catch {
        return new Response(toJSON({ error: 'invalid JSON' }), { status: 400 });
      }
      try {
        const r = await api.handle(method, url, JSON.parse(JSON.stringify(body)));
        if (!r) return new Response(toJSON({ error: 'not found' }), { status: 404 });
        return new Response(r.code === 204 ? null : toJSON(r.body), { status: r.code, headers: { 'content-type': 'application/json' } });
      } catch (e) {
        return new Response(toJSON({ error: e.message }), { status: 500 });
      }
    }
    return realFetch(input, init);
  };

  const local = {
    seed: { running: false, done: data.seeded, lines: [] },
    snapshot: snapshotNow,
    subscribe(cb) {
      events.on('message', cb);
    },
    demoIdentities: [
      { name: 'Corporate buyer', role: 'Holds fUSD: buy and retire credits', key: data.keys['demo-buyer'] },
      { name: 'Auditor', role: 'Issue credits, accredit miners, back-mint FDK', key: data.keys.auditor },
      { name: 'Fedrok AG governance', role: 'Add auditors, change parameters', key: data.keys.governance },
      { name: 'Stablecoin issuer', role: 'Mint fUSD against reserves', key: data.keys['stable-issuer'] },
      { name: 'Project developer (PNG)', role: 'Sells Kikori rainforest credits', key: data.keys['developer-png'] },
      { name: 'Green miner owner (Aurora)', role: 'Approve block generators', key: data.keys['miner-aurora'] },
      { name: 'Garden operator', role: 'Legacy Garden: record subscriptions, close planting windows', key: data.keys['garden-operator'] },
      { name: 'Garden field steward', role: 'Legacy Garden: plant, inspect and replace trees', key: data.keys['garden-steward'] },
      { name: 'Garden member (Mensah family)', role: 'Legacy Garden subscriber: three dedicated trees', key: data.keys['member-mensah'] },
      { name: 'Garden member (Owusu)', role: 'Legacy Garden subscriber: a tree replaced under guarantee', key: data.keys['member-owusu'] },
    ],
    reset() {
      store.clear();
      try {
        localStorage.removeItem('fedrok.wallets.v1');
      } catch {}
      location.hash = '';
      location.reload();
    },
  };

  const gardenKeys = (K) => ({
    gov: K.gov, faucet: K.faucet, buyer: K.buyer, gardenOp: data.keys['garden-operator'], steward: data.keys['garden-steward'],
    mensah: data.keys['member-mensah'], owusu: data.keys['member-owusu'], clarke: data.keys['member-clarke'], diaspora: data.keys['member-diaspora'],
  });
  if (!data.seeded || !data.gardenSeeded) {
    local.seed.running = true;
    local.seed.done = false;
    const K = {
      gov: data.keys.governance, auditor: data.keys.auditor, issuer: data.keys['stable-issuer'], faucet: data.keys.faucet,
      g1: data.keys['generator-1'], g2: data.keys['generator-2'], g3: data.keys['generator-3'], buyer: data.keys['demo-buyer'],
      devPng: data.keys['developer-png'], devKenya: data.keys['developer-kenya'], devPeru: data.keys['developer-peru'],
      ownAurora: data.keys['miner-aurora'], ownAndes: data.keys['miner-andes'], ownHighlands: data.keys['miner-highlands'],
    };
    const c = new FedrokClient('');
    const logLine = (line) => {
      local.seed.lines.push(line.trim());
      events.emit('message', { type: 'seed', line });
    };
    (async () => {
      if (!data.seeded) {
        await runDemoScenario(c, K, btc.miners, logLine);
        data.seeded = true;
        save();
      }
      await runGardenScenario(c, gardenKeys(K), logLine);
      data.gardenSeeded = true;
    })()
      .then(() => {
        data.seeded = true;
        local.seed.done = true;
        save();
      })
      .catch((e) => local.seed.lines.push('Demo setup stopped: ' + e.message))
      .finally(() => {
        local.seed.running = false;
        events.emit('message', { type: 'seed', done: true });
      });
  }
  return local;
}
