// Personal Legacy Garden registry tests.
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
  const k = Object.fromEntries(['gov', 'auditor', 'issuer', 'fallback', 'alice', 'bob', 'gen', 'owner', 'op', 'steward', 'member', 'stranger'].map((n) => [n, generatePrivateKey()]));
  const A = Object.fromEntries(Object.entries(k).map(([n, v]) => [n, addressFromPrivate(v)]));
  const btc0 = { height: 0, prevHash: '0x' + '0'.repeat(64), time: 0, nonce: 0, minerAddress: 'genesis', merkle: '0x00' };
  btc0.hash = btcHeaderHash(btc0);
  const genesis = {
    chainId: 'fedrok-test', timestamp: 1_700_000_000_000, admin: A.gov, stableIssuer: A.issuer,
    stable: { symbol: 'fUSD', name: 'test', decimals: 6 }, fallbackValidator: A.fallback,
    btc: { anchorHeight: 0, anchorHash: btc0.hash, difficulty: DIFF },
    params: { blockTimeMs: 1000, minFee: fdk('0.001').toString(), minGeneratorStake: fdk('100').toString(), fdkPerUnitYear: fdk('23').toString(), greenWindow: 3, maxGeneratorsPerMiner: 21, marketFeeBps: 50, maxTxPerBlock: 500 },
    auditors: [{ address: A.auditor, name: 'Test auditor' }],
    alloc: ['gov', 'auditor', 'issuer', 'alice', 'bob', 'gen', 'owner', 'op', 'steward', 'stranger'].map((n) => ({ address: A[n], fdk: fdk('1000').toString() })),
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
  // Rejected transactions do not use up a nonce: resync after every block.
  const rawBlock = chain.block;
  chain.block = (txs, opts) => {
    const r = rawBlock(txs, opts);
    for (const who of Object.keys(chain.nonces)) chain.nonces[who] = peekAccount(chain.validator, A[who]).nonce;
    return r;
  };
  return chain;
}

const H = (n) => '0x' + sha256Hex('photo-' + n).replace(/^0x/, '');
const GPS = { lat: '6.463500', lon: '-2.319400' };

function withGarden({ batchSize = 3, stablePrice } = {}) {
  const c = setup();
  const { A } = c;
  const r = c.block([c.tx('gov', 'garden_register', {
    code: 'BITG', name: 'Bibiani Pilot Indigenous Tree Garden', location: 'Bibiani', country: 'Ghana', operator: A.op,
    capacity: 10, batchSize, compartments: ['A', 'B'], centre: GPS, priceGBP: '90000', maintenanceGBP: '2500',
    stablePrice, window: 'Rainy season 2023',
  })]);
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  c.block([c.tx('op', 'garden_steward', { gardenId: 'BITG', steward: A.steward, name: 'Field supervisor' })]);
  let n = 0;
  c.ded = (extra = {}) => c.tx('op', 'dedication_create', {
    gardenId: 'BITG', holder: A.member, package: 'memorial', purpose: 'memorial', publicName: true,
    dedicatedTo: `Person ${++n}`, descriptor: 'Loving Mother', payment: { ref: `PAY-${n}`, method: 'card', currency: 'GBP', amount: '90000' }, ...extra,
  });
  c.plant = (dedicationId, treeId, who = 'steward') => c.tx(who, 'tree_plant', {
    dedicationId, treeId, species: 'Odum', scientific: 'Milicia excelsa', gps: GPS, plantedOn: '2023-11-01', seedSource: 'CSIR-FORIG', photoHash: H(treeId),
  });
  return c;
}

test('only governance registers a Garden; only its operator accredits stewards', () => {
  const c = setup();
  const { A } = c;
  const bad = c.block([c.tx('stranger', 'garden_register', { code: 'BITG', name: 'x', location: 'x', country: 'x', operator: A.op, capacity: 5, batchSize: 1, compartments: ['A'], centre: GPS, priceGBP: '1', maintenanceGBP: '1', window: 'w' })]);
  assert.match(bad.rejected[0].error, /governance only/);
  assert.equal(c.validator.garden, undefined, 'a rejected transaction leaves no trace in state');
  const g = withGarden();
  const r = g.block([g.tx('stranger', 'garden_steward', { gardenId: 'BITG', steward: g.A.stranger, name: 'me' })]);
  assert.match(r.rejected[0].error, /only the Garden operator/);
  assert.equal(g.validator.garden.gardens.BITG.stewards[g.A.steward].active, true);
});

