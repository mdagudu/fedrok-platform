// In-browser Fedrok network for the hosted demo.
//
// Runs the real node code inside the page: the EVM with the Fedrok system
// contracts (src/evm), Proof of Authority block production with three
// validator identities, the API layer (src/node/api-core.js, including
// Ethereum JSON-RPC), the faucet and the demo data. The web app talks to it
// through the same /api and /rpc routes it uses against a server node; only
// the transport differs.
import { generatePrivateKey, addressFromPrivate } from '../../src/core/crypto.js';
import { buildDevnetGenesis } from '../../src/core/genesis.js';
import { runRegistryScenario } from '../../src/core/registry-scenario.js';
import { runGardenScenario } from '../../src/core/garden-scenario.js';
import { FedrokClient } from '../../src/core/client.js';
import { Emitter } from '../../src/core/emitter.js';
import { Chain, stripBlock } from '../../src/evm/chain.js';
import { faucetSend } from '../../src/evm/faucet.js';
import { ApiCore, toJSON } from '../../src/node/api-core.js';

const STORE = 'fedrok.registry.inbrowser.v2';
const HEARTBEAT_MS = 30_000;
// Replaying a long saved chain on page load gets slow: past this many blocks
// the demo starts a fresh network (and seeds it again) instead.
const MAX_SAVED_BLOCKS = 4000;
const ROLES = ['governance', 'stable-issuer', 'faucet', 'validator-1', 'validator-2', 'validator-3', 'demo-buyer', 'developer-png', 'developer-kenya', 'developer-peru', 'community-zurich'];
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

function freshNetwork() {
  const keys = Object.fromEntries([...ROLES, ...GARDEN_ROLES].map((r) => [r, generatePrivateKey()]));
  const A = Object.fromEntries(Object.entries(keys).map(([r, k]) => [r, addressFromPrivate(k)]));
  const genesis = buildDevnetGenesis(A, Date.now(), 'fedrok-registry-web');
  return { keys, genesis, blocks: [], seeded: false };
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
  for (const r of [...ROLES, ...GARDEN_ROLES]) if (!data.keys[r]) data.keys[r] = generatePrivateKey();
  const events = new Emitter();
  const log = { info: () => {}, warn: (...m) => console.warn('[fedrok]', ...m) };
  const chain = new Chain(data.genesis, new LocalStorageBlocks(data), log);
  await chain.load();
  const valKeys = ['validator-1', 'validator-2', 'validator-3'].map((r) => data.keys[r]);

  const node = {
    name: 'In-browser node',
    chain,
    p2p: { peers: () => [] },
    validatorAddress: addressFromPrivate(valKeys[0]),
    faucetKey: data.keys.faucet,
    async faucetSend(to) {
      return faucetSend(chain, this.faucetKey, to, data.genesis.faucet);
    },
  };
  const api = new ApiCore({ node });

  // Persist (debounced): the blocks, so a reload continues the same chain.
  let saveTimer = null;
  const snapshotNow = () => ({ ...data, blocks: chain.blocks.map(stripBlock) });
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set(snapshotNow()), 500);
  };
  chain.on('block', (b) => {
    if (b) events.emit('message', { type: 'block', block: api._blockSummary(b) });
    save();
  });
  // Block production (Proof of Authority): the slot's validator seals the
  // block. Blocks are produced when there are transactions, and otherwise as
  // a heartbeat.
  let lastSlot = -1;
  let producing = false;
  setInterval(async () => {
    const now = Date.now();
    const bt = chain.state.params.blockTimeMs;
    const slot = Math.floor(now / bt);
    if (slot === lastSlot || producing) return;
    lastSlot = slot;
    if (!chain.mempool.size && now - chain.state.lastTimestamp < HEARTBEAT_MS) return;
    producing = true;
    try {
      for (const k of valKeys) {
        if (await chain.produce({ timestamp: now, privKey: k })) break;
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
      { name: 'Project developer (Peru)', role: 'Owns a draft proposal: continue it with Sprout', key: data.keys['developer-peru'] },
      { name: 'Community cooperative (Zurich)', role: 'Owns a nearly empty draft: let Sprout interview you', key: data.keys['community-zurich'] },
      { name: 'Project developer (Kenya)', role: 'Owns two locked & submitted projects', key: data.keys['developer-kenya'] },
      { name: 'Project developer (PNG)', role: 'Owns a locked project and a retired proposal', key: data.keys['developer-png'] },
      { name: 'Fedrok AG governance', role: 'Validators, project types, parameters', key: data.keys.governance },
      { name: 'Garden operator', role: 'Legacy Garden: record subscriptions, close planting windows', key: data.keys['garden-operator'] },
      { name: 'Garden field steward', role: 'Legacy Garden: plant, inspect and replace trees', key: data.keys['garden-steward'] },
      { name: 'Garden member (Mensah family)', role: 'Legacy Garden subscriber: three dedicated trees', key: data.keys['member-mensah'] },
    ],
    reset() {
      store.clear();
      try {
        localStorage.removeItem('fedrok.registry.accounts.v2');
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
    const c = new FedrokClient('');
    const logLine = (line) => {
      local.seed.lines.push(line.trim());
      events.emit('message', { type: 'seed', line });
    };
    const K = data.keys;
    (async () => {
      if (!data.seeded) {
        await runRegistryScenario(c, { faucet: K.faucet, png: K['developer-png'], kenya: K['developer-kenya'], peru: K['developer-peru'], zurich: K['community-zurich'] }, logLine);
        data.seeded = true;
        save();
      }
      await runGardenScenario(c, {
        gov: K.governance, faucet: K.faucet, buyer: K['demo-buyer'], gardenOp: K['garden-operator'], steward: K['garden-steward'],
        mensah: K['member-mensah'], owusu: K['member-owusu'], clarke: K['member-clarke'], diaspora: K['member-diaspora'],
      }, logLine);
      data.gardenSeeded = true;
    })()
      .then(() => {
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
