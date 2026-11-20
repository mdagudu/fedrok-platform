#!/usr/bin/env node
// Seeds a running devnet with an end-to-end scenario:
//   accredit green Bitcoin miners -> generators stake and link -> Proof of
//   Green takes over block production -> auditors tokenise carbon credits ->
//   developers list them for stablecoin -> a buyer pays in fUSD and retires.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FedrokClient } from '../src/core/client.js';
import { generatePrivateKey } from '../src/core/crypto.js';
import { runDemoScenario } from '../src/core/demo-scenario.js';
import { runGardenScenario } from '../src/core/garden-scenario.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEYS = path.join(ROOT, 'devnet', 'keys');
const API = process.env.FEDROK_API || 'http://127.0.0.1:8545';
const BTC = process.env.FEDROK_BTC_URL || 'http://127.0.0.1:18443';
const c = new FedrokClient(API);

function key(name) {
  const f = path.join(KEYS, `${name}.key`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, generatePrivateKey() + '\n', { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}

async function main() {
  const K = {
    gov: key('governance'), auditor: key('auditor'), issuer: key('stable-issuer'), faucet: key('faucet'),
    g1: key('generator-1'), g2: key('generator-2'), g3: key('generator-3'), buyer: key('demo-buyer'),
    devPng: key('developer-png'), devKenya: key('developer-kenya'), devPeru: key('developer-peru'),
    ownAurora: key('miner-aurora'), ownAndes: key('miner-andes'), ownHighlands: key('miner-highlands'),
  };
  const simMiners = await (await fetch(BTC + '/sim/miners')).json();
  await runDemoScenario(c, K, simMiners);
  await runGardenScenario(c, {
    gov: K.gov, faucet: K.faucet, buyer: K.buyer,
    gardenOp: key('garden-operator'), steward: key('garden-steward'),
    mensah: key('member-mensah'), owusu: key('member-owusu'), clarke: key('member-clarke'), diaspora: key('member-diaspora'),
  });
  console.log(`Open ${API} to explore. Proof of Green switches to green mode as soon as an accredited miner wins a Bitcoin block.`);
  console.log('Demo wallet keys are in devnet/keys/ (import demo-buyer.key in the web wallet).');
}

main().catch((e) => {
  console.error('\nDemo failed:', e.message);
  process.exit(1);
});
