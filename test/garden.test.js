// Personal Legacy Garden: contracts/LegacyGarden.sol rules, end to end on the EVM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '../src/core/crypto.js';
import { stable } from '../src/core/units.js';
import { setup, rejects } from './helpers.js';

const H = (n) => '0x' + sha256Hex('photo-' + n).replace(/^0x/, '');
const GPS = { lat: '6.463500', lon: '-2.319400' };
const G = (c) => c.validator.state.garden;

async function withGarden({ batchSize = 3, stablePrice } = {}) {
  const c = await setup(['op', 'steward', 'member', 'stranger'], { noFdk: ['member'] });
  const { A } = c;
  const r = await c.do('gov', 'garden_register', {
    code: 'BITG', name: 'Bibiani Pilot Indigenous Tree Garden', location: 'Bibiani', country: 'Ghana', operator: A.op,
    capacity: 10, batchSize, compartments: ['A', 'B'], centre: GPS, priceGBP: '90000', maintenanceGBP: '2500',
    stablePrice, window: 'Rainy season 2023',
  });
  assert.equal(r.status, 'ok');
  await c.do('op', 'garden_steward', { gardenId: 'BITG', steward: A.steward, name: 'Field supervisor' });
  let n = 0;
  c.ded = (extra = {}) => c.send('op', 'dedication_create', {
    gardenId: 'BITG', holder: A.member, package: 'memorial', purpose: 'memorial', publicName: true,
    dedicatedTo: `Person ${++n}`, descriptor: 'Loving Mother', payment: { ref: `PAY-${n}`, method: 'card', currency: 'GBP', amount: '90000' }, ...extra,
  });
  c.plant = (dedicationId, treeId, who = 'steward') => c.send(who, 'tree_plant', {
    dedicationId, treeId, species: 'Odum', scientific: 'Milicia excelsa', gps: GPS, plantedOn: '2023-11-01', seedSource: 'CSIR-FORIG', photoHash: H(treeId),
  });
  return c;
}

test('only governance registers a Garden; only its operator accredits stewards', async () => {
  const c = await setup(['op', 'stranger']);
  await rejects(c.send('stranger', 'garden_register', { code: 'BITG', name: 'x', location: 'x', country: 'x', operator: c.A.op, capacity: 5, batchSize: 1, compartments: ['A'], centre: GPS, priceGBP: '1', maintenanceGBP: '1', window: 'w' }), /governance only/);
  const g = await withGarden();
  await rejects(g.send('stranger', 'garden_steward', { gardenId: 'BITG', steward: g.A.stranger, name: 'me' }), /only the Garden operator/);
  assert.equal(G(g).gardens.BITG.stewards[g.A.steward].active, true);
  assert.equal(await g.producer.view('LegacyGarden', 'isStewardOf', [await keyOf(g, 'BITG'), g.A.steward]), true);
});

async function keyOf(c, code) {
  const { keccak256, toUtf8Bytes } = await import('ethers');
  void c;
  return keccak256(toUtf8Bytes(code));
}

test('dedications record GBP payment references once and protect unconsented names', async () => {
  const c = await withGarden();
  await c.ded();
  await c.block();
  const d = G(c).dedications['DED-000001'];
  assert.equal(d.holder, c.A.member);
  assert.equal(d.payment.currency, 'GBP');
  assert.equal(d.batchId, 'BITG-PB-01');
  await rejects(c.ded({ payment: { ref: 'PAY-1', method: 'card', currency: 'GBP', amount: '90000' } }), /payment reference already recorded/);
  await rejects(c.ded({ publicName: false }), /without consent/);
  await c.ded({ publicName: false, dedicatedTo: undefined, nameHash: H('private') });
  await c.block();
  const p = G(c).dedications['DED-000002'];
  assert.equal(p.dedicatedTo, null);
  assert.equal(p.nameHash, H('private'));
  // the member never needed FDK
  assert.equal(c.validator.state.accounts[c.A.member].fdk, 0n);
});

