// Core protocol tests: state transitions, Proof of Green and block validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, addressFromPrivate, publicKeyOf, btcSimAddressOf, signDigest, btcLinkMessage, sha256Hex } from '../src/core/crypto.js';
import { signTx } from '../src/core/transaction.js';
import { createGenesisState, cloneState, peekAccount } from '../src/core/state.js';
import { buildBlock, applyBlock, btcHeaderHash, meetsDifficulty, schedule } from '../src/core/consensus.js';
import { fdk, stable, tonnesToKg } from '../src/core/units.js';

const DIFF = 1;
function mineHeader(prev, minerAddress) {
  for (let nonce = 0; ; nonce++) {
    const h = { height: prev.height + 1, prevHash: prev.hash, time: Date.now(), nonce, minerAddress, merkle: sha256Hex(String(prev.height)) };
    const hash = btcHeaderHash(h);
    if (meetsDifficulty(hash, DIFF)) return { ...h, hash };
  }
}

function setup() {
  const k = Object.fromEntries(['gov', 'auditor', 'issuer', 'fallback', 'alice', 'bob', 'gen', 'owner'].map((n) => [n, generatePrivateKey()]));
  const A = Object.fromEntries(Object.entries(k).map(([n, v]) => [n, addressFromPrivate(v)]));
  const btc0 = { height: 0, prevHash: '0x' + '0'.repeat(64), time: 0, nonce: 0, minerAddress: 'genesis', merkle: '0x00' };
  btc0.hash = btcHeaderHash(btc0);
  const genesis = {
    chainId: 'fedrok-test', timestamp: 1_700_000_000_000, admin: A.gov, stableIssuer: A.issuer,
    stable: { symbol: 'fUSD', name: 'test', decimals: 6 }, fallbackValidator: A.fallback,
    btc: { anchorHeight: 0, anchorHash: btc0.hash, difficulty: DIFF },
    params: { blockTimeMs: 1000, minFee: fdk('0.001').toString(), minGeneratorStake: fdk('100').toString(), fdkPerUnitYear: fdk('23').toString(), greenWindow: 3, maxGeneratorsPerMiner: 21, marketFeeBps: 50, maxTxPerBlock: 500 },
    auditors: [{ address: A.auditor, name: 'Test auditor' }],
    alloc: ['gov', 'auditor', 'issuer', 'alice', 'bob', 'gen', 'owner'].map((n) => ({ address: A[n], fdk: fdk('1000').toString() })),
  };
  const chain = { k, A, genesis, producer: createGenesisState(genesis), validator: createGenesisState(genesis), nonces: {}, t: genesis.timestamp, btcTip: btc0 };
  chain.tx = (who, type, payload) => {
    chain.nonces[who] = chain.nonces[who] ?? 0;
    return signTx({ chainId: 'fedrok-test', type, nonce: chain.nonces[who]++, fee: fdk('0.001').toString(), payload }, k[who]);
  };
  chain.block = (txs, { btcHeaders = [], key } = {}) => {
    chain.t += 1000;
    const sched = (() => { const s = cloneState(chain.producer); return s; })();
    const signer = key || k.fallback;
    const built = buildBlock(chain.producer, { timestamp: chain.t, btcHeaders, txs, privKey: signer });
    applyBlock(chain.validator, built.block); // independent validation
    assert.equal(chain.validator.tipHash, chain.producer.tipHash);
    return built;
  };
  return chain;
}

