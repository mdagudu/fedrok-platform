// Indexer: projects the EVM chain into the read model the API and web app use.
//
// The source of truth is the EVM state and the contract event logs. After
// each block the indexer decodes the logs of the Fedrok system contracts
// (plus the decoded calldata of the transaction that emitted them) and keeps
// an in-memory view: accounts with FDK / fUSD / credit balances, credit
// batches, listings, retirements, miners, generators and the Legacy Garden.
// Small singletons (parameters, roles, Proof of Green state) are re-read from
// the contracts with view calls. Like an explorer database, this view can be
// rebuilt at any time by replaying the chain.
import { ADDRESSES, BY_ADDRESS, IFACE } from './contracts.js';
import { ids, fromDay, fromGps, PACKAGES } from './actions.js';
import { viewCall, addrOf } from './vm.js';

const SYSTEM_CONTRACTS = new Set(Object.values(ADDRESSES));
const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO32 = '0x' + '0'.repeat(64);
const lc = (a) => (typeof a === 'string' ? a.toLowerCase() : a);
const isUser = (a) => a && a !== ZERO && !SYSTEM_CONTRACTS.has(a);
const minerId = (b4) => (b4 && b4 !== '0x00000000' ? ids.miner(b4) : null);
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
    fallbackValidator: genesis.fallbackValidator,
    btcDifficulty: genesis.btc.difficulty,
    contracts: ADDRESSES,
    accounts: {},
    auditors: {},
    miners: {},
    btcToMiner: {},
    generators: {},
    batches: {},
    retirements: {},
    listings: {},
    backingVault: {},
    piggyBank: 0n,
    yearlyEmission: 0n,
    fdkCap: BigInt(genesis.fdkCap),
    pog: { anchorHeight: genesis.btc.anchorHeight, anchorHash: genesis.btc.anchorHash, activeMiner: null, lastGreenBtcHeight: -1, greenBlocksSeen: 0 },
    supply: {
      fdkMinted: 0n, fdkBurned: 0n, fdkRewards: 0n, fdkFees: 0n,
      stableMinted: 0n, stableBurned: 0n,
      creditsIssued: 0n, creditsRetired: 0n, creditsBacking: 0n,
    },
    counters: { batches: 0, listings: 0, retirements: 0, txs: 0 },
    garden: { gardens: {}, trees: {}, dedications: {}, batches: {}, paymentRefs: {}, counters: { dedications: 0 }, keys: {}, batchIds: {}, treeKeys: {} },
  };
}

export function account(s, a) {
  if (!s.accounts[a]) s.accounts[a] = { fdk: 0n, stable: 0n, nonce: 0, credits: {}, allowances: {} };
  return s.accounts[a];
}
export function peekAccount(s, a) {
  return s.accounts[a] || { fdk: 0n, stable: 0n, nonce: 0, credits: {}, allowances: {} };
}

function minerView(m, prev = {}) {
  return {
    id: ids.miner(m.id), name: m.name, btcAddress: m.btcAddress, owner: lc(m.owner), units: Number(m.units), auditor: lc(m.auditor),
    site: m.site, energy: m.energy, reportRef: m.reportRef,
    accreditedAt: Number(m.accreditedAt) * 1000, expiresAt: Number(m.expiresAt) * 1000,
    active: m.active, yearlyReward: m.yearlyReward, prefill: m.prefill,
    publicGenerators: m.publicGenerators, generatorShareBps: Number(m.generatorShareBps),
    generators: m.generators.map(lc), approved: prev.approved || [],
    greenBlocks: Number(m.greenBlocks), rewardsEarned: m.rewardsEarned,
    ...(m.revokedReason ? { revokedReason: m.revokedReason } : {}),
  };
}

export class Indexer {
  constructor(genesis, genesisHash) {
    this.genesis = genesis;
    this.state = createProjection(genesis, genesisHash);
  }