test('dedications record GBP payment references once and protect unconsented names', () => {
  const c = withGarden();
  const r = c.block([c.ded()]);
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  const d = c.validator.garden.dedications['DED-000001'];
  assert.equal(d.holder, c.A.member);
  assert.equal(d.payment.currency, 'GBP');
  assert.equal(d.batchId, 'BITG-PB-01');
  const dup = c.block([c.ded({ payment: { ref: 'PAY-1', method: 'card', currency: 'GBP', amount: '90000' } })]);
  assert.match(dup.rejected[0].error, /payment reference already recorded/);
  const priv = c.block([c.ded({ publicName: false })]);
  assert.match(priv.rejected[0].error, /without consent/);
  const ok = c.block([c.ded({ publicName: false, dedicatedTo: undefined, nameHash: H('private') })]);
  assert.equal(ok.rejected.length, 0, JSON.stringify(ok.rejected));
  const p = c.validator.garden.dedications['DED-000002'];
  assert.equal(p.dedicatedTo, null);
  assert.equal(p.nameHash, H('private'));
  // the member never needed FDK
  assert.equal(peekAccount(c.validator, c.A.member).fdk, 0n);
});

test('a batch is released for planting only when it is full', () => {
  const c = withGarden({ batchSize: 3 });
  c.block([c.ded(), c.ded()]);
  const early = c.block([c.plant('DED-000001', 'BITG-2023-A-001')]);
  assert.match(early.rejected[0].error, /has not been released for planting \(2 of 3 paid\)/);
  const r = c.block([c.ded()]);
  assert.ok(r.receipts[0].events.find((e) => e.event === 'BatchReleased'));
  const G = c.validator.garden;
  assert.equal(G.batches['BITG-PB-01'].status, 'released');
  assert.equal(G.gardens.BITG.openBatch, 'BITG-PB-02');
  const p = c.block([c.plant('DED-000001', 'BITG-2023-A-001'), c.plant('DED-000002', 'BITG-2023-A-002'), c.plant('DED-000003', 'BITG-2023-B-001')]);
  assert.equal(p.rejected.length, 0, JSON.stringify(p.rejected));
  assert.equal(G.batches['BITG-PB-01'].status, 'planted');
  assert.equal(G.dedications['DED-000001'].treeId, 'BITG-2023-A-001');
});

test('closing a planting window carries an unfilled batch over to the next window', () => {
  const c = withGarden({ batchSize: 3 });
  c.block([c.ded(), c.ded()]);
  const r = c.block([c.tx('steward', 'planting_window_close', { gardenId: 'BITG', nextWindow: 'Minor rainy season 2023' })]);
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  const G = c.validator.garden;
  assert.equal(G.batches['BITG-PB-01'].status, 'carried over');
  assert.equal(G.batches['BITG-PB-02'].window, 'Minor rainy season 2023');
  assert.deepEqual(G.batches['BITG-PB-02'].dedications, ['DED-000001', 'DED-000002']);
  assert.equal(G.dedications['DED-000001'].carryOvers, 1);
  // the carried-over payments count toward the new batch
  const fill = c.block([c.ded()]);
  assert.ok(fill.receipts[0].events.find((e) => e.event === 'BatchReleased' && e.batchId === 'BITG-PB-02'));
});

test('tree IDs are unique, well formed and tied to a real compartment', () => {
  const c = withGarden({ batchSize: 2 });
  c.block([c.ded(), c.ded()]);
  assert.match(c.block([c.plant('DED-000001', 'BITG-2023-Z-001')]).rejected[0].error, /compartment Z/);
  assert.match(c.block([c.plant('DED-000001', 'XXXX-2023-A-001')]).rejected[0].error, /treeId must look like/);
  assert.match(c.block([c.plant('DED-000001', 'BITG-2022-A-001')]).rejected[0].error, /year in the tree ID/);
  c.block([c.plant('DED-000001', 'BITG-2023-A-001')]);
  assert.match(c.block([c.plant('DED-000002', 'BITG-2023-A-001')]).rejected[0].error, /already in use/);
  assert.match(c.block([c.plant('DED-000001', 'BITG-2023-A-009')]).rejected[0].error, /already has a tree/);
});

