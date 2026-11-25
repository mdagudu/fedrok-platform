// Permissioned ledger for taxi integrity events.
//
// Who can write:
//   - the fleet operator key registers vehicles (with their in-car unit key and
//     approved garage) and enrols drivers (with a palm-template commitment);
//   - each in-car unit's secure chip signs shift sign-in, sign-out and denied
//     sign-in events for its own vehicle only.
// Who seals blocks: a fixed validator set (Fedrok AG, Transport Malta observer
// node, independent auditor). A block is final with signatures from 2 of 3.
//
// Only hashes and pseudonymous references go on the ledger. The full record
// (palm match result, satellite fix, parked position) lives in the EU record
// store, and its SHA-256 hash is anchored here so anyone with access can
// recompute it and prove that nothing was edited.
import { canonical, hashObject, merkleRoot, sign, verify } from './crypto.js';

export const QUORUM = 2;
export const TX_TYPES = ['vehicle.register', 'driver.enrol', 'driver.suspend', 'shift.signin', 'shift.signout', 'access.denied', 'record.erase'];
const OPERATOR_TYPES = new Set(['vehicle.register', 'driver.enrol', 'driver.suspend', 'record.erase']);
const UNIT_TYPES = new Set(['shift.signin', 'shift.signout', 'access.denied']);
const HEX64 = /^[0-9a-f]{64}$/;

export function txId(tx) {
  return hashObject({ type: tx.type, from: tx.from, ts: tx.ts, body: tx.body });
}

export function signTx(secret, pub, type, body, ts) {
  const tx = { type, from: pub, ts, body };
  tx.id = txId(tx);
  tx.sig = sign(secret, tx.id);
  return tx;
}

export function blockHash(header) {
  return hashObject(header);
}

export class Ledger {
  constructor(genesis) {
    this.genesis = genesis;
    this.validators = genesis.validators; // [{ id, name, org, pub }]
    this.operator = genesis.operator; // { name, pub }
    this.blocks = [];
    this.txIndex = new Map(); // id -> { tx, height }
    this.vehicles = new Map(); // vehicleId -> { ...body, registeredAt }
    this.unitToVehicle = new Map();
    this.drivers = new Map(); // driverRef -> { ...body, status }
    this.openShifts = new Map(); // vehicleId -> { driverRef, start, signinTx }
    this.driverOpen = new Map(); // driverRef -> vehicleId
    this.shifts = []; // { driverRef, vehicleId, start, end, signinTx, signoutTx, flags }
    this.denied = []; // { tx, height }
    this.erased = new Set(); // recordHash
    this.anchors = new Map(); // recordHash -> txId
    this.listeners = new Set();
    const g = { height: 0, prev: '0'.repeat(64), ts: genesis.ts, txRoot: merkleRoot([]), proposer: 'genesis', chain: genesis.chainId };
    this.blocks.push({ header: g, hash: blockHash(g), txs: [], sigs: {} });
  }

  get head() { return this.blocks[this.blocks.length - 1]; }
  get height() { return this.head.header.height; }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  proposerFor(height) { return this.validators[(height - 1) % this.validators.length]; }

