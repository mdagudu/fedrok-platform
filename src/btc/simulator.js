// Bitcoin network simulator for devnets.
//
// Produces a proof-of-work header chain with a coinbase (miner) address per
// block, so Fedrok nodes can run their Bitcoin light client against it. In
// production the light client points at real Bitcoin headers instead; the
// Fedrok side (header verification, green-miner matching) is the same.
//
// Some simulated miners have keys exposed at /sim/miners so the demo and the
// auditor console can produce the Bitcoin-ownership proof needed to accredit
// them. Real deployments never expose keys.
import http from 'node:http';
import fs from 'node:fs';
import { canonical } from '../core/crypto.js';
import { generatePrivateKey, publicKeyOf, btcSimAddressOf, sha256Hex } from '../core/crypto.js';
import { btcHeaderHash, meetsDifficulty } from '../core/btc.js';
import { MINER_PROFILES } from './profiles.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const PORT = Number(args.port || process.env.BTC_SIM_PORT || 18443);
const BLOCK_MS = Number(args['block-ms'] || process.env.BTC_BLOCK_MS || 10000);
const DIFFICULTY = Number(args.difficulty || 3);
const STATE_FILE = args.state || null;



function loadOrCreate() {
  if (STATE_FILE && fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const miners = MINER_PROFILES.map((p) => {
    const privKey = generatePrivateKey();
    const pubKey = publicKeyOf(privKey);
    return { ...p, privKey, pubKey, address: btcSimAddressOf(pubKey) };
  });
  const genesis = mine({ height: 0, prevHash: '0x' + '0'.repeat(64), time: Date.now(), minerAddress: 'genesis', merkle: sha256Hex('btc-genesis') });
  return { miners, headers: [genesis] };
}

function mine(h) {
  let nonce = 0;
  for (;;) {
    const cand = { ...h, nonce };
    const hash = btcHeaderHash(cand);
    if (meetsDifficulty(hash, DIFFICULTY)) return { ...cand, hash };
    nonce++;
  }
}

const sim = loadOrCreate();
const save = () => STATE_FILE && fs.writeFileSync(STATE_FILE, JSON.stringify(sim));
save();

function pickMiner() {
  const total = sim.miners.reduce((a, m) => a + m.share, 0);
  let r = Math.random() * total;
  for (const m of sim.miners) {
    if ((r -= m.share) <= 0) return m;
  }
  return sim.miners[0];
}

function produce() {
  const prev = sim.headers[sim.headers.length - 1];
  const m = pickMiner();
  const h = mine({ height: prev.height + 1, prevHash: prev.hash, time: Date.now(), minerAddress: m.address, merkle: sha256Hex(canonical({ h: prev.height + 1, r: Math.random() })) });
  sim.headers.push(h);
  save();
}
setInterval(produce, BLOCK_MS);

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/tip') return json(res, 200, sim.headers[sim.headers.length - 1]);
    if (url.pathname === '/headers') {
      const from = Number(url.searchParams.get('from') || 0);
      const limit = Math.min(Number(url.searchParams.get('limit') || 200), 2000);
      return json(res, 200, sim.headers.slice(from, from + limit));
    }
    if (url.pathname === '/sim/miners') {
      return json(res, 200, sim.miners.map(({ name, energy, site, units, share, privKey, pubKey, address }) => ({ name, energy, site, units, share, privKey, pubKey, address })));
    }
    if (url.pathname === '/sim/mine' && req.method === 'POST') {
      produce();
      return json(res, 200, sim.headers[sim.headers.length - 1]);
    }
    json(res, 404, { error: 'not found' });
  })
  .listen(PORT, () => console.log(`[btc-sim] simulated Bitcoin network on :${PORT}, block every ${BLOCK_MS}ms, difficulty ${DIFFICULTY}`));