  /** Read singletons, miners and generators from the contracts, and every known balance. */
  async refresh(vm, block, { all = false, full = all, touched = new Set() } = {}) {
    const s = this.state;
    const v = (c, fn, args) => viewCall(vm, block, c, fn, args);
    const pg = await v('ProofOfGreen', 'state');
    s.pog = { anchorHeight: Number(pg.anchorHeight), anchorHash: pg.anchorHash, activeMiner: minerId(pg.activeMiner), lastGreenBtcHeight: Number(pg.lastGreenBtcHeight), greenBlocksSeen: Number(pg.greenBlocksSeen) };
    s.piggyBank = pg.piggyBank;
    s.yearlyEmission = pg.yearlyEmission;
    s.supply.fdkRewards = pg.totalRewards;
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
    s.params = {
      blockTimeMs: Number(p.blockTimeMs), minGasPrice: p.minGasPrice, minGeneratorStake: p.minGeneratorStake, fdkPerUnitYear: p.fdkPerUnitYear,
      greenWindow: Number(p.greenWindow), maxGeneratorsPerMiner: Number(p.maxGeneratorsPerMiner), marketFeeBps: Number(p.marketFeeBps), maxTxPerBlock: Number(p.maxTxPerBlock),
    };
    s.admin = lc(await v('FedrokGovernance', 'admin'));
    s.stableIssuer = lc(await v('FedrokGovernance', 'stableIssuer'));
    s.fallbackValidator = lc(await v('FedrokGovernance', 'fallbackValidator'));
    const nm = Number(await v('ProofOfGreen', 'minerCount'));
    for (let i = 0; i < nm; i++) {
      const m = await v('ProofOfGreen', 'miner', [await v('ProofOfGreen', 'minerIds', [i])]);
      const id = ids.miner(m.id);
      s.miners[id] = minerView(m, s.miners[id]);
      s.btcToMiner[m.btcAddress] = id;
    }
    const known = new Set(Object.keys(s.generators));
    const ng = Number(await v('ProofOfGreen', 'generatorCount'));
    const live = new Set();
    for (let i = 0; i < ng; i++) {
      const a = lc(await v('ProofOfGreen', 'generatorList', [i]));
      const g = await v('ProofOfGreen', 'generator', [a]);
      live.add(a);
      s.generators[a] = { address: a, stake: g.stake, links: g.links.map(ids.miner), registeredAt: Number(g.registeredAt) * 1000, blocks: Number(g.blocks), name: g.name };
    }
    for (const a of known) if (!live.has(a)) delete s.generators[a];
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
    for (const a of this.genesis.auditors || []) s.auditors[lc(a.address)] = { name: a.name, addedAt: this.genesis.timestamp, active: true };
    await this.refresh(vm, block, { all: true });
  }