  /** Throws with a readable reason if tx is not valid against `view` (defaults to current state). */
  check(tx, view = this) {
    if (!TX_TYPES.includes(tx.type)) throw new Error(`unknown transaction type ${tx.type}`);
    if (tx.id !== txId(tx)) throw new Error('transaction id does not match its contents');
    if (!verify(tx.from, tx.id, tx.sig)) throw new Error('bad signature');
    if (this.txIndex.has(tx.id)) throw new Error('duplicate transaction');
    const b = tx.body || {};
    if (OPERATOR_TYPES.has(tx.type) && tx.from !== this.operator.pub) throw new Error('only the fleet operator can do this');
    if (UNIT_TYPES.has(tx.type)) {
      const v = view.vehicles.get(b.vehicleId);
      if (!v) throw new Error(`vehicle ${b.vehicleId} is not registered`);
      if (v.unitPub !== tx.from) throw new Error('signed by a unit that is not fitted to this vehicle');
      if (!HEX64.test(b.recordHash || '')) throw new Error('record hash missing');
    }
    switch (tx.type) {
      case 'vehicle.register':
        if (!b.vehicleId || !b.plate || !b.unitPub || !b.garage) throw new Error('vehicle, plate, unit key and garage required');
        if (view.vehicles.has(b.vehicleId)) throw new Error('vehicle already registered');
        break;
      case 'driver.enrol':
        if (!HEX64.test(b.driverRef || '') || !HEX64.test(b.templateCommit || '')) throw new Error('driver reference and template commitment required');
        if (view.drivers.has(b.driverRef)) throw new Error('driver already enrolled');
        break;
      case 'driver.suspend':
        if (!view.drivers.has(b.driverRef)) throw new Error('unknown driver');
        break;
      case 'shift.signin': {
        const d = view.drivers.get(b.driverRef);
        if (!d) throw new Error('driver is not enrolled');
        if (d.status !== 'active') throw new Error('driver is suspended');
        if (d.licenceExpiry && tx.ts > Date.parse(d.licenceExpiry + 'T23:59:59Z')) throw new Error('driver licence has expired');
        if (view.openShifts.has(b.vehicleId)) throw new Error('this car already has a driver signed in');
        if (view.driverOpen.has(b.driverRef)) throw new Error('driver is already signed in to another car');
        break;
      }
      case 'shift.signout': {
        const s = view.openShifts.get(b.vehicleId);
        if (!s) throw new Error('nobody is signed in to this car');
        if (s.driverRef !== b.driverRef) throw new Error('sign-out palm does not belong to the signed-in driver');
        if (tx.ts < s.start) throw new Error('sign-out before sign-in');
        break;
      }
      case 'access.denied':
        break;
      case 'record.erase':
        if (!this.anchors.has(b.recordHash)) throw new Error('no such anchored record');
        break;
    }
  }

  apply(tx, height) {
    const b = tx.body;
    this.txIndex.set(tx.id, { tx, height });
    if (b.recordHash && UNIT_TYPES.has(tx.type)) this.anchors.set(b.recordHash, tx.id);
    switch (tx.type) {
      case 'vehicle.register':
        this.vehicles.set(b.vehicleId, { ...b, registeredAt: tx.ts });
        this.unitToVehicle.set(b.unitPub, b.vehicleId);
        break;
      case 'driver.enrol':
        this.drivers.set(b.driverRef, { ...b, status: 'active', enrolledAt: tx.ts });
        break;
      case 'driver.suspend':
        this.drivers.get(b.driverRef).status = 'suspended';
        break;
      case 'shift.signin':
        this.openShifts.set(b.vehicleId, { driverRef: b.driverRef, vehicleId: b.vehicleId, start: tx.ts, signinTx: tx.id, flags: b.flags || [] });
        this.driverOpen.set(b.driverRef, b.vehicleId);
        break;
      case 'shift.signout': {
        const s = this.openShifts.get(b.vehicleId);
        this.openShifts.delete(b.vehicleId);
        this.driverOpen.delete(b.driverRef);
        this.shifts.push({ ...s, end: tx.ts, signoutTx: tx.id, flags: [...s.flags, ...(b.flags || [])] });
        break;
      }
      case 'access.denied':
        this.denied.push({ tx, height });
        break;
      case 'record.erase':
        this.erased.add(b.recordHash);
        break;
    }
  }

