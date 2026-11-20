// Personal Legacy Garden: an on-chain registry of dedicated memorial trees.
//
// What lives here (on-chain): gardens, accredited stewards, planting batches,
// dedications (the subscriber's non-transferable certificate), trees with their
// planting, monitoring and replacement history, and payment references.
// What does not: names that were not consented for display, contact details,
// photos and agreements. Those stay in the Garden's private records and only
// a fingerprint (hash) is written here.
//
// Subscribers never need FDK: the Garden operator and its stewards sign every
// record and pay the network fee. Payments are in GBP off-chain (reference
// recorded here) or, optionally, in the settlement stablecoin on-chain.
// FDK is never a payment.
import { isAddress } from './crypto.js';

export const GARDEN_TX_TYPES = [
  'garden_register', 'garden_steward', 'dedication_create', 'planting_window_close',
  'tree_plant', 'tree_monitor', 'tree_replace', 'maintenance_renew',
];

export const PACKAGES = {
  standard: 'Standard tree',
  family: 'Family tree',
  memorial: 'Memorial tree',
  legacy: 'Legacy tree',
  corporate: 'Corporate grove tree',
};
export const PURPOSES = ['self', 'family', 'friendship', 'memorial', 'institutional', 'pet'];
const CROWN = ['good', 'fair', 'poor'];
const HEALTH = ['healthy', 'stressed', 'diseased', 'dead'];
const PAYMENT_METHODS = ['card', 'bank transfer'];
const DAY = 86_400_000;

// ---------------------------------------------------------------- helpers
function req(cond, msg) {
  if (!cond) throw new Error(msg);
}
function str(v, name, max = 200) {
  req(typeof v === 'string' && v.trim().length > 0 && v.length <= max, `${name} is required (max ${max} chars)`);
  return v.trim();
}
function opt(v, max = 300) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
function hash(v, name) {
  req(typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v), `${name} must be a 0x-prefixed 32-byte hex fingerprint`);
  return v;
}
function optHash(v, name) {
  return v === undefined || v === null || v === '' ? null : hash(v, name);
}
function int(v, name, min, max) {
  const n = Number(v);
  req(Number.isInteger(n) && n >= min && n <= max, `${name} must be a whole number from ${min} to ${max}`);
  return n;
}
function money(v, name) {
  req(v !== undefined && /^\d+$/.test(String(v)) && BigInt(v) > 0n, `${name} must be a positive integer in minor units`);
  return BigInt(v);
}
function dateStr(v, name, ctx) {
  req(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)), `${name} must be a date (YYYY-MM-DD)`);
  req(Date.parse(v) <= ctx.timestamp + DAY, `${name} cannot be in the future`);
  return v;
}
function gps(v) {
  req(v && typeof v === 'object', 'gps is required');
  const lat = String(v.lat), lon = String(v.lon);
  req(/^-?\d{1,2}\.\d{4,7}$/.test(lat) && Math.abs(Number(lat)) <= 90, 'gps.lat must be decimal degrees with 4-7 decimals');
  req(/^-?\d{1,3}\.\d{4,7}$/.test(lon) && Math.abs(Number(lon)) <= 180, 'gps.lon must be decimal degrees with 4-7 decimals');
  return { lat, lon };
}
const pad = (n, w = 6) => String(n).padStart(w, '0');

// Read-only view of the garden registry. The container is created only when a
// transaction actually writes to it, so a rejected transaction never changes
// state (and chains recorded before this module existed replay unchanged).
const EMPTY = Object.freeze({ gardens: {}, trees: {}, dedications: {}, batches: {}, paymentRefs: {}, counters: { dedications: 0 } });
export function gardenView(s) {
  return s.garden || EMPTY;
}
function ensure(s) {
  if (!s.garden) s.garden = { gardens: {}, trees: {}, dedications: {}, batches: {}, paymentRefs: {}, counters: { dedications: 0 } };
  return s.garden;
}

function gardenOf(s, id) {
  const g = gardenView(s).gardens[id];
  req(g, `unknown garden ${id}`);
  return g;
}
export function isSteward(g, a) {
  return a === g.operator || Boolean(g.stewards[a]?.active);
}
function requireSteward(g, a) {
  req(isSteward(g, a), 'only the Garden operator or an accredited steward can record this');
}
function newBatch(G, g, window, ctx, carriedFrom = null) {
  g.batchCount += 1;
  const id = `${g.id}-PB-${pad(g.batchCount, 2)}`;
  G.batches[id] = { id, gardenId: g.id, window, size: g.batchSize, status: 'open', dedications: [], openedAt: ctx.timestamp, carriedFrom, carriedTo: null, releasedAt: null, plantedAt: null };
  g.openBatch = id;
  return id;
}
function dedicationOf(s, id) {
  const d = gardenView(s).dedications[id];
  req(d, `unknown dedication ${id}`);
  return d;
}
function treeOf(s, id) {
  const t = gardenView(s).trees[id];
  req(t, `unknown tree ${id}`);
  return t;
}