test('a batch is released for planting only when it is full', async () => {
  const c = await withGarden({ batchSize: 3 });
  await c.ded();
  await c.ded();
  await c.block();
  await rejects(c.plant('DED-000001', 'BITG-2023-A-001'), /has not been released for planting/);
  const h = await c.ded();
  await c.block();
  assert.ok(c.tx(h).events.find((e) => e.event === 'BatchReleased' && e.batchId === 'BITG-PB-01'));
  assert.equal(G(c).batches['BITG-PB-01'].status, 'released');
  assert.equal(G(c).gardens.BITG.openBatch, 'BITG-PB-02');
  await c.plant('DED-000001', 'BITG-2023-A-001');
  await c.plant('DED-000002', 'BITG-2023-A-002');
  await c.plant('DED-000003', 'BITG-2023-B-001');
  await c.block();
  assert.equal(G(c).batches['BITG-PB-01'].status, 'planted');
  assert.equal(G(c).dedications['DED-000001'].treeId, 'BITG-2023-A-001');
  assert.equal(G(c).trees['BITG-2023-B-001'].plantings[0].gps.lat, '6.463500');
});

test('closing a planting window carries an unfilled batch over to the next window', async () => {
  const c = await withGarden({ batchSize: 3 });
  await c.ded();
  await c.ded();
  await c.block();
  const r = await c.do('steward', 'planting_window_close', { gardenId: 'BITG', nextWindow: 'Minor rainy season 2023' });
  assert.deepEqual({ from: r.events[0].from, to: r.events[0].to, n: r.events[0].carriedOver }, { from: 'BITG-PB-01', to: 'BITG-PB-02', n: 2 });
  assert.equal(G(c).batches['BITG-PB-01'].status, 'carried over');
  assert.equal(G(c).batches['BITG-PB-02'].window, 'Minor rainy season 2023');
  assert.deepEqual(G(c).batches['BITG-PB-02'].dedications, ['DED-000001', 'DED-000002']);
  assert.equal(G(c).dedications['DED-000001'].carryOvers, 1);
  // the carried-over payments count toward the new batch
  const h = await c.ded();
  await c.block();
  assert.ok(c.tx(h).events.find((e) => e.event === 'BatchReleased' && e.batchId === 'BITG-PB-02'));
});

test('tree IDs are unique, well formed and tied to a real compartment', async () => {
  const c = await withGarden({ batchSize: 2 });
  await c.ded();
  await c.ded();
  await c.block();
  await rejects(c.plant('DED-000001', 'BITG-2023-Z-001'), /compartment/);
  await rejects(c.plant('DED-000001', 'XXXX-2023-A-001'), /treeId must look like/);
  await rejects(c.plant('DED-000001', 'BITG-2022-A-001'), /year in the tree ID/);
  await c.plant('DED-000001', 'BITG-2023-A-001');
  await c.block();
  await rejects(c.plant('DED-000002', 'BITG-2023-A-001'), /already in use/);
  await rejects(c.plant('DED-000001', 'BITG-2023-A-009'), /already has a tree/);
});

test('monitoring, death and free replacement keep the full history', async () => {
  const c = await withGarden({ batchSize: 1 });
  await c.ded();
  await c.block();
  await c.plant('DED-000001', 'BITG-2023-A-001');
  await c.block();
  await rejects(c.send('stranger', 'tree_monitor', { treeId: 'BITG-2023-A-001', date: '2023-11-10', heightCm: 40, stemMm: 6, crown: 'good', health: 'healthy' }), /operator or an accredited steward/);
  await c.do('steward', 'tree_monitor', { treeId: 'BITG-2023-A-001', date: '2023-11-10', heightCm: 40, stemMm: 6, crown: 'good', health: 'healthy', photoHash: H('m1') });
  const died = await c.do('steward', 'tree_monitor', { treeId: 'BITG-2023-A-001', date: '2023-11-12', heightCm: 38, stemMm: 6, health: 'dead', cause: 'Termite damage at the root collar' });
  assert.equal(died.events[0].event, 'TreeDied');
  await rejects(c.send('steward', 'tree_monitor', { treeId: 'BITG-2023-A-001', date: '2023-11-13', heightCm: 38, stemMm: 6, crown: 'good', health: 'healthy' }), /recorded as dead/);
  await c.do('steward', 'tree_replace', { treeId: 'BITG-2023-A-001', plantedOn: '2023-11-13', gps: { lat: '6.463510', lon: '-2.319410' }, seedSource: 'Nursery replacement stock', photoHash: H('r1') });
  const t = G(c).trees['BITG-2023-A-001'];
  assert.equal(t.status, 'alive');
  assert.equal(t.plantings.length, 2);
  assert.equal(t.plantings[0].cause, 'Termite damage at the root collar');
  assert.equal(t.plantings[1].underGuarantee, true);
  assert.equal(t.monitoring.length, 2);
  assert.equal(t.dedicationId, 'DED-000001', 'the dedication and name carry over');
});