test('stablecoin settles marketplace trades; FDK only pays fees', () => {
  const c = setup();
  const { A } = c;
  c.block([c.tx('issuer', 'stable_mint', { to: A.bob, amount: stable('10000').toString(), reserveRef: 'att-1' })]);
  const issued = c.block([c.tx('auditor', 'credit_issue', { to: A.alice, project: 'P', country: 'PG', registry: 'Verra VCS', methodology: 'VM0047', vintage: 2024, serial: 'S-1', quantityKg: tonnesToKg('100').toString() })]);
  assert.equal(issued.rejected.length, 0);
  const batchId = issued.receipts[0].events[0].batchId;
  c.block([c.tx('alice', 'market_list', { batchId, quantityKg: tonnesToKg('50').toString(), pricePerTonne: stable('20').toString() })]);
  const buy = c.block([c.tx('bob', 'market_buy', { listingId: 'LST-000001', quantityKg: tonnesToKg('10').toString() })]);
  assert.equal(buy.rejected.length, 0, JSON.stringify(buy.rejected));
  const s = c.validator;
  assert.equal(peekAccount(s, A.bob).stable, stable('9800'));
  assert.equal(peekAccount(s, A.alice).stable, stable('199')); // 200 minus 0.5% fee
  assert.equal(peekAccount(s, A.gov).stable, stable('1'));
  assert.equal(peekAccount(s, A.bob).credits[batchId], tonnesToKg('10'));
  // Bob's FDK only decreased by the network fee.
  assert.equal(peekAccount(s, A.bob).fdk, fdk('1000') - fdk('0.001'));
});

test('buying without stablecoin fails even with plenty of FDK', () => {
  const c = setup();
  const { A } = c;
  const issued = c.block([c.tx('auditor', 'credit_issue', { to: A.alice, project: 'P', country: 'PG', registry: 'Verra VCS', methodology: 'm', vintage: 2024, serial: 'S-2', quantityKg: '5000' })]);
  c.block([c.tx('alice', 'market_list', { batchId: issued.receipts[0].events[0].batchId, quantityKg: '5000', pricePerTonne: stable('10').toString() })]);
  const r = c.block([c.tx('bob', 'market_buy', { listingId: 'LST-000001', quantityKg: '1000' })]);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].error, /insufficient fUSD/);
});

test('a registry serial can only be tokenised once', () => {
  const c = setup();
  const p = { project: 'P', country: 'KE', registry: 'Gold Standard', methodology: 'm', vintage: 2025, serial: 'GS-1', quantityKg: '1000' };
  c.block([c.tx('auditor', 'credit_issue', p)]);
  const r = c.block([c.tx('auditor', 'credit_issue', p)]);
  assert.match(r.rejected[0].error, /double counting/);
});

test('only auditors issue credits; retirement burns and records', () => {
  const c = setup();
  const r1 = c.block([c.tx('alice', 'credit_issue', { project: 'x', country: 'x', registry: 'x', methodology: 'x', vintage: 2024, serial: 'x', quantityKg: '1' })]);
  assert.match(r1.rejected[0].error, /auditor/);
  const r2 = c.block([c.tx('auditor', 'credit_issue', { project: 'x', country: 'x', registry: 'x', methodology: 'x', vintage: 2024, serial: 'y', quantityKg: '3000' })]);
  const batchId = r2.receipts[0].events[0].batchId;
  c.block([c.tx('auditor', 'credit_retire', { batchId, quantityKg: '1000', beneficiary: 'Fedrok AG', reason: 'test' })]);
  assert.equal(c.validator.batches[batchId].retiredKg, 1000n);
  assert.equal(c.validator.retirements['RET-000001'].beneficiary, 'Fedrok AG');
  assert.equal(c.validator.supply.creditsRetired, 1000n);
});