  /** Check a batch in order against a scratch view of state (so dependent txs in one block work). */
  checkBatch(txs) {
    const view = {
      vehicles: new Map(this.vehicles),
      drivers: new Map([...this.drivers].map(([k, v]) => [k, { ...v }])),
      openShifts: new Map(this.openShifts),
      driverOpen: new Map(this.driverOpen),
    };
    const seen = new Set();
    for (const tx of txs) {
      if (seen.has(tx.id)) throw new Error('duplicate transaction in block');
      seen.add(tx.id);
      this.check(tx, view);
      const b = tx.body;
      if (tx.type === 'vehicle.register') view.vehicles.set(b.vehicleId, b);
      if (tx.type === 'driver.enrol') view.drivers.set(b.driverRef, { ...b, status: 'active' });
      if (tx.type === 'driver.suspend') view.drivers.get(b.driverRef).status = 'suspended';
      if (tx.type === 'shift.signin') { view.openShifts.set(b.vehicleId, { driverRef: b.driverRef, start: tx.ts }); view.driverOpen.set(b.driverRef, b.vehicleId); }
      if (tx.type === 'shift.signout') { view.openShifts.delete(b.vehicleId); view.driverOpen.delete(b.driverRef); }
    }
  }

  /** Build an unsigned block header for txs. */
  propose(txs, ts) {
    const height = this.height + 1;
    if (ts < this.head.header.ts) throw new Error('block time goes backwards');
    for (const tx of txs) if (tx.ts > ts) throw new Error('transaction is from the future');
    this.checkBatch(txs);
    const header = { height, prev: this.head.hash, ts, txRoot: merkleRoot(txs.map((t) => t.id)), proposer: this.proposerFor(height).id, chain: this.genesis.chainId };
    return { header, hash: blockHash(header), txs, sigs: {} };
  }

  /** Validate a full block (header, signatures, transactions) and append it. */
  append(block) {
    const { header } = block;
    if (header.height !== this.height + 1) throw new Error('wrong height');
    if (header.prev !== this.head.hash) throw new Error('does not extend the chain');
    if (header.chain !== this.genesis.chainId) throw new Error('wrong chain');
    if (header.proposer !== this.proposerFor(header.height).id) throw new Error('wrong proposer');
    if (blockHash(header) !== block.hash) throw new Error('block hash mismatch');
    if (header.txRoot !== merkleRoot(block.txs.map((t) => t.id))) throw new Error('transaction root mismatch');
    if (header.ts < this.head.header.ts) throw new Error('block time goes backwards');
    const good = this.validators.filter((v) => block.sigs[v.id] && verify(v.pub, block.hash, block.sigs[v.id]));
    if (good.length < QUORUM) throw new Error(`needs ${QUORUM} validator signatures, has ${good.length}`);
    if (!block.sigs[header.proposer] || !good.some((v) => v.id === header.proposer)) throw new Error('proposer did not sign');
    this.checkBatch(block.txs);
    for (const tx of block.txs) this.apply(tx, header.height);
    this.blocks.push(block);
    for (const fn of this.listeners) fn(block);
    return block;
  }

  getTx(id) { return this.txIndex.get(id); }
  blockAt(h) { return this.blocks[h]; }

  /** Recompute every block link, root and signature from genesis. */
  audit() {
    const replay = new Ledger(this.genesis);
    for (const b of this.blocks.slice(1)) replay.append(b);
    return { ok: true, height: replay.height, head: replay.head.hash };
  }

  export() {
    return JSON.parse(canonical({ genesis: this.genesis, blocks: this.blocks.slice(1) }));
  }

  static import(data) {
    const l = new Ledger(data.genesis);
    for (const b of data.blocks) l.append(b);
    return l;
  }
}

/** A set of validator nodes run in-process (the demo's stand-in for three organisations' servers). */
export class ValidatorSet {
  constructor(ledger, secrets) {
    this.ledger = ledger;
    this.secrets = secrets; // id -> secret hex
    this.offline = new Set();
  }

  seal(txs, ts) {
    const block = this.ledger.propose(txs, ts);
    const proposer = block.header.proposer;
    if (this.offline.has(proposer)) throw new Error(`${proposer} (proposer) is offline`);
    for (const v of this.ledger.validators) {
      if (this.offline.has(v.id)) continue;
      // Each validator re-checks the proposal before endorsing it.
      this.ledger.checkBatch(txs);
      block.sigs[v.id] = sign(this.secrets[v.id], block.hash);
    }
    return this.ledger.append(block);
  }
}