  /**
   * Apply one executed block. `results[i]` = { status, logs, gasUsed, fee, error } for block.txs[i];
   * `systemLogs` are the logs of the Proof of Green system call.
   * Returns the decoded Fedrok events for every transaction.
   */
  async applyBlock(vm, ctxBlock, block, results, systemLogs) {
    const s = this.state;
    const h = block.header;
    const touched = new Set([h.generator]);
    let structural = false;
    const ctx = { ts: h.timestamp, height: h.height, touched };
    for (const log of systemLogs) {
      const d = this._decode(log);
      if (d && d.contract === 'ProofOfGreen') {
        if (d.name === 'MinerExpired') structural = true;
        if (d.name === 'GreenBitcoinBlock' && s.miners[ids.miner(d.args.minerId)]) s.miners[ids.miner(d.args.minerId)].greenBlocks += 1;
        if (d.name === 'BlockProduced') {
          if (s.generators[d.args.generator]) s.generators[d.args.generator].blocks += 1;
          const m = d.args.green && s.miners[ids.miner(d.args.minerId)];
          if (m) {
            m.rewardsEarned += d.args.minerReward;
            touched.add(m.owner);
          }
        }
      }
    }
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
          if (d.contract === 'ProofOfGreen' || d.contract === 'FedrokGovernance') structural = true;
          const ev = this._apply(d, tx, ctx);
          if (ev) events.push(...(Array.isArray(ev) ? ev : [ev]));
        }
      }
      txEvents.push(events);
    });
    s.height = h.height;
    s.tipHash = block.hash;
    s.lastTimestamp = h.timestamp;
    // Proof of Green state changes every block (anchor, rewards); the rest only when touched.
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
      case 'FedrokGovernance.AuditorAdded':
        s.auditors[a.auditor] = { name: a.name, addedAt: ts, active: true };
        return { event: 'AuditorAdded', auditor: a.auditor };
      case 'FedrokGovernance.AuditorRemoved':
        if (s.auditors[a.auditor]) s.auditors[a.auditor].active = false;
        return { event: 'AuditorRemoved', auditor: a.auditor };
      case 'FedrokGovernance.FallbackValidatorSet':
        return { event: 'FallbackValidatorSet', validator: a.validator };
      case 'FedrokGovernance.StableIssuerSet':
        return { event: 'StableIssuerSet', issuer: a.issuer };
      case 'FedrokGovernance.ParamSet':
        return { event: 'ParamSet', key: a.key, value: a.value.toString() };
      // ---------------------------------------------------------- carbon registry
      case 'CarbonRegistry.TransferSingle': {
        const id = ids.batch(a.id);
        if (isUser(a.from)) {
          const acct = account(s, a.from);
          acct.credits[id] = (acct.credits[id] || 0n) - a.value;
          if (acct.credits[id] <= 0n) delete acct.credits[id];
        }
        if (isUser(a.to)) {
          const acct = account(s, a.to);
          acct.credits[id] = (acct.credits[id] || 0n) + a.value;
        }
        return tx.type === 'credit_transfer' ? { event: 'CreditsTransferred', batchId: id, from: a.from, to: a.to, quantityKg: a.value } : null;
      }
      case 'CarbonRegistry.CreditsIssued': {
        const id = ids.batch(a.batchId);
        s.counters.batches = Number(a.batchId);
        s.batches[id] = {
          id, project: P.project, country: P.country, registry: P.registry, methodology: P.methodology, projectType: P.projectType, vintage: P.vintage, serial: P.serial, description: P.description || '',
          auditor: a.auditor, issuedKg: a.quantityKg, retiredKg: 0n, backingKg: 0n, issuedAt: ts, issueTx: tx.hash, height,
        };
        s.supply.creditsIssued += a.quantityKg;
        return { event: 'CreditsIssued', batchId: id, to: a.to, quantityKg: a.quantityKg };
      }
      case 'CarbonRegistry.CreditsRetired': {
        const id = ids.retirement(a.retirementId);
        const batchId = ids.batch(a.batchId);
        if (s.batches[batchId]) s.batches[batchId].retiredKg += a.quantityKg;
        s.supply.creditsRetired += a.quantityKg;
        s.counters.retirements = Number(a.retirementId);
        s.retirements[id] = { id, batchId, quantityKg: a.quantityKg, beneficiary: a.beneficiary, reason: a.reason, retiredBy: a.retiredBy, timestamp: ts, tx: tx.hash, height };
        return { event: 'CreditsRetired', retirementId: id, batchId, quantityKg: a.quantityKg, beneficiary: a.beneficiary };
      }
      case 'CarbonRegistry.FdkBackMinted': {
        const batchId = ids.batch(a.batchId);
        s.backingVault[batchId] = (s.backingVault[batchId] || 0n) + a.quantityKg;
        if (s.batches[batchId]) s.batches[batchId].backingKg += a.quantityKg;
        s.supply.creditsBacking += a.quantityKg;
        return { event: 'FdkBackMinted', batchId, quantityKg: a.quantityKg, to: a.to, amount: a.amount };
      }
      // ---------------------------------------------------------- marketplace
      case 'CarbonMarketplace.Listed': {
        const id = ids.listing(a.listingId);
        s.counters.listings = Number(a.listingId);
        s.listings[id] = { id, seller: a.seller, batchId: ids.batch(a.batchId), remainingKg: a.quantityKg, listedKg: a.quantityKg, pricePerTonne: a.pricePerTonne, status: 'open', createdAt: ts, height };
        return { event: 'Listed', listingId: id, batchId: ids.batch(a.batchId), quantityKg: a.quantityKg, pricePerTonne: a.pricePerTonne };
      }
      case 'CarbonMarketplace.Purchased': {
        const l = s.listings[ids.listing(a.listingId)];
        if (l) {
          l.remainingKg -= a.quantityKg;
          if (l.remainingKg === 0n) l.status = 'filled';
        }
        return { event: 'Purchased', listingId: ids.listing(a.listingId), buyer: a.buyer, seller: a.seller, batchId: ids.batch(a.batchId), quantityKg: a.quantityKg, paid: a.paid, platformFee: a.platformFee, currency: sym };
      }
      case 'CarbonMarketplace.ListingCancelled': {
        const l = s.listings[ids.listing(a.listingId)];
        if (l) l.status = 'cancelled';
        return { event: 'ListingCancelled', listingId: ids.listing(a.listingId), returnedKg: a.returnedKg };
      }
      // ---------------------------------------------------------- Proof of Green
      case 'ProofOfGreen.MinerAccredited':
        return { event: 'MinerAccredited', minerId: ids.miner(a.minerId), btcAddress: a.btcAddress, owner: a.owner, units: Number(a.units), piggyBankPrefill: a.piggyBankPrefill };
      case 'ProofOfGreen.MinerRevoked':
        return { event: 'MinerRevoked', minerId: ids.miner(a.minerId), unservedBurned: a.unservedBurned };
      case 'ProofOfGreen.MinerUpdated':
        return { event: 'MinerUpdated', minerId: ids.miner(a.minerId) };
      case 'ProofOfGreen.GeneratorRegistered':
        return { event: 'GeneratorRegistered', generator: a.generator, stake: a.stake };
      case 'ProofOfGreen.GeneratorApproved': {
        const m = s.miners[ids.miner(a.minerId)];
        if (m && !m.approved.includes(a.generator)) m.approved.push(a.generator);
        return { event: 'GeneratorApproved', minerId: ids.miner(a.minerId), generator: a.generator };
      }
      case 'ProofOfGreen.GeneratorLinked':
        return { event: 'GeneratorLinked', minerId: ids.miner(a.minerId), generator: a.generator };
      case 'ProofOfGreen.GeneratorUnlinked':
        return { event: 'GeneratorUnlinked', minerId: ids.miner(a.minerId), generator: a.generator };
      case 'ProofOfGreen.GeneratorExited':
        return { event: 'GeneratorExited', generator: a.generator, returnedStake: a.returnedStake };
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