test('Proof of Green: accredited miner block switches production to its generators, with rewards', () => {
  const c = setup();
  const { A, k } = c;
  const btcKey = generatePrivateKey();
  const btcPub = publicKeyOf(btcKey);
  const btcAddress = btcSimAddressOf(btcPub);
  const btcSig = signDigest(btcLinkMessage(btcAddress, A.owner, 'fedrok-test'), btcKey);
  const acc = c.block([c.tx('auditor', 'miner_accredit', { btcAddress, btcPubKey: btcPub, btcSig, owner: A.owner, units: 10, auditDays: 365, publicGenerators: true, generatorShareBps: 2000 })]);
  assert.equal(acc.rejected.length, 0, JSON.stringify(acc.rejected));
  const minerId = acc.receipts[0].events[0].minerId;
  assert.equal(c.validator.piggyBank, fdk('230'));
  c.block([c.tx('gen', 'generator_register', { stake: fdk('100').toString() }), c.tx('gen', 'generator_link', { minerId })]);
  assert.equal(schedule(c.validator).mode, 'fallback');

  // An accredited miner wins a Bitcoin block -> green mode, generator must sign.
  const h1 = mineHeader(c.btcTip, btcAddress);
  c.btcTip = h1;
  assert.throws(() => buildBlock(cloneState(c.producer), { timestamp: c.t + 1000, btcHeaders: [h1], txs: [], privKey: k.fallback }), /not this generator's slot/);
  const ownerBefore = peekAccount(c.validator, A.owner).fdk;
  const b = c.block([], { btcHeaders: [h1], key: k.gen });
  assert.equal(b.block.header.mode, 'green');
  assert.equal(b.block.header.activeMiner, minerId);
  assert.ok(BigInt(b.block.header.reward) > 0n);
  assert.ok(peekAccount(c.validator, A.owner).fdk > ownerBefore);

  // No green blocks for greenWindow Bitcoin blocks -> fallback validator resumes.
  const hs = [];
  let tip = c.btcTip;
  for (let i = 0; i < 3; i++) hs.push((tip = mineHeader(tip, 'bcsim1dirty')));
  c.btcTip = tip;
  const fb = c.block([], { btcHeaders: hs, key: k.fallback });
  assert.equal(fb.block.header.mode, 'fallback');
});

test('forged Bitcoin ownership proof is rejected', () => {
  const c = setup();
  const btcKey = generatePrivateKey();
  const btcPub = publicKeyOf(btcKey);
  const btcAddress = btcSimAddressOf(btcPub);
  const btcSig = signDigest(btcLinkMessage(btcAddress, c.A.alice, 'fedrok-test'), btcKey); // signed for alice
  const r = c.block([c.tx('auditor', 'miner_accredit', { btcAddress, btcPubKey: btcPub, btcSig, owner: c.A.owner, units: 1 })]);
  assert.match(r.rejected[0].error, /ownership proof/);
});

test('tampered blocks and transactions are rejected by validators', () => {
  const c = setup();
  const good = buildBlock(cloneState(c.producer), { timestamp: c.t + 1000, btcHeaders: [], txs: [c.tx('alice', 'transfer', { to: c.A.bob, asset: 'FDK', amount: '1' })], privKey: c.k.fallback }).block;
  const forged = structuredClone(good);
  forged.txs[0].payload.amount = '999';
  assert.throws(() => applyBlock(cloneState(c.validator), forged), /txRoot|signature|hash/);
  const wrongSigner = buildBlock(cloneState(c.producer), { timestamp: c.t + 1000, btcHeaders: [], txs: [], privKey: c.k.fallback }).block;
  wrongSigner.sig = signDigest(wrongSigner.hash, c.k.alice);
  assert.throws(() => applyBlock(cloneState(c.validator), wrongSigner), /signature/);
  applyBlock(cloneState(c.validator), good); // the untouched block is fine
});

test('governance-only actions are enforced', () => {
  const c = setup();
  const r = c.block([c.tx('alice', 'gov_add_auditor', { auditor: c.A.alice, name: 'me' }), c.tx('alice', 'stable_mint', { to: c.A.alice, amount: '1', reserveRef: 'x' })]);
  assert.equal(r.rejected.length, 2);
  const ok = c.block([c.tx('gov', 'gov_set_param', { key: 'greenWindow', value: 9 })]);
  assert.equal(ok.rejected.length, 0);
  assert.equal(c.validator.params.greenWindow, 9);
});
