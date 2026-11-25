import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetNetwork } from '../src/core/network.js';
import { buildDemo, DRIVERS, VEHICLES, STRANGER_HAND } from '../src/core/scenario.js';
import { alerts, driverSummary } from '../src/core/compliance.js';
import { signTx } from '../src/core/ledger.js';
import { keyFromSeed, hashObject } from '../src/core/crypto.js';
import { GARAGES, PLACES } from '../src/core/geo.js';

const T0 = Date.parse('2026-11-20T06:00:00Z');
function small() {
  const net = new FleetNetwork({ genesisTs: T0 - 3600_000 });
  const a = net.enrolDriver(DRIVERS[0], T0 - 3000_000);
  const b = net.enrolDriver(DRIVERS[1], T0 - 2900_000);
  net.registerVehicle(VEHICLES[0], T0 - 2800_000);
  net.registerVehicle(VEHICLES[2], T0 - 2700_000);
  return { net, a, b };
}

test('palm sign-in matches the enrolled driver and anchors only a hash', () => {
  const { net, a } = small();
  const r = net.signIn({ vehicleId: 'V01', driverRef: a, point: GARAGES.qormi, ts: T0 });
  assert.equal(r.ok, true);
  assert.equal(r.record.palm.result, 'match');
  assert.ok(r.record.palm.score >= r.record.palm.threshold);
  assert.equal(r.tx.body.recordHash, hashObject(r.record));
  assert.equal(net.ledger.openShifts.get('V01').driverRef, a);
  // no raw template or vein data anywhere on the ledger or in the record store
  const template = net.templates.get(a).template;
  const dump = JSON.stringify({ l: net.ledger.export(), s: net.store.export() });
  assert.ok(!dump.includes(template));
  assert.ok(!JSON.stringify(net.ledger.export()).includes(DRIVERS[0].name));
});

test('a borrowed account is refused and the attempt is recorded', () => {
  const { net, a } = small();
  const r = net.signIn({ vehicleId: 'V01', driverRef: a, handSeed: STRANGER_HAND, point: GARAGES.qormi, ts: T0 });
  assert.equal(r.ok, false);
  assert.equal(r.record.palm.result, 'no-match');
  assert.equal(net.ledger.openShifts.size, 0);
  assert.equal(net.ledger.denied.length, 1);
  assert.ok(alerts(net, T0).some((x) => x.kind === 'denied'));
});

test('one driver cannot be signed in to two cars', () => {
  const { net, a } = small();
  net.signIn({ vehicleId: 'V01', driverRef: a, point: GARAGES.qormi, ts: T0 });
  const r = net.signIn({ vehicleId: 'V03', driverRef: a, point: GARAGES.marsa, ts: T0 + 60000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /already signed in/);
});

test('sign-out needs the same palm and records the parked position', () => {
  const { net, a, b } = small();
  net.signIn({ vehicleId: 'V01', driverRef: a, point: GARAGES.qormi, ts: T0 });
  const wrong = net.signOut({ vehicleId: 'V01', handSeed: DRIVERS[1].handSeed, point: GARAGES.qormi, ts: T0 + 3600_000 });
  assert.equal(wrong.ok, false);
  assert.ok(net.ledger.openShifts.has('V01'));
  const ok = net.signOut({ vehicleId: 'V01', point: { lat: GARAGES.qormi.lat + 0.0002, lon: GARAGES.qormi.lon }, ts: T0 + 7200_000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.record.parked.inApprovedGarage, true);
  assert.deepEqual(ok.tx.body.flags, []);
  assert.equal(net.ledger.shifts[0].driverRef, a);
  void b;
});

test('parking away from the garage and spoofed GPS are flagged', () => {
  const { net, a, b } = small();
  net.signIn({ vehicleId: 'V01', driverRef: a, point: GARAGES.qormi, ts: T0 });
  const r1 = net.signOut({ vehicleId: 'V01', point: PLACES.sliema, ts: T0 + 3600_000 });
  assert.ok(r1.tx.body.flags.includes('parked-outside-garage'));
  net.signIn({ vehicleId: 'V03', driverRef: b, point: GARAGES.marsa, ts: T0 + 3700_000 });
  const r2 = net.signOut({ vehicleId: 'V03', point: GARAGES.marsa, spoof: true, ts: T0 + 7200_000 });
  assert.ok(r2.tx.body.flags.includes('location-unauthenticated'));
  const kinds = alerts(net, T0 + 8000_000).map((x) => x.kind);
  assert.ok(kinds.includes('garage') && kinds.includes('spoof'));
});

test('verify detects an edited record; GDPR erasure keeps only the hash', () => {
  const { net, a } = small();
  const r = net.signIn({ vehicleId: 'V01', driverRef: a, point: GARAGES.qormi, ts: T0 });
  assert.equal(net.verifyRecord(r.hash).ok, true);
  const edited = { ...r.record, location: { ...r.record.location, lat: 35.9 } };
  assert.equal(net.verifyRecord(r.hash, edited).ok, false);
  net.eraseRecord(r.hash, T0 + 1000);
  const v = net.verifyRecord(r.hash);
  assert.equal(v.erased, true);
  assert.ok(net.ledger.anchors.has(r.hash));
});

test('only the fitted unit can write for a car; blocks need 2 of 3 validators', () => {
  const { net, a } = small();
  const rogue = keyFromSeed('rogue');
  const tx = signTx(rogue.secret, rogue.pub, 'shift.signin', { vehicleId: 'V01', driverRef: a, recordHash: 'a'.repeat(64), flags: [] }, T0);
  assert.throws(() => net.ledger.check(tx), /not fitted/);
  net.validatorSet.offline.add('audit');
  net.signIn({ vehicleId: 'V01', driverRef: a, point: GARAGES.qormi, ts: T0 });
  net.validatorSet.offline.add('tm');
  assert.throws(() => net.signOut({ vehicleId: 'V01', point: GARAGES.qormi, ts: T0 + 1000 }), /needs 2|offline/);
});

test('import re-validates the chain and rejects tampering', () => {
  const net = buildDemo(Date.parse('2026-11-25T09:00:00Z'));
  const data = JSON.parse(JSON.stringify(net.export()));
  assert.equal(FleetNetwork.import(data).ledger.height, net.ledger.height);
  data.ledger.blocks[40].txs[0].body.flags = ['edited'];
  assert.throws(() => FleetNetwork.import(data));
});

test('demo fleet raises the expected compliance alerts', () => {
  const now = Date.parse('2026-11-25T09:00:00Z');
  const net = buildDemo(now);
  const kinds = new Set(alerts(net, now).map((x) => x.kind));
  for (const k of ['hours', 'rest', 'garage', 'spoof', 'denied', 'licence']) assert.ok(kinds.has(k), k);
  const mark = [...net.ledger.drivers.keys()].find((r) => net.driver(r).name === 'Mark Zammit');
  assert.ok(driverSummary(net, mark, now).worst24h > 12);
});