test('replacement after the guarantee period must say how it is covered', async () => {
  const c = await withGarden({ batchSize: 1 });
  await c.ded();
  await c.block();
  await c.do('steward', 'tree_plant', { dedicationId: 'DED-000001', treeId: 'BITG-2020-A-001', species: 'Wawa', scientific: 'Triplochiton scleroxylon', gps: GPS, plantedOn: '2020-01-10', seedSource: 'x', photoHash: H('p') });
  await c.do('steward', 'tree_monitor', { treeId: 'BITG-2020-A-001', date: '2023-11-01', heightCm: 600, stemMm: 90, health: 'dead', cause: 'Storm' });
  const base = { treeId: 'BITG-2020-A-001', plantedOn: '2023-11-02', gps: GPS, seedSource: 'Nursery', photoHash: H('q') };
  await rejects(c.send('steward', 'tree_replace', base), /coveredBy/);
  await c.do('steward', 'tree_replace', { ...base, coveredBy: 'Legacy package maintenance fund' });
  assert.equal(G(c).trees['BITG-2020-A-001'].plantings[1].underGuarantee, false);
  assert.equal(G(c).trees['BITG-2020-A-001'].plantings[1].coveredBy, 'Legacy package maintenance fund');
});

test('self-service dedication is paid in the stablecoin to the operator, never in FDK', async () => {
  const c = await withGarden({ batchSize: 5, stablePrice: stable('1150').toString() });
  const { A } = c;
  const params = { gardenId: 'BITG', package: 'standard', purpose: 'friendship', publicName: true, dedicatedTo: 'Ama and Kofi' };
  await c.approve('bob', 'LegacyGarden');
  await c.block();
  await rejects(c.send('bob', 'dedication_create', params), /insufficient fUSD/);
  await c.do('issuer', 'stable_mint', { to: A.bob, amount: stable('2000').toString(), reserveRef: 'att' });
  const fdkBefore = c.validator.state.accounts[A.bob].fdk;
  const r = await c.do('bob', 'dedication_create', params);
  const s = c.validator.state;
  assert.equal(s.accounts[A.bob].stable, stable('850'));
  assert.equal(s.accounts[A.op].stable, stable('1150'));
  assert.equal(fdkBefore - s.accounts[A.bob].fdk, BigInt(r.fee), 'FDK only paid gas');
  const d = s.garden.dedications['DED-000001'];
  assert.equal(d.holder, A.bob);
  assert.equal(d.payment.method, 'stablecoin');
});

test('annual maintenance is recorded once per year', async () => {
  const c = await withGarden({ batchSize: 5 });
  await c.ded();
  await c.block();
  const renew = (year, ref) => c.send('op', 'maintenance_renew', { dedicationId: 'DED-000001', year, paymentRef: ref });
  await renew(2024, 'MNT-1');
  await c.block();
  await rejects(renew(2024, 'MNT-2'), /already recorded/);
  await rejects(renew(2025, 'MNT-1'), /payment reference already recorded/);
  assert.equal(G(c).dedications['DED-000001'].renewals[0].year, 2024);
});