// ------------------------------------------------------------ tx handlers
export const gardenHandlers = {
  // Governance approves a Garden and names its operator.
  garden_register(s, tx, a, ctx) {
    req(tx.from === s.admin, 'governance only');
    const p = tx.payload;
    const id = str(p.code, 'code', 8).toUpperCase();
    req(/^[A-Z]{2,6}$/.test(id), 'code must be 2-6 letters');
    req(!gardenView(s).gardens[id], 'garden code already registered');
    const operator = p.operator;
    req(isAddress(operator), 'operator must be a 0x address');
    const compartments = Array.isArray(p.compartments) ? p.compartments.map(String) : [];
    req(compartments.length >= 1 && compartments.length <= 26 && compartments.every((c) => /^[A-Z]$/.test(c)) && new Set(compartments).size === compartments.length, 'compartments must be distinct single letters');
    const garden = {
      id,
      name: str(p.name, 'name', 160),
      location: str(p.location, 'location', 160),
      country: str(p.country, 'country', 80),
      operator,
      operatorName: opt(p.operatorName, 120),
      capacity: int(p.capacity, 'capacity', 1, 100_000),
      batchSize: int(p.batchSize, 'batchSize', 1, 1000),
      compartments,
      centre: gps(p.centre),
      priceGBP: money(p.priceGBP, 'priceGBP'),
      maintenanceGBP: money(p.maintenanceGBP, 'maintenanceGBP'),
      stablePrice: p.stablePrice ? money(p.stablePrice, 'stablePrice') : 0n,
      replacementMonths: int(p.replacementMonths ?? 24, 'replacementMonths', 0, 120),
      lifespanYears: int(p.lifespanYears ?? 50, 'lifespanYears', 1, 200),
      agreementHash: optHash(p.agreementHash, 'agreementHash'),
      stewards: {},
      batchCount: 0,
      openBatch: null,
      registeredAt: ctx.timestamp,
      registerTx: tx.hash,
    };
    const window = str(p.window, 'window', 120);
    const G = ensure(s);
    G.gardens[id] = garden;
    const batchId = newBatch(G, garden, window, ctx);
    return [{ event: 'GardenRegistered', gardenId: id, operator, capacity: garden.capacity, batchSize: garden.batchSize, openBatch: batchId }];
  },

  // The operator accredits (or removes) field stewards.
  garden_steward(s, tx) {
    const p = tx.payload;
    const g = gardenOf(s, p.gardenId);
    req(tx.from === g.operator, 'only the Garden operator can manage stewards');
    req(isAddress(p.steward), 'steward must be a 0x address');
    const active = p.active !== false;
    const name = active ? str(p.name, 'name', 120) : g.stewards[p.steward]?.name || '';
    req(active || g.stewards[p.steward], 'unknown steward');
    g.stewards[p.steward] = { name, active };
    return [{ event: active ? 'StewardAccredited' : 'StewardRemoved', gardenId: g.id, steward: p.steward }];
  },

  // A paid subscription becomes a dedication held by the member's account.
  //  - Back office path (operator or steward signs): payment was taken in GBP
  //    by card or bank transfer; only its reference is recorded.
  //  - Self-service path (the member signs): pays the Garden's stablecoin price
  //    on-chain, straight to the operator.
  dedication_create(s, tx, a, ctx) {
    const p = tx.payload;
    const g = gardenOf(s, p.gardenId);
    const G0 = gardenView(s);
    const backOffice = isSteward(g, tx.from);
    const pkg = str(p.package, 'package', 20);
    req(PACKAGES[pkg], `package must be one of ${Object.keys(PACKAGES).join(', ')}`);
    const purpose = str(p.purpose, 'purpose', 20);
    req(PURPOSES.includes(purpose), `purpose must be one of ${PURPOSES.join(', ')}`);
    const publicName = p.publicName === true;
    let dedicatedTo = null, descriptor = null, nameHash = null;
    if (publicName) {
      dedicatedTo = str(p.dedicatedTo, 'dedicatedTo', 120);
      descriptor = opt(p.descriptor, 80);
    } else {
      req(p.dedicatedTo === undefined, 'do not put a name on-chain without consent: send nameHash instead');
      nameHash = hash(p.nameHash, 'nameHash');
    }
    const inscription = publicName ? opt(p.inscription, 200) : '';
    let holder, payment;
    if (backOffice) {
      holder = p.holder;
      req(isAddress(holder), 'holder must be the member account address');
      const pay = p.payment || {};
      const ref = str(pay.ref, 'payment.ref', 80);
      req(!G0.paymentRefs[ref], 'payment reference already recorded');
      req(PAYMENT_METHODS.includes(pay.method), `payment.method must be one of ${PAYMENT_METHODS.join(', ')}`);
      req(pay.currency === 'GBP', 'payment.currency must be GBP');
      payment = { ref, method: pay.method, currency: 'GBP', amount: money(pay.amount, 'payment.amount'), paidOn: pay.paidOn ? dateStr(pay.paidOn, 'payment.paidOn', ctx) : null };
    } else {
      req(g.stablePrice > 0n, 'this Garden does not accept stablecoin payments');
      req(a && a.stable >= g.stablePrice, `insufficient ${s.stable.symbol}: the dedication costs ${g.stablePrice} base units`);
      holder = tx.from;
      payment = { ref: tx.hash, method: 'stablecoin', currency: s.stable.symbol, amount: g.stablePrice, paidOn: new Date(ctx.timestamp).toISOString().slice(0, 10) };
    }
    const count = Object.keys(G0.dedications).filter((k) => G0.dedications[k].gardenId === g.id).length;
    req(count < g.capacity, 'the Garden is fully subscribed');
    const detailsHash = optHash(p.detailsHash, 'detailsHash');
    const agreementHash = optHash(p.agreementHash, 'agreementHash');
    const preferredSpecies = opt(p.preferredSpecies, 80);

    // all checks passed: write
    const G = ensure(s);
    if (!backOffice) {
      a.stable -= g.stablePrice;
      const op = s.accounts[g.operator] || (s.accounts[g.operator] = { fdk: 0n, stable: 0n, nonce: 0, credits: {} });
      op.stable += g.stablePrice;
    }
    G.counters.dedications += 1;
    const id = `DED-${pad(G.counters.dedications)}`;
    const batch = G.batches[g.openBatch];
    G.dedications[id] = {
      id, gardenId: g.id, holder, package: pkg, purpose, publicName, dedicatedTo, descriptor, nameHash, inscription,
      preferredSpecies, detailsHash, agreementHash, payment,
      batchId: batch.id, carryOvers: 0, treeId: null, status: 'awaiting batch',
      renewals: [], subscribedAt: ctx.timestamp, recordedBy: tx.from, tx: tx.hash, height: ctx.height,
    };
    G.paymentRefs[payment.ref] = id;
    batch.dedications.push(id);
    const events = [{ event: 'DedicationCreated', dedicationId: id, gardenId: g.id, holder, package: pkg, batchId: batch.id, paymentRef: payment.ref, method: payment.method }];
    if (batch.dedications.length >= batch.size) {
      batch.status = 'released';
      batch.releasedAt = ctx.timestamp;
      for (const d of batch.dedications) G.dedications[d].status = 'ready to plant';
      const next = newBatch(G, g, batch.window, ctx);
      events.push({ event: 'BatchReleased', batchId: batch.id, gardenId: g.id, trees: batch.dedications.length, nextBatch: next });
    }
    return events;
  },

  // End of a planting window. A batch that has not reached its size is not
  // planted: its paid subscriptions carry over to the next window.
  planting_window_close(s, tx, a, ctx) {
    const p = tx.payload;
    const g = gardenOf(s, p.gardenId);
    requireSteward(g, tx.from);
    const nextWindow = str(p.nextWindow, 'nextWindow', 120);
    const G = ensure(s);
    const batch = G.batches[g.openBatch];
    if (batch.dedications.length === 0) {
      const old = batch.window;
      batch.window = nextWindow;
      return [{ event: 'PlantingWindowClosed', gardenId: g.id, window: old, nextWindow, carriedOver: 0 }];
    }
    const old = batch.window;
    batch.status = 'carried over';
    batch.closedAt = ctx.timestamp;
    const nextId = newBatch(G, g, nextWindow, ctx, batch.id);
    batch.carriedTo = nextId;
    const next = G.batches[nextId];
    next.dedications = [...batch.dedications];
    for (const d of next.dedications) {
      G.dedications[d].batchId = nextId;
      G.dedications[d].carryOvers += 1;
    }
    return [{ event: 'PlantingWindowClosed', gardenId: g.id, window: old, nextWindow, carriedOver: next.dedications.length, from: batch.id, to: nextId }];
  },

  // A steward plants the dedicated tree and records where and when.
  tree_plant(s, tx, a, ctx) {
    const p = tx.payload;
    const d = dedicationOf(s, p.dedicationId);
    const g = gardenOf(s, d.gardenId);
    requireSteward(g, tx.from);
    const G0 = gardenView(s);
    req(!d.treeId, 'this dedication already has a tree');
    const batch = G0.batches[d.batchId];
    req(batch.status === 'released', `batch ${batch.id} has not been released for planting (${batch.dedications.length} of ${batch.size} paid)`);
    const treeId = str(p.treeId, 'treeId', 30).toUpperCase();
    const m = treeId.match(/^([A-Z]{2,6})-(\d{4})-([A-Z])-(\d{3})$/);
    req(m && m[1] === g.id, `treeId must look like ${g.id}-2027-A-001`);
    req(g.compartments.includes(m[3]), `compartment ${m[3]} does not exist in ${g.id}`);
    req(!G0.trees[treeId], 'tree ID already in use');
    const plantedOn = dateStr(p.plantedOn, 'plantedOn', ctx);
    req(plantedOn.slice(0, 4) === m[2], 'the year in the tree ID must match the planting year');
    const planting = {
      n: 1, plantedOn, gps: gps(p.gps), seedSource: str(p.seedSource, 'seedSource', 160), photoHash: hash(p.photoHash, 'photoHash'),
      steward: tx.from, tx: tx.hash, height: ctx.height, diedOn: null, cause: null,
    };
    const species = str(p.species, 'species', 80);
    const scientific = str(p.scientific, 'scientific', 120);

    const G = ensure(s);
    G.trees[treeId] = {
      id: treeId, gardenId: g.id, compartment: m[3], number: Number(m[4]), species, scientific,
      dedicationId: d.id, status: 'alive', plantings: [planting], monitoring: [], createdAt: ctx.timestamp,
    };
    const dd = G.dedications[d.id];
    dd.treeId = treeId;
    dd.status = 'planted';
    const b = G.batches[d.batchId];
    const events = [{ event: 'TreePlanted', treeId, dedicationId: d.id, gardenId: g.id, species, plantedOn }];
    if (b.dedications.every((x) => G.dedications[x].treeId)) {
      b.status = 'planted';
      b.plantedAt = ctx.timestamp;
      events.push({ event: 'BatchPlanted', batchId: b.id, trees: b.dedications.length });
    }
    return events;
  },

  // Periodic inspection: growth, condition and a fingerprint of the photo.
  tree_monitor(s, tx, a, ctx) {
    const p = tx.payload;
    const t = treeOf(s, p.treeId);
    const g = gardenOf(s, t.gardenId);
    requireSteward(g, tx.from);
    req(t.status === 'alive', 'this tree is recorded as dead: record a replacement first');
    const date = dateStr(p.date, 'date', ctx);
    const current = t.plantings[t.plantings.length - 1];
    req(date >= current.plantedOn, 'inspection date is before the planting date');
    const health = str(p.health, 'health', 20);
    req(HEALTH.includes(health), `health must be one of ${HEALTH.join(', ')}`);
    const entry = {
      date, planting: current.n,
      heightCm: int(p.heightCm, 'heightCm', 0, 10_000),
      stemMm: int(p.stemMm, 'stemMm', 0, 5_000),
      crown: health === 'dead' ? 'poor' : str(p.crown, 'crown', 10),
      health,
      photoHash: optHash(p.photoHash, 'photoHash'),
      note: opt(p.note, 300),
      cause: health === 'dead' ? str(p.cause, 'cause', 160) : null,
      steward: tx.from, tx: tx.hash, height: ctx.height,
    };
    req(CROWN.includes(entry.crown), `crown must be one of ${CROWN.join(', ')}`);

    const tt = ensure(s).trees[t.id];
    tt.monitoring.push(entry);
    if (health === 'dead') {
      tt.status = 'dead';
      const cur = tt.plantings[tt.plantings.length - 1];
      cur.diedOn = date;
      cur.cause = entry.cause;
      return [{ event: 'TreeDied', treeId: t.id, date, cause: entry.cause }];
    }
    return [{ event: 'TreeMonitored', treeId: t.id, date, heightCm: entry.heightCm, health }];
  },

  // A tree that died is replaced in the same position record: same Tree ID and
  // dedication, new planting date and GPS (subscribership terms, item 8).
  tree_replace(s, tx, a, ctx) {
    const p = tx.payload;
    const t = treeOf(s, p.treeId);
    const g = gardenOf(s, t.gardenId);
    requireSteward(g, tx.from);
    req(t.status === 'dead', 'only a tree recorded as dead can be replaced');
    const first = t.plantings[0];
    const last = t.plantings[t.plantings.length - 1];
    const plantedOn = dateStr(p.plantedOn, 'plantedOn', ctx);
    req(plantedOn >= last.diedOn, 'replacement cannot be planted before the tree died');
    const monthsSince = (Date.parse(last.diedOn) - Date.parse(first.plantedOn)) / (30.4375 * DAY);
    const underGuarantee = monthsSince <= g.replacementMonths;
    const coveredBy = underGuarantee ? `free replacement (${g.replacementMonths}-month guarantee)` : str(p.coveredBy, 'coveredBy (guarantee period has ended)', 120);
    const planting = {
      n: t.plantings.length + 1, plantedOn, gps: gps(p.gps), seedSource: str(p.seedSource, 'seedSource', 160), photoHash: hash(p.photoHash, 'photoHash'),
      steward: tx.from, tx: tx.hash, height: ctx.height, diedOn: null, cause: null, underGuarantee, coveredBy,
    };
    const species = p.species ? str(p.species, 'species', 80) : null;
    const scientific = p.scientific ? str(p.scientific, 'scientific', 120) : null;

    const tt = ensure(s).trees[t.id];
    tt.plantings.push(planting);
    tt.status = 'alive';
    if (species) tt.species = species;
    if (scientific) tt.scientific = scientific;
    return [{ event: 'TreeReplaced', treeId: t.id, planting: planting.n, plantedOn, underGuarantee }];
  },

  // £25 a year keeps routine monitoring and the annual update going.
  maintenance_renew(s, tx, a, ctx) {
    const p = tx.payload;
    const d = dedicationOf(s, p.dedicationId);
    const g = gardenOf(s, d.gardenId);
    requireSteward(g, tx.from);
    const year = int(p.year, 'year', 2000, 2200);
    req(!d.renewals.find((r) => r.year === year), `maintenance for ${year} is already recorded`);
    const ref = str(p.paymentRef, 'paymentRef', 80);
    req(!gardenView(s).paymentRefs[ref], 'payment reference already recorded');
    const G = ensure(s);
    G.dedications[d.id].renewals.push({ year, ref, amount: g.maintenanceGBP, currency: 'GBP', at: ctx.timestamp, tx: tx.hash });
    G.paymentRefs[ref] = d.id;
    return [{ event: 'MaintenanceRenewed', dedicationId: d.id, year, paymentRef: ref }];
  },
};

