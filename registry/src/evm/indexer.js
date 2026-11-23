// Indexer: projects the EVM chain into the read model the API and web app use.
//
// The source of truth is the EVM state and the contract event logs. After
// each block the indexer decodes the logs of the Fedrok system contracts
// (plus the decoded calldata of the transaction that emitted them) and keeps
// an in-memory view: accounts with FDK / fUSD balances, the project registry
// and the Legacy Garden. Small singletons (parameters, roles, the validator
// set) are re-read from the contracts with view calls. Like an explorer
// database, this view can be rebuilt at any time by replaying the chain.
import { ADDRESSES, BY_ADDRESS, IFACE } from './contracts.js';
import { ids, fromDay, fromGps, PACKAGES, PROJECT_KINDS } from './actions.js';
import { viewCall, addrOf } from './vm.js';

const SYSTEM_CONTRACTS = new Set(Object.values(ADDRESSES));
const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO32 = '0x' + '0'.repeat(64);
const lc = (a) => (typeof a === 'string' ? a.toLowerCase() : a);
const isUser = (a) => a && a !== ZERO && !SYSTEM_CONTRACTS.has(a);
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);

export function createProjection(genesis, genesisHash) {
  return {
    chainId: genesis.chainId,
    network: genesis.network,
    height: 0,
    tipHash: genesisHash,
    lastTimestamp: genesis.timestamp,
    params: {},
    admin: genesis.admin,
    stableIssuer: genesis.stableIssuer,
    stable: genesis.stable,
    validators: genesis.validators.map((v) => lc(v.address)),
    validatorInfo: Object.fromEntries(genesis.validators.map((v) => [lc(v.address), { name: v.name, blocks: 0 }])),
    contracts: ADDRESSES,
    accounts: {},
    projectTypes: [...(genesis.projectTypes || [])],
    projects: {},
    fdkCap: BigInt(genesis.fdkCap),
    supply: { fdkMinted: 0n, fdkBurned: 0n, fdkFees: 0n, stableMinted: 0n, stableBurned: 0n },
    counters: { projects: 0, locked: 0, retired: 0, txs: 0 },
    garden: { gardens: {}, trees: {}, dedications: {}, batches: {}, paymentRefs: {}, counters: { dedications: 0 }, keys: {}, batchIds: {}, treeKeys: {} },
  };
}

export function account(s, a) {
  if (!s.accounts[a]) s.accounts[a] = { fdk: 0n, stable: 0n, nonce: 0, allowances: {} };
  return s.accounts[a];
}
export function peekAccount(s, a) {
  return s.accounts[a] || { fdk: 0n, stable: 0n, nonce: 0, allowances: {} };
}

export class Indexer {
  constructor(genesis, genesisHash) {
    this.genesis = genesis;
    this.state = createProjection(genesis, genesisHash);
  }

  /** Read singletons from the contracts, and every touched balance. */
  async refresh(vm, block, { all = false, full = all, touched = new Set() } = {}) {
    const s = this.state;
    const v = (c, fn, args) => viewCall(vm, block, c, fn, args);
    if (full) await this._refreshStructure(v);
    const issuerBal = (await vm.stateManager.getAccount(addrOf(ADDRESSES.FDKIssuer)))?.balance ?? 0n;
    s.supply.fdkMinted = s.fdkCap - issuerBal;
    s.supply.fdkBurned = (await vm.stateManager.getAccount(addrOf('0x000000000000000000000000000000000000dead')))?.balance ?? 0n;
    const addrs = all ? Object.keys(s.accounts) : [...touched];
    for (const a of addrs) {
      if (!isUser(a)) continue;
      const x = await vm.stateManager.getAccount(addrOf(a));
      const acct = account(s, a);
      acct.fdk = x ? x.balance : 0n;
      acct.nonce = x ? Number(x.nonce) : 0;
    }
  }

  async _refreshStructure(v) {
    const s = this.state;
    const p = await v('FedrokGovernance', 'params');
    s.params = { blockTimeMs: Number(p.blockTimeMs), minGasPrice: p.minGasPrice, maxTxPerBlock: Number(p.maxTxPerBlock) };
    s.admin = lc(await v('FedrokGovernance', 'admin'));
    s.stableIssuer = lc(await v('FedrokGovernance', 'stableIssuer'));
    s.validators = (await v('FedrokGovernance', 'validatorList')).map(lc);
    for (const a of s.validators) {
      if (!s.validatorInfo[a]) s.validatorInfo[a] = { name: await v('FedrokGovernance', 'validatorName', [a]), blocks: 0 };
    }
    s.projectTypes = [...(await v('ProjectRegistry', 'projectTypeList'))];
  }

