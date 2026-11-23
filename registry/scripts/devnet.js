#!/usr/bin/env node
// One-command local network: 3 Fedrok authority validator nodes.
//   npm run devnet            start (re-uses ./devnet if it exists)
//   npm run devnet -- --reset wipe and create a fresh network
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, addressFromPrivate } from '../src/core/crypto.js';
import { buildDevnetGenesis } from '../src/core/genesis.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'devnet');
const reset = process.argv.includes('--reset');
const NODES = [
  { name: 'node-zurich', api: 8545, p2p: 30303, key: 'validator-1', faucet: true },
  { name: 'node-geneva', api: 8546, p2p: 30304, key: 'validator-2' },
  { name: 'node-zug', api: 8547, p2p: 30305, key: 'validator-3' },
];
const children = [];

function run(name, args) {
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const pipe = (s, out) => s.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => out.write(l + '\n')));
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => console.log(`[devnet] ${name} exited (${code})`));
  children.push(child);
  return child;
}

async function waitFor(url, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function key(name) {
  const f = path.join(DIR, 'keys', `${name}.key`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, generatePrivateKey() + '\n', { mode: 0o600 });
  return { file: f, address: addressFromPrivate(fs.readFileSync(f, 'utf8').trim()) };
}

async function main() {
  if (reset && fs.existsSync(DIR)) fs.rmSync(DIR, { recursive: true });
  fs.mkdirSync(path.join(DIR, 'keys'), { recursive: true });

  const genesisFile = path.join(DIR, 'genesis.json');
  if (!fs.existsSync(genesisFile)) {
    const k = Object.fromEntries(['governance', 'stable-issuer', 'faucet', 'validator-1', 'validator-2', 'validator-3', 'demo-buyer'].map((n) => [n, key(n)]));
    const genesis = buildDevnetGenesis(Object.fromEntries(Object.entries(k).map(([n, v]) => [n, v.address])));
    fs.writeFileSync(genesisFile, JSON.stringify(genesis, null, 2));
    console.log('[devnet] created genesis', genesisFile);
  }

  for (const n of NODES) {
    const peers = NODES.filter((o) => o !== n && o.p2p < n.p2p).map((o) => `ws://127.0.0.1:${o.p2p}`);
    const args = ['src/node.js', `--name=${n.name}`, `--genesis=${genesisFile}`, `--data=${path.join(DIR, n.name)}`, `--api-port=${n.api}`, `--p2p-port=${n.p2p}`, `--key=${key(n.key).file}`];
    if (peers.length) args.push(`--peers=${peers.join(',')}`);
    if (n.faucet) args.push(`--faucet-key=${key('faucet').file}`);
    run(n.name, args);
  }
  await waitFor(`http://127.0.0.1:${NODES[0].api}/api/status`);
  console.log(`\n[devnet] Fedrok registry devnet is up.\n  Explorer & wallet:  http://127.0.0.1:${NODES[0].api}\n  Other nodes:        http://127.0.0.1:${NODES[1].api}, http://127.0.0.1:${NODES[2].api}\n  JSON-RPC:           POST http://127.0.0.1:${NODES[0].api}/rpc\n  Seed demo data:     npm run demo\n`);
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { children.forEach((c) => c.kill()); process.exit(0); });
main().catch((e) => {
  console.error(e);
  children.forEach((c) => c.kill());
  process.exit(1);
});
