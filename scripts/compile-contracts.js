#!/usr/bin/env node
// Compiles contracts/*.sol with solc-js and writes src/evm/artifacts.json
// (ABI + bytecode). The artifacts are committed, so running the platform does
// not need a Solidity compiler; run `npm run compile` after changing a contract.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(ROOT, 'contracts');
const sources = Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith('.sol')).map((f) => [f, { content: fs.readFileSync(path.join(dir, f), 'utf8') }]));
const input = {
  language: 'Solidity',
  sources,
  settings: {
    evmVersion: 'shanghai',
    viaIR: true,
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
for (const e of out.errors || []) if (e.severity !== 'error') console.warn(e.formattedMessage);
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}
const wanted = ['FedrokGovernance', 'FDKIssuer', 'FUSD', 'CarbonRegistry', 'CarbonMarketplace', 'ProofOfGreen', 'LegacyGarden'];
const artifacts = { compiler: solc.version(), evmVersion: 'shanghai', contracts: {} };
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    if (!wanted.includes(name)) continue;
    artifacts.contracts[name] = { source: `contracts/${file}`, abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
    console.log(`${name.padEnd(18)} ${(c.evm.deployedBytecode.object.length / 2 / 1024).toFixed(1)} KB runtime`);
  }
}
fs.mkdirSync(path.join(ROOT, 'src/evm'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'src/evm/artifacts.json'), JSON.stringify(artifacts));
console.log('wrote src/evm/artifacts.json');