  /** Genesis allocations and roles. */
  async init(vm, block) {
    const s = this.state;
    for (const a of this.genesis.alloc || []) {
      const acct = account(s, lc(a.address));
      if (a.stable) {
        acct.stable += BigInt(a.stable);
        s.supply.stableMinted += BigInt(a.stable);
      }
    }
    await this.refresh(vm, block, { all: true });
  }

  /**
   * Apply one executed block. `results[i]` = { status, logs, gasUsed, fee, error } for block.txs[i].
   * Returns the decoded Fedrok events for every transaction.
   */
  async applyBlock(vm, ctxBlock, block, results) {
    const s = this.state;
    const h = block.header;
    const touched = new Set([h.validator]);
    let structural = false;
    const ctx = { ts: h.timestamp, height: h.height, touched };
    if (s.validatorInfo[h.validator]) s.validatorInfo[h.validator].blocks += 1;
    const txEvents = [];
    block.txs.forEach((tx, i) => {
      const r = results[i];
      touched.add(tx.from);
      if (tx.to) touched.add(tx.to);
      s.counters.txs += 1;
      s.supply.fdkFees += BigInt(r.fee);
      const events = [];
      if (r.status === 1) {
        if (tx.type === 'transfer' && tx.payload.asset === 'FDK') events.push({ event: 'Transfer', asset: 'FDK', from: tx.from, to: tx.payload.to, amount: BigInt(tx.payload.amount) });
        const logs = r.logs.map((l) => this._decode(l)).filter(Boolean);
        // The Garden is registered before its first batch is opened in the view.
        logs.sort((a, b) => (a.name === 'GardenRegistered' ? -1 : 0) - (b.name === 'GardenRegistered' ? -1 : 0));
        for (const d of logs) {
          for (const v of Object.values(d.args)) if (typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v)) touched.add(v);
          if (d.contract === 'FedrokGovernance' || d.name === 'ProjectTypeAdded') structural = true;
          const ev = this._apply(d, tx, ctx);
          if (ev) events.push(...(Array.isArray(ev) ? ev : [ev]));
        }
      }
      txEvents.push(events);
    });
    s.height = h.height;
    s.tipHash = block.hash;
    s.lastTimestamp = h.timestamp;
    await this.refresh(vm, ctxBlock, { touched, full: structural });
    return txEvents;
  }

  _decode(log) {
    const address = lc(typeof log.address === 'string' ? log.address : log.address.toString());
    const contract = BY_ADDRESS[address];
    if (!contract) return null;
    try {
      const p = IFACE[contract].parseLog({ topics: log.topics, data: log.data });
      if (!p) return null;
      const args = {};
      p.fragment.inputs.forEach((inp, i) => {
        const v = p.args[i];
        args[inp.name] = typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v;
      });
      return { contract, name: p.name, args };
    } catch {
      return null;
    }
  }

  _apply({ contract, name, args: a }, tx, { ts, height }) {
    const s = this.state;
    const G = s.garden;
    const sym = s.stable.symbol;
    const P = tx.payload || {};
    switch (`${contract}.${name}`) {
      // ---------------------------------------------------------- fUSD
      case 'FUSD.Transfer':
        if (isUser(a.from)) account(s, a.from).stable -= a.value;
        if (isUser(a.to)) account(s, a.to).stable += a.value;
        return tx.type === 'transfer' ? { event: 'Transfer', asset: 'STABLE', from: a.from, to: a.to, amount: a.value } : null;
      case 'FUSD.Approval':
        account(s, a.owner).allowances[a.spender] = a.value;
        return { event: 'Approval', owner: a.owner, spender: a.spender, spenderName: BY_ADDRESS[a.spender] || null, amount: a.value };
      case 'FUSD.StableMinted':
        s.supply.stableMinted += a.amount;
        return { event: 'StableMinted', to: a.to, amount: a.amount, reserveRef: a.reserveRef };
      case 'FUSD.StableRedeemed':
        s.supply.stableBurned += a.amount;
        return { event: 'StableRedeemed', from: a.from, amount: a.amount, redemptionRef: a.redemptionRef };
      // ---------------------------------------------------------- FDK
      case 'FDKIssuer.Burned':
        return tx.type === 'fdk_burn' ? { event: 'FdkBurned', from: a.from, amount: a.amount, reason: a.reason } : null;
      // ---------------------------------------------------------- governance
      case 'FedrokGovernance.ValidatorAdded':
        s.validatorInfo[a.validator] = { name: a.name, blocks: s.validatorInfo[a.validator]?.blocks || 0 };
        return { event: 'ValidatorAdded', validator: a.validator, name: a.name };
      case 'FedrokGovernance.ValidatorRemoved':
        return { event: 'ValidatorRemoved', validator: a.validator };
      case 'FedrokGovernance.StableIssuerSet':
        return { event: 'StableIssuerSet', issuer: a.issuer };
      case 'FedrokGovernance.ParamSet':
        return { event: 'ParamSet', key: a.key, value: a.value.toString() };
      // ---------------------------------------------------------- project registry
      case 'ProjectRegistry.ProjectTypeAdded':
        return { event: 'ProjectTypeAdded', projectType: a.projectType };
      case 'ProjectRegistry.ProjectCreated': {
        const id = ids.project(a.id);
        s.projects[id] = {
          id, kind: PROJECT_KINDS[Number(a.kind)], status: 'draft', owner: a.owner, projectType: a.projectType,
          name: P.name, summary: P.summary, location: P.location, country: P.country, details: P.details || {},
          revision: 0, createdAt: ts, updatedAt: ts, lockedAt: null, retiredAt: null, lockedHash: null, retireReason: null,
          history: [{ action: 'created', revision: 0, tx: tx.hash, at: ts, height }],
        };
        s.counters.projects += 1;
        return { event: 'ProjectCreated', projectId: id, owner: a.owner, kind: PROJECT_KINDS[Number(a.kind)], projectType: a.projectType, name: a.name };
      }
      case 'ProjectRegistry.ProjectUpdated': {
        const p = s.projects[ids.project(a.id)];
        const before = { name: p.name, summary: p.summary, location: p.location, country: p.country, details: p.details };
        Object.assign(p, { name: P.name, summary: P.summary, location: P.location, country: P.country, details: P.details || {}, revision: Number(a.revision), updatedAt: ts });
        const changed = ['name', 'summary', 'location', 'country'].filter((k) => before[k] !== p[k]);
        const keys = new Set([...Object.keys(before.details), ...Object.keys(p.details)]);
        for (const k of keys) if (JSON.stringify(before.details[k]) !== JSON.stringify(p.details[k])) changed.push(k);
        p.history.push({ action: 'updated', revision: Number(a.revision), tx: tx.hash, at: ts, height, contentHash: a.contentHash, changed });
        return { event: 'ProjectUpdated', projectId: p.id, revision: Number(a.revision), changed };
      }
      case 'ProjectRegistry.ProjectLocked': {
        const p = s.projects[ids.project(a.id)];
        Object.assign(p, { status: 'locked', lockedAt: ts, lockedHash: a.contentHash });
        p.history.push({ action: 'locked', revision: Number(a.revision), tx: tx.hash, at: ts, height, contentHash: a.contentHash });
        s.counters.locked += 1;
        return { event: 'ProjectLocked', projectId: p.id, contentHash: a.contentHash };
      }
      case 'ProjectRegistry.ProjectRetired': {
        const p = s.projects[ids.project(a.id)];
        Object.assign(p, { status: 'retired', retiredAt: ts, retireReason: a.reason, retiredAfterLock: a.wasLocked });
        p.history.push({ action: 'retired', revision: p.revision, tx: tx.hash, at: ts, height, reason: a.reason });
        if (a.wasLocked) s.counters.locked -= 1;
        s.counters.retired += 1;
        return { event: 'ProjectRetired', projectId: p.id, reason: a.reason };
      }
      // ---------------------------------------------------------- Legacy Garden
      case 'LegacyGarden.GardenRegistered': {
        const code = a.code;
        G.keys[a.gardenKey] = code;
        G.gardens[code] = {
          id: code, name: P.name, location: P.location, country: P.country, operator: a.operator, operatorName: P.operatorName || '',
          capacity: P.capacity, batchSize: P.batchSize, compartments: P.compartments, centre: P.centre,
          priceGBP: BigInt(P.priceGBP), maintenanceGBP: BigInt(P.maintenanceGBP), stablePrice: BigInt(P.stablePrice || 0),
          replacementMonths: P.replacementMonths, lifespanYears: P.lifespanYears, agreementHash: P.agreementHash || null,
          stewards: {}, batchCount: 0, openBatch: null, registeredAt: ts, registerTx: tx.hash,
        };
        return { event: 'GardenRegistered', gardenId: code, operator: a.operator, capacity: P.capacity, batchSize: P.batchSize, openBatch: null };
      }
      case 'LegacyGarden.BatchOpened': {
        const code = G.keys[a.gardenKey];
        const g = G.gardens[code];
        const id = ids.gardenBatch(code, Number(a.n));
        G.batchIds[a.batchId.toString()] = id;
        G.batches[id] = { id, gardenId: code, window: a.window, size: g.batchSize, status: 'open', dedications: [], openedAt: ts, carriedFrom: a.carriedFrom ? G.batchIds[a.carriedFrom.toString()] : null, carriedTo: null, releasedAt: null, plantedAt: null };
        g.batchCount = Number(a.n);
        g.openBatch = id;
        return null;
      }
      case 'LegacyGarden.StewardSet': {
        const code = G.keys[a.gardenKey];
        const g = G.gardens[code];
        g.stewards[a.steward] = { name: a.active ? a.name : g.stewards[a.steward]?.name || '', active: a.active };
        return { event: a.active ? 'StewardAccredited' : 'StewardRemoved', gardenId: code, steward: a.steward };
      }
      case 'LegacyGarden.DedicationCreated': {
        const code = G.keys[a.gardenKey];
        const id = ids.dedication(a.dedicationId);
        const batchId = G.batchIds[a.batchId.toString()];
        const method = Number(a.method);
        const payment = method === 2
          ? { ref: tx.hash, method: 'stablecoin', currency: sym, amount: a.amount, paidOn: dayStr(ts) }
          : { ref: P.payment?.ref, method: P.payment?.method, currency: 'GBP', amount: a.amount, paidOn: P.payment?.paidOn || null };
        G.counters.dedications = Number(a.dedicationId);
        G.dedications[id] = {
          id, gardenId: code, holder: a.holder, package: P.package, purpose: P.purpose, publicName: Boolean(P.publicName),
          dedicatedTo: P.publicName ? P.dedicatedTo : null, descriptor: P.publicName ? P.descriptor || '' : null, nameHash: P.publicName ? null : P.nameHash, inscription: P.publicName ? P.inscription || '' : '',
          preferredSpecies: P.preferredSpecies || '', detailsHash: P.detailsHash || null, agreementHash: P.agreementHash || null, payment,
          batchId, carryOvers: 0, treeId: null, status: 'awaiting batch', renewals: [], subscribedAt: ts, recordedBy: tx.from, tx: tx.hash, height,
        };
        G.paymentRefs[payment.ref] = id;
        G.batches[batchId].dedications.push(id);
        return { event: 'DedicationCreated', dedicationId: id, gardenId: code, holder: a.holder, package: P.package, batchId, paymentRef: payment.ref, method: payment.method };
      }
      case 'LegacyGarden.BatchReleased': {
        const b = G.batches[G.batchIds[a.batchId.toString()]];
        b.status = 'released';
        b.releasedAt = ts;
        for (const d of b.dedications) G.dedications[d].status = 'ready to plant';
        return { event: 'BatchReleased', batchId: b.id, gardenId: b.gardenId, trees: b.dedications.length, nextBatch: G.batchIds[a.nextBatch.toString()] };
      }
      case 'LegacyGarden.PlantingWindowClosed': {
        const code = G.keys[a.gardenKey];
        const from = G.batches[G.batchIds[a.fromBatch.toString()]];
        if (a.fromBatch === a.toBatch) {
          const old = from.window;
          from.window = a.nextWindow;
          return { event: 'PlantingWindowClosed', gardenId: code, window: old, nextWindow: a.nextWindow, carriedOver: 0 };
        }
        const to = G.batches[G.batchIds[a.toBatch.toString()]];
        from.status = 'carried over';
        from.closedAt = ts;
        from.carriedTo = to.id;
        to.dedications = [...from.dedications];
        for (const d of to.dedications) {
          G.dedications[d].batchId = to.id;
          G.dedications[d].carryOvers += 1;
        }
        return { event: 'PlantingWindowClosed', gardenId: code, window: from.window, nextWindow: a.nextWindow, carriedOver: to.dedications.length, from: from.id, to: to.id };
      }
      case 'LegacyGarden.TreePlanted': {
        const d = G.dedications[ids.dedication(a.dedicationId)];
        const m = a.treeId.match(/^([A-Z]{2,6})-(\d{4})-([A-Z])-(\d{3})$/);
        G.treeKeys[a.treeKey] = a.treeId;
        G.trees[a.treeId] = {
          id: a.treeId, gardenId: d.gardenId, compartment: m[3], number: Number(m[4]), species: P.species, scientific: P.scientific,
          dedicationId: d.id, status: 'alive',
          plantings: [{ n: 1, plantedOn: P.plantedOn, gps: P.gps, seedSource: P.seedSource, photoHash: P.photoHash, steward: tx.from, tx: tx.hash, height, diedOn: null, cause: null }],
          monitoring: [], createdAt: ts,
        };
        d.treeId = a.treeId;
        d.status = 'planted';
        return { event: 'TreePlanted', treeId: a.treeId, dedicationId: d.id, gardenId: d.gardenId, species: P.species, plantedOn: P.plantedOn };
      }
      case 'LegacyGarden.BatchPlanted': {
        const b = G.batches[G.batchIds[a.batchId.toString()]];
        b.status = 'planted';
        b.plantedAt = ts;
        return { event: 'BatchPlanted', batchId: b.id, trees: b.dedications.length };
      }
      case 'LegacyGarden.TreeMonitored': {
        const t = G.trees[G.treeKeys[a.treeKey]];
        const cur = t.plantings[t.plantings.length - 1];
        const date = fromDay(a.date);
        const entry = {
          date, planting: cur.n, heightCm: P.heightCm, stemMm: P.stemMm, crown: P.crown, health: P.health, photoHash: P.photoHash || null,
          note: P.note || '', cause: a.died ? P.cause : null, steward: tx.from, tx: tx.hash, height,
        };
        t.monitoring.push(entry);
        if (a.died) {
          t.status = 'dead';
          cur.diedOn = date;
          cur.cause = P.cause;
          return { event: 'TreeDied', treeId: t.id, date, cause: P.cause };
        }
        return { event: 'TreeMonitored', treeId: t.id, date, heightCm: P.heightCm, health: P.health };
      }
      case 'LegacyGarden.TreeReplaced': {
        const t = G.trees[G.treeKeys[a.treeKey]];
        const g = G.gardens[t.gardenId];
        t.plantings.push({
          n: Number(a.planting), plantedOn: P.plantedOn, gps: P.gps, seedSource: P.seedSource, photoHash: P.photoHash, steward: tx.from, tx: tx.hash, height,
          diedOn: null, cause: null, underGuarantee: a.underGuarantee, coveredBy: a.underGuarantee ? `free replacement (${g.replacementMonths}-month guarantee)` : a.coveredBy,
        });
        t.status = 'alive';
        if (P.species) t.species = P.species;
        if (P.scientific) t.scientific = P.scientific;
        return { event: 'TreeReplaced', treeId: t.id, planting: Number(a.planting), plantedOn: P.plantedOn, underGuarantee: a.underGuarantee };
      }
      case 'LegacyGarden.MaintenanceRenewed': {
        const d = G.dedications[ids.dedication(a.dedicationId)];
        const g = G.gardens[d.gardenId];
        d.renewals.push({ year: Number(a.year), ref: a.paymentRef, amount: g.maintenanceGBP, currency: 'GBP', at: ts, tx: tx.hash });
        G.paymentRefs[a.paymentRef] = d.id;
        return { event: 'MaintenanceRenewed', dedicationId: d.id, year: Number(a.year), paymentRef: a.paymentRef };
      }
      default:
        return null;
    }
  }
}

export { PACKAGES, fromGps, ZERO32 };