// ------------------------------------------------------------------ views
export function maintenanceStatus(d, now = Date.now()) {
  const year = new Date(now).getUTCFullYear();
  const firstYear = d.payment.paidOn ? Number(d.payment.paidOn.slice(0, 4)) : new Date(d.subscribedAt).getUTCFullYear();
  const paid = d.renewals.map((r) => r.year);
  if (year === firstYear || paid.includes(year)) return { active: true, label: year === firstYear && !paid.includes(year) ? `Included for ${year}` : `Paid for ${year}`, year };
  return { active: false, label: `Due for ${year}`, year };
}

export function gardenStats(s, gardenId) {
  const G = gardenView(s);
  const ded = Object.values(G.dedications).filter((d) => d.gardenId === gardenId);
  const trees = Object.values(G.trees).filter((t) => t.gardenId === gardenId);
  const alive = trees.filter((t) => t.status === 'alive').length;
  const everPlanted = trees.reduce((n, t) => n + t.plantings.length, 0);
  const died = trees.reduce((n, t) => n + t.plantings.filter((p) => p.diedOn).length, 0);
  const replaced = trees.reduce((n, t) => n + t.plantings.length - 1, 0);
  const species = {};
  for (const t of trees) species[t.species] = (species[t.species] || 0) + 1;
  const withGps = trees.filter((t) => t.plantings.every((p) => p.gps)).length;
  return {
    subscriptions: ded.length,
    planted: trees.length,
    alive,
    dead: trees.length - alive,
    plantingsTotal: everPlanted,
    died,
    replaced,
    survivalPct: everPlanted ? Math.round(((everPlanted - died) / everPlanted) * 1000) / 10 : null,
    gpsPct: trees.length ? Math.round((withGps / trees.length) * 100) : null,
    speciesCount: Object.keys(species).length,
    species,
    awaiting: ded.filter((d) => !d.treeId).length,
  };
}
