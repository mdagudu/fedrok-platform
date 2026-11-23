#!/usr/bin/env node
// Seeds a running devnet with demo data: environmental projects (registered,
// proposed, locked & submitted, retired) and the Legacy Garden pilot.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FedrokClient } from '../src/core/client.js';
import { generatePrivateKey } from '../src/core/crypto.js';
import { runRegistryScenario } from '../src/core/registry-scenario.js';
import { runGardenScenario } from '../src/core/garden-scenario.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEYS = path.join(ROOT, 'devnet', 'keys');
const API = process.env.FEDROK_API || 'http://127.0.0.1:8545';
const c = new FedrokClient(API);

function key(name) {
  const f = path.join(KEYS, `${name}.key`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, generatePrivateKey() + '\n', { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}

async function main() {
  const K = { gov: key('governance'), faucet: key('faucet'), buyer: key('demo-buyer') };
  await runRegistryScenario(c, { faucet: K.faucet, png: key('developer-png'), kenya: key('developer-kenya'), peru: key('developer-peru'), zurich: key('community-zurich') });
  await runGardenScenario(c, {
    gov: K.gov, faucet: K.faucet, buyer: K.buyer,
    gardenOp: key('garden-operator'), steward: key('garden-steward'),
    mensah: key('member-mensah'), owusu: key('member-owusu'), clarke: key('member-clarke'), diaspora: key('member-diaspora'),
  });
  console.log(`Open ${API} to explore. Demo wallet keys are in devnet/keys/ (import developer-peru.key to edit a draft project).`);
}

main().catch((e) => {
  console.error('\nDemo failed:', e.message);
  process.exit(1);
});