test('monitoring, death and free replacement keep the full history', () => {
  const c = withGarden({ batchSize: 1 });
  c.block([c.ded()]);
  c.block([c.plant('DED-000001', 'BITG-2023-A-001')]);
  const stranger = c.block([c.tx('stranger', 'tree_monitor', { treeId: 'BITG-2023-A-001', date: '2023-11-10', heightCm: 40, stemMm: 6, crown: 'good', health: 'healthy' })]);
  assert.match(stranger.rejected[0].error, /operator or an accredited steward/);
  c.block([c.tx('steward', 'tree_monitor', { treeId: 'BITG-2023-A-001', date: '2023-11-10', heightCm: 40, stemMm: 6, crown: 'good', health: 'healthy', photoHash: H('m1') })]);
  const died = c.block([c.tx('steward', 'tree_monitor', { treeId: 'BITG-2023-A-001', date: '2023-11-12', heightCm: 38, stemMm: 6, health: 'dead', cause: 'Termite damage at the root collar' })]);
  assert.equal(died.receipts[0].events[0].event, 'TreeDied');
  const r = c.block([c.tx('steward', 'tree_replace', { treeId: 'BITG-2023-A-001', plantedOn: '2023-11-13', gps: { lat: '6.463510', lon: '-2.319410' }, seedSource: 'Nursery replacement stock', photoHash: H('r1') })]);
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  const t = c.validator.garden.trees['BITG-2023-A-001'];
  assert.equal(t.status, 'alive');
  assert.equal(t.plantings.length, 2);
  assert.equal(t.plantings[0].cause, 'Termite damage at the root collar');
  assert.equal(t.plantings[1].underGuarantee, true);
  assert.equal(t.dedicationId, 'DED-000001', 'the dedication and name carry over');
});

test('replacement after the guarantee period must say how it is covered', () => {
  const c = withGarden({ batchSize: 1 });
  c.block([c.ded()]);
  c.block([c.tx('steward', 'tree_plant', { dedicationId: 'DED-000001', treeId: 'BITG-2020-A-001', species: 'Wawa', scientific: 'Triplochiton scleroxylon', gps: GPS, plantedOn: '2020-01-10', seedSource: 'x', photoHash: H('p') })]);
  c.block([c.tx('steward', 'tree_monitor', { treeId: 'BITG-2020-A-001', date: '2023-11-01', heightCm: 600, stemMm: 90, health: 'dead', cause: 'Storm' })]);
  const base = { treeId: 'BITG-2020-A-001', plantedOn: '2023-11-02', gps: GPS, seedSource: 'Nursery', photoHash: H('q') };
  assert.match(c.block([c.tx('steward', 'tree_replace', base)]).rejected[0].error, /coveredBy/);
  const ok = c.block([c.tx('steward', 'tree_replace', { ...base, coveredBy: 'Legacy package maintenance fund' })]);
  assert.equal(ok.rejected.length, 0, JSON.stringify(ok.rejected));
  assert.equal(c.validator.garden.trees['BITG-2020-A-001'].plantings[1].underGuarantee, false);
});

test('self-service dedication is paid in the stablecoin to the operator, never in FDK', () => {
  const c = withGarden({ batchSize: 5, stablePrice: stable('1150').toString() });
  const { A } = c;
  const params = { gardenId: 'BITG', package: 'standard', purpose: 'friendship', publicName: true, dedicatedTo: 'Ama and Kofi' };
  const broke = c.block([c.tx('bob', 'dedication_create', params)]);
  assert.match(broke.rejected[0].error, /insufficient fUSD/);
  c.block([c.tx('issuer', 'stable_mint', { to: A.bob, amount: stable('2000').toString(), reserveRef: 'att' })]);
  const r = c.block([c.tx('bob', 'dedication_create', params)]);
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  const s = c.validator;
  assert.equal(peekAccount(s, A.bob).stable, stable('850'));
  assert.equal(peekAccount(s, A.op).stable, stable('1150'));
  assert.equal(peekAccount(s, A.bob).fdk, fdk('1000') - fdk('0.001'), 'FDK only paid the network fee');
  const d = s.garden.dedications['DED-000001'];
  assert.equal(d.holder, A.bob);
  assert.equal(d.payment.method, 'stablecoin');
});

test('annual maintenance is recorded once per year', () => {
  const c = withGarden({ batchSize: 5 });
  c.block([c.ded()]);
  const renew = (year, ref) => c.tx('op', 'maintenance_renew', { dedicationId: 'DED-000001', year, paymentRef: ref });
  assert.equal(c.block([renew(2024, 'MNT-1')]).rejected.length, 0);
  assert.match(c.block([renew(2024, 'MNT-2')]).rejected[0].error, /already recorded/);
  assert.match(c.block([renew(2025, 'MNT-1')]).rejected[0].error, /payment reference already recorded/);
});
