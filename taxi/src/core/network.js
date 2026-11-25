// FleetNetwork: the ledger, its validators, the EU record store and the
// in-car units wired together. In production these are separate systems
// (validators at three organisations, an EU-hosted database, units in cars);
// here they run in one process so the whole flow can be demonstrated.
import { keyFromSeed, hashObject, verify, rng as makeRng } from './crypto.js';
import { Ledger, ValidatorSet, signTx } from './ledger.js';
import { InCarUnit, enrolTemplate, driverRefFor, locationFlags, parkedCheck } from './incar.js';

export const OPERATOR_ID = 'fedrok-taxi-mt';
export const CHAIN_ID = 'fedrok-taxi-mt-pilot';

export const VALIDATORS = [
  { id: 'fedrok', name: 'Fedrok AG', org: 'Operator node' },
  { id: 'tm', name: 'Transport Malta', org: 'Regulator observer node' },
  { id: 'audit', name: 'Independent auditor', org: 'Audit node' },
];

/** EU record store: full records (personal data) keyed by hash. Deletable for GDPR. */
export class RecordStore {
  constructor(data = {}) {
    this.records = new Map(Object.entries(data.records || {})); // hash -> { record, seal } | { erased, erasedAt }
    this.directory = new Map(Object.entries(data.directory || {})); // driverRef -> personal details
  }
  put(hash, record, seal) { this.records.set(hash, { record, seal }); }
  get(hash) { return this.records.get(hash); }
  erase(hash, at) { this.records.set(hash, { erased: true, erasedAt: at }); }
  export() { return { records: Object.fromEntries(this.records), directory: Object.fromEntries(this.directory) }; }
}

export class FleetNetwork {
  constructor({ genesisTs, seed = 'fedrok-taxi-demo' } = {}) {
    this.seed = seed;
    this.operatorKey = keyFromSeed(`${seed}:operator`);
    const vkeys = Object.fromEntries(VALIDATORS.map((v) => [v.id, keyFromSeed(`${seed}:validator:${v.id}`)]));
    this.genesis = {
      chainId: CHAIN_ID,
      ts: genesisTs ?? Date.now(),
      operator: { name: 'Fedrok Taxi Malta', pub: this.operatorKey.pub },
      validators: VALIDATORS.map((v) => ({ ...v, pub: vkeys[v.id].pub })),
    };
    this.ledger = new Ledger(this.genesis);
    this.validatorSet = new ValidatorSet(this.ledger, Object.fromEntries(Object.entries(vkeys).map(([k, v]) => [k, v.secret])));
    this.store = new RecordStore();
    this.units = new Map(); // vehicleId -> InCarUnit
    this.hands = new Map(); // driverRef -> hand seed (who the driver physically is; demo only)
    this.templates = new Map(); // enrolment server's copy, pushed to every car's unit
    this.rand = makeRng(seed + ':noise');
  }

  now() { return Math.max(Date.now(), this.ledger.head.header.ts); }

  commit(txs, ts) {
    return this.validatorSet.seal(txs, ts ?? Math.max(...txs.map((t) => t.ts), this.ledger.head.header.ts));
  }

  operatorTx(type, body, ts) { return signTx(this.operatorKey.secret, this.operatorKey.pub, type, body, ts); }

  registerVehicle({ vehicleId, plate, model, garage }, ts = this.now()) {
    const key = keyFromSeed(`${this.seed}:unit:${vehicleId}`);
    const unit = new InCarUnit({ unitId: `UNIT-${vehicleId}`, vehicleId, key });
    const tx = this.operatorTx('vehicle.register', { vehicleId, plate, model, unitId: unit.unitId, unitPub: key.pub, garage }, ts);
    this.commit([tx], ts);
    this.units.set(vehicleId, unit);
    for (const [ref, t] of this.enrolled()) unit.storeTemplate(ref, t);
    return unit;
  }

  enrolled() { return this.templates; }

  enrolDriver({ employeeNo, name, licenceNo, licenceExpiry, tagNo, tagExpiry, handSeed }, ts = this.now()) {
    const driverRef = driverRefFor(OPERATOR_ID, employeeNo);
    const t = enrolTemplate(handSeed, hashObject({ s: this.seed, employeeNo }).slice(0, 32), this.rand);
    const tx = this.operatorTx('driver.enrol', { driverRef, templateCommit: t.commit, licenceExpiry, tagExpiry }, ts);
    this.commit([tx], ts);
    this.templates.set(driverRef, t);
    for (const u of this.units.values()) u.storeTemplate(driverRef, t);
    this.hands.set(driverRef, handSeed);
    this.store.directory.set(driverRef, { employeeNo, name, licenceNo, licenceExpiry, tagNo, tagExpiry });
    return driverRef;
  }

  driver(ref) {
    const onChain = this.ledger.drivers.get(ref);
    if (!onChain) return null;
    return { ref, ...onChain, ...(this.store.directory.get(ref) || { name: 'Erased driver' }) };
  }

  vehicle(id) { return this.ledger.vehicles.get(id); }

  _event(unit, type, record, flags, extra, ts) {
    const { hash, seal } = unit.seal(record);
    this.store.put(hash, record, seal);
    const tx = signTx(unit.key.secret, unit.key.pub, type, { vehicleId: unit.vehicleId, recordHash: hash, flags, ...extra }, ts);
    const block = this.commit([tx], ts);
    return { hash, record, seal, tx, block };
  }

  _denied(unit, ts, claimedDriverRef, reason, palm, location) {
    const record = { kind: 'signin-denied', vehicleId: unit.vehicleId, unitId: unit.unitId, ts, claimedDriverRef, reason, palm, location };
    return { ok: false, reason, ...this._event(unit, 'access.denied', record, ['denied:' + reason], { claimedDriverRef }, ts) };
  }

  /**
   * Shift sign-in: palm scan matched in the car, satellite fix, sealed record,
   * hash anchored on the ledger.
   * @param handSeed whose hand is on the reader (defaults to the account's owner)
   */
  signIn({ vehicleId, driverRef, handSeed, point, spoof = false, ts = this.now() }) {
    const unit = this.units.get(vehicleId);
    if (!unit) throw new Error('unknown vehicle');
    const palm = unit.scanPalm(handSeed ?? this.hands.get(driverRef), driverRef, this.rand);
    const location = unit.fix(point, { spoof }, this.rand);
    if (palm.result !== 'match') return this._denied(unit, ts, driverRef, 'palm-mismatch', palm, location);
    const flags = locationFlags(location);
    const probe = signTx(unit.key.secret, unit.key.pub, 'shift.signin', { vehicleId, driverRef, recordHash: '0'.repeat(64), flags }, ts);
    try { this.ledger.check(probe); } catch (e) { return this._denied(unit, ts, driverRef, 'rule:' + e.message, palm, location); }
    const v = this.vehicle(vehicleId);
    const record = { kind: 'signin', vehicleId, plate: v.plate, unitId: unit.unitId, driverRef, ts, palm, location };
    return { ok: true, ...this._event(unit, 'shift.signin', record, flags, { driverRef }, ts) };
  }

  /** Shift sign-out: palm scan again, and the parked position checked against the approved garage. */
  signOut({ vehicleId, handSeed, point, spoof = false, ts = this.now() }) {
    const unit = this.units.get(vehicleId);
    const open = this.ledger.openShifts.get(vehicleId);
    if (!open) throw new Error('nobody is signed in to this car');
    const driverRef = open.driverRef;
    const palm = unit.scanPalm(handSeed ?? this.hands.get(driverRef), driverRef, this.rand);
    const location = unit.fix(point, { spoof }, this.rand);
    if (palm.result !== 'match') {
      const record = { kind: 'signout-denied', vehicleId, unitId: unit.unitId, ts, claimedDriverRef: driverRef, reason: 'palm-mismatch', palm, location };
      return { ok: false, reason: 'palm-mismatch', ...this._event(unit, 'access.denied', record, ['denied:signout-palm-mismatch'], { claimedDriverRef: driverRef }, ts) };
    }
    const v = this.vehicle(vehicleId);
    const parked = parkedCheck(location, v.garage);
    const flags = [...locationFlags(location)];
    if (!parked.inApprovedGarage) flags.push('parked-outside-garage');
    const record = { kind: 'signout', vehicleId, plate: v.plate, unitId: unit.unitId, driverRef, ts, shiftStart: open.start, palm, location, parked };
    return { ok: true, ...this._event(unit, 'shift.signout', record, flags, { driverRef }, ts) };
  }

  /** GDPR erasure: delete the personal record off-chain; the ledger keeps only its hash and an erasure note. */
  eraseRecord(hash, ts = this.now()) {
    const tx = this.operatorTx('record.erase', { recordHash: hash }, ts);
    this.commit([tx], ts);
    this.store.erase(hash, ts);
  }

  /** Verify: recompute a record's hash and compare it with the ledger anchor and the chip's seal. */
  verifyRecord(hash, record = this.store.get(hash)?.record) {
    const anchorTx = this.ledger.anchors.get(hash);
    const entry = this.store.get(hash);
    if (!anchorTx) return { ok: false, reason: 'No ledger anchor for this hash' };
    const { tx, height } = this.ledger.getTx(anchorTx);
    if (!record) return { ok: false, erased: true, reason: 'Record erased from the EU store; only its hash remains on the ledger', tx, height };
    const recomputed = hashObject(record);
    const sealOk = entry?.seal ? verify(entry.seal.unitPub, hash, entry.seal.sig) : false;
    const unitOk = entry?.seal?.unitPub === tx.from;
    const ok = recomputed === hash && sealOk && unitOk;
    return { ok, recomputed, anchored: hash, sealOk, unitOk, tx, height, reason: ok ? 'Match: the record is exactly as sealed in the car' : recomputed !== hash ? 'Mismatch: the record has been edited since it was sealed' : 'Seal check failed' };
  }

  export() {
    return {
      v: 1, seed: this.seed,
      ledger: this.ledger.export(),
      store: this.store.export(),
      units: [...this.units.values()].map((u) => u.export()),
      hands: Object.fromEntries(this.hands),
    };
  }

  static import(data) {
    const n = new FleetNetwork({ genesisTs: data.ledger.genesis.ts, seed: data.seed });
    n.ledger = Ledger.import(data.ledger); // full re-validation of every block
    n.validatorSet.ledger = n.ledger;
    n.store = new RecordStore(data.store);
    for (const u of data.units) n.units.set(u.vehicleId, new InCarUnit(u));
    if (data.units[0]) n.templates = new Map(Object.entries(data.units[0].templates));
    n.hands = new Map(Object.entries(data.hands));
    return n;
  }
}
