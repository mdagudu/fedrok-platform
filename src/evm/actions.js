// Fedrok actions <-> EVM contract calls.
//
// The wallet, SDK and demo scenarios describe what a user wants to do as a
// Fedrok action ({ type, payload }, e.g. market_buy). This module turns an
// action into an ordinary Ethereum transaction to one of the system contracts
// (to, data, value), and turns a mined transaction back into the action for
// the explorer. Anything else (MetaMask transfers, custom contracts) shows up
// as a generic EVM call.
import { ADDRESSES, BY_ADDRESS, IFACE } from './contracts.js';

export const PACKAGES = ['standard', 'family', 'memorial', 'legacy', 'corporate'];
export const PURPOSES = ['self', 'family', 'friendship', 'memorial', 'institutional', 'pet'];
export const CROWN = ['good', 'fair', 'poor'];
export const HEALTH = ['healthy', 'stressed', 'diseased', 'dead'];
export const PAYMENT_METHODS = ['card', 'bank transfer', 'stablecoin'];
const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO32 = '0x' + '0'.repeat(64);
const DAY = 86_400_000;

// ------------------------------------------------------------- id formats
const pad = (n, w = 6) => String(n).padStart(w, '0');
export const ids = {
  batch: (n) => `CCB-${pad(n)}`,
  listing: (n) => `LST-${pad(n)}`,
  retirement: (n) => `RET-${pad(n)}`,
  dedication: (n) => `DED-${pad(n)}`,
  miner: (b4) => 'MNR-' + b4.slice(2, 10).toUpperCase(),
  gardenBatch: (code, n) => `${code}-PB-${pad(n, 2)}`,
};
function num(id, prefix, name) {
  const s = String(id ?? '');
  const m = s.match(new RegExp(`^${prefix}-(\\d+)$`));
  if (m) return BigInt(m[1]);
  if (/^\d+$/.test(s)) return BigInt(s);
  throw new Error(`${name} must look like ${prefix}-000001`);
}
const minerKey = (id) => {
  const m = String(id || '').match(/^MNR-([0-9A-F]{8})$/i);
  if (!m) throw new Error('minerId must look like MNR-1A2B3C4D');
  return '0x' + m[1].toLowerCase();
};

// ------------------------------------------------------------- converters
const req = (c, m) => {
  if (!c) throw new Error(m);
};
const big = (v, name) => {
  req(v !== undefined && v !== null && /^\d+$/.test(String(v)), `${name} must be a non-negative integer string`);
  return BigInt(v);
};
const str = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v));
const addr = (v, name) => {
  req(typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v), `${name} must be a 0x address`);
  return v.toLowerCase();
};
const optAddr = (v, name) => (v ? addr(v, name) : ZERO);
const hash32 = (v, name) => {
  if (v === undefined || v === null || v === '') return ZERO32;
  req(typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v), `${name} must be a 0x-prefixed 32-byte hex fingerprint`);
  return v;
};
const enumIdx = (list, v, name) => {
  const i = list.indexOf(v);
  req(i >= 0, `${name} must be one of ${list.join(', ')}`);
  return i;
};
export const toDay = (s, name) => {
  req(typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)), `${name} must be a date (YYYY-MM-DD)`);
  return Math.floor(Date.parse(s) / DAY);
};
export const fromDay = (d) => (Number(d) ? new Date(Number(d) * DAY).toISOString().slice(0, 10) : null);
const toGps = (g, name = 'gps') => {
  req(g && typeof g === 'object', `${name} is required`);
  const lat = String(g.lat), lon = String(g.lon);
  req(/^-?\d{1,2}\.\d{4,7}$/.test(lat) && Math.abs(Number(lat)) <= 90, `${name}.lat must be decimal degrees with 4-7 decimals`);
  req(/^-?\d{1,3}\.\d{4,7}$/.test(lon) && Math.abs(Number(lon)) <= 180, `${name}.lon must be decimal degrees with 4-7 decimals`);
  return [Math.round(Number(lat) * 1e7), Math.round(Number(lon) * 1e7)];
};
export const fromGps = (lat, lon) => ({ lat: (Number(lat) / 1e7).toFixed(6), lon: (Number(lon) / 1e7).toFixed(6) });
const n = (v) => Number(v);
const s = (v) => v.toString();

// ------------------------------------------------------------- the action table
// encode(payload, ctx) -> [args, value]; decode(args, tx) -> payload
const A = {
  transfer: {
    // FDK is the native gas token: a plain value transfer. fUSD is ERC-20.
    build(p) {
      const to = addr(p.to, 'to');
      const amount = big(p.amount, 'amount');
      req(amount > 0n, 'amount must be greater than zero');
      if (p.asset === 'FDK') return { to, data: '0x', value: amount };
      req(p.asset === 'STABLE', 'asset must be FDK or STABLE');
      return call('FUSD', 'transfer', [to, amount]);
    },
  },
  fdk_burn: { c: 'FDKIssuer', fn: 'burn', enc: (p) => [[str(p.reason) || 'utility consumption'], big(p.amount, 'amount')], dec: (a, tx) => ({ amount: s(tx.value), reason: a[0] }) },
  stable_mint: { c: 'FUSD', fn: 'mint', enc: (p) => [[addr(p.to, 'to'), big(p.amount, 'amount'), str(p.reserveRef)]], dec: (a) => ({ to: a[0].toLowerCase(), amount: s(a[1]), reserveRef: a[2] }) },
  stable_burn: { c: 'FUSD', fn: 'redeem', enc: (p) => [[big(p.amount, 'amount'), str(p.redemptionRef)]], dec: (a) => ({ amount: s(a[0]), redemptionRef: a[1] }) },
  stable_approve: { c: 'FUSD', fn: 'approve', enc: (p) => [[addr(p.spender, 'spender'), big(p.amount, 'amount')]], dec: (a) => ({ spender: a[0].toLowerCase(), spenderName: BY_ADDRESS[a[0].toLowerCase()] || null, amount: s(a[1]) }) },
  credit_issue: {
    c: 'CarbonRegistry', fn: 'issue',
    enc: (p) => [[optAddr(p.to, 'to'), big(p.quantityKg, 'quantityKg'), [str(p.project), str(p.country), str(p.registry), str(p.methodology), str(p.projectType) || 'Other', n(p.vintage) || 0, str(p.serial), str(p.description).slice(0, 1000)]]],
    dec: (a, tx) => ({ to: a[0] === ZERO ? tx.from : a[0].toLowerCase(), quantityKg: s(a[1]), project: a[2][0], country: a[2][1], registry: a[2][2], methodology: a[2][3], projectType: a[2][4], vintage: n(a[2][5]), serial: a[2][6], description: a[2][7] }),
  },
  credit_transfer: {
    c: 'CarbonRegistry', fn: 'safeTransferFrom',
    enc: (p, ctx) => [[ctx.from, addr(p.to, 'to'), num(p.batchId, 'CCB', 'batchId'), big(p.quantityKg, 'quantityKg'), '0x']],
    dec: (a) => ({ batchId: ids.batch(a[2]), to: a[1].toLowerCase(), quantityKg: s(a[3]) }),
  },
  credit_retire: {
    c: 'CarbonRegistry', fn: 'retire',
    enc: (p) => [[num(p.batchId, 'CCB', 'batchId'), big(p.quantityKg, 'quantityKg'), str(p.beneficiary), str(p.reason) || 'Voluntary offset']],
    dec: (a) => ({ batchId: ids.batch(a[0]), quantityKg: s(a[1]), beneficiary: a[2], reason: a[3] }),
  },
  fdk_back_mint: {
    c: 'CarbonRegistry', fn: 'backMint',
    enc: (p) => [[num(p.batchId, 'CCB', 'batchId'), big(p.quantityKg, 'quantityKg'), optAddr(p.to, 'to')]],
    dec: (a, tx) => ({ batchId: ids.batch(a[0]), quantityKg: s(a[1]), to: a[2] === ZERO ? tx.from : a[2].toLowerCase() }),
  },
  market_list: {
    c: 'CarbonMarketplace', fn: 'list',
    enc: (p) => [[num(p.batchId, 'CCB', 'batchId'), big(p.quantityKg, 'quantityKg'), big(p.pricePerTonne, 'pricePerTonne')]],
    dec: (a) => ({ batchId: ids.batch(a[0]), quantityKg: s(a[1]), pricePerTonne: s(a[2]) }),
  },
  market_buy: {
    c: 'CarbonMarketplace', fn: 'buy', spends: 'CarbonMarketplace',
    enc: (p) => [[num(p.listingId, 'LST', 'listingId'), big(p.quantityKg, 'quantityKg'), p.maxPricePerTonne === undefined ? 0n : big(p.maxPricePerTonne, 'maxPricePerTonne')]],
    dec: (a) => ({ listingId: ids.listing(a[0]), quantityKg: s(a[1]), ...(a[2] ? { maxPricePerTonne: s(a[2]) } : {}) }),
  },
  market_cancel: { c: 'CarbonMarketplace', fn: 'cancel', enc: (p) => [[num(p.listingId, 'LST', 'listingId')]], dec: (a) => ({ listingId: ids.listing(a[0]) }) },
  miner_accredit: {
    c: 'ProofOfGreen', fn: 'accredit',
    enc(p) {
      const pub = String(p.btcPubKey || '');
      req(/^0x04[0-9a-f]{128}$/.test(pub), 'btcPubKey must be an uncompressed 0x04… secp256k1 key');
      const sig = String(p.btcSig || '');
      req(/^0x[0-9a-f]{130}$/.test(sig), 'btcSig must be a 65-byte recoverable signature (r, s, v)');
      const v = parseInt(sig.slice(130, 132), 16);
      return [[[addr(p.owner, 'owner'), '0x' + pub.slice(4), '0x' + sig.slice(2, 66), '0x' + sig.slice(66, 130), v < 27 ? v + 27 : v, n(p.units), n(p.auditDays ?? 365), n(p.generatorShareBps ?? 1000), Boolean(p.publicGenerators), str(p.name), str(p.site), str(p.energy), str(p.reportRef)]]];
    },
    dec: (a) => {
      const x = a[0];
      return { owner: x[0].toLowerCase(), btcPubKey: '0x04' + x[1].slice(2), units: n(x[5]), auditDays: n(x[6]), generatorShareBps: n(x[7]), publicGenerators: x[8], name: x[9], site: x[10], energy: x[11], reportRef: x[12] };
    },
  },
  miner_revoke: { c: 'ProofOfGreen', fn: 'revoke', enc: (p) => [[minerKey(p.minerId), str(p.reason) || 'revoked']], dec: (a) => ({ minerId: ids.miner(a[0]), reason: a[1] }) },
  miner_update: {
    c: 'ProofOfGreen', fn: 'updateMiner',
    enc: (p) => [[minerKey(p.minerId), p.publicGenerators !== undefined, Boolean(p.publicGenerators), p.generatorShareBps !== undefined, n(p.generatorShareBps ?? 0)]],
    dec: (a) => ({ minerId: ids.miner(a[0]), ...(a[1] ? { publicGenerators: a[2] } : {}), ...(a[3] ? { generatorShareBps: n(a[4]) } : {}) }),
  },
  generator_register: { c: 'ProofOfGreen', fn: 'registerGenerator', enc: (p) => [[str(p.name).slice(0, 80)], big(p.stake, 'stake')], dec: (a, tx) => ({ stake: s(tx.value), name: a[0] }) },
  generator_approve: { c: 'ProofOfGreen', fn: 'approveGenerator', enc: (p) => [[minerKey(p.minerId), addr(p.generator, 'generator')]], dec: (a) => ({ minerId: ids.miner(a[0]), generator: a[1].toLowerCase() }) },
  generator_link: { c: 'ProofOfGreen', fn: 'link', enc: (p) => [[minerKey(p.minerId)]], dec: (a) => ({ minerId: ids.miner(a[0]) }) },
  generator_unlink: { c: 'ProofOfGreen', fn: 'unlink', enc: (p) => [[minerKey(p.minerId)]], dec: (a) => ({ minerId: ids.miner(a[0]) }) },
  generator_exit: { c: 'ProofOfGreen', fn: 'exitGenerator', enc: () => [[]], dec: () => ({}) },
  gov_add_auditor: { c: 'FedrokGovernance', fn: 'addAuditor', enc: (p) => [[addr(p.auditor, 'auditor'), str(p.name)]], dec: (a) => ({ auditor: a[0].toLowerCase(), name: a[1] }) },
  gov_remove_auditor: { c: 'FedrokGovernance', fn: 'removeAuditor', enc: (p) => [[addr(p.auditor, 'auditor')]], dec: (a) => ({ auditor: a[0].toLowerCase() }) },
  gov_set_fallback: { c: 'FedrokGovernance', fn: 'setFallbackValidator', enc: (p) => [[addr(p.validator, 'validator')]], dec: (a) => ({ validator: a[0].toLowerCase() }) },
  gov_set_stable_issuer: { c: 'FedrokGovernance', fn: 'setStableIssuer', enc: (p) => [[addr(p.issuer, 'issuer')]], dec: (a) => ({ issuer: a[0].toLowerCase() }) },
  gov_set_param: { c: 'FedrokGovernance', fn: 'setParam', enc: (p) => [[String(p.key), big(p.value, 'value')]], dec: (a) => ({ key: a[0], value: s(a[1]) }) },
  garden_register: {
    c: 'LegacyGarden', fn: 'registerGarden',
    enc(p) {
      const [clat, clon] = toGps(p.centre, 'centre');
      const comps = Array.isArray(p.compartments) ? p.compartments.map(String).join('') : String(p.compartments || '');
      return [[[str(p.code).toUpperCase(), str(p.name), str(p.location), str(p.country), addr(p.operator, 'operator'), str(p.operatorName), n(p.capacity), n(p.batchSize), comps, clat, clon, big(p.priceGBP, 'priceGBP'), big(p.maintenanceGBP, 'maintenanceGBP'), p.stablePrice ? big(p.stablePrice, 'stablePrice') : 0n, n(p.replacementMonths ?? 24), n(p.lifespanYears ?? 50), hash32(p.agreementHash, 'agreementHash'), str(p.window)]]];
    },
    dec: (a) => {
      const x = a[0];
      return { code: x[0], name: x[1], location: x[2], country: x[3], operator: x[4].toLowerCase(), operatorName: x[5], capacity: n(x[6]), batchSize: n(x[7]), compartments: x[8].split(''), centre: fromGps(x[9], x[10]), priceGBP: s(x[11]), maintenanceGBP: s(x[12]), stablePrice: s(x[13]), replacementMonths: n(x[14]), lifespanYears: n(x[15]), agreementHash: x[16] === ZERO32 ? null : x[16], window: x[17] };
    },
  },
  garden_steward: {
    c: 'LegacyGarden', fn: 'setSteward',
    enc: (p) => [[str(p.gardenId), addr(p.steward, 'steward'), str(p.name), p.active !== false]],
    dec: (a) => ({ gardenId: a[0], steward: a[1].toLowerCase(), name: a[2], active: a[3] }),
  },
  dedication_create: {
    c: 'LegacyGarden', fn: 'createDedication',
    spends: (p) => (p.payment ? null : 'LegacyGarden'),
    enc(p) {
      const pub = p.publicName === true;
      if (!pub) req(p.dedicatedTo === undefined, 'do not put a name on-chain without consent: send nameHash instead');
      const pay = p.payment || {};
      if (p.payment) req(pay.currency === 'GBP', 'payment.currency must be GBP');
      return [[[str(p.gardenId), p.holder ? addr(p.holder, 'holder') : ZERO, enumIdx(PACKAGES, p.package, 'package'), enumIdx(PURPOSES, p.purpose, 'purpose'), pub,
        pub ? str(p.dedicatedTo) : '', pub ? str(p.descriptor).slice(0, 80) : '', pub ? ZERO32 : hash32(p.nameHash, 'nameHash'), pub ? str(p.inscription).slice(0, 200) : '',
        str(p.preferredSpecies).slice(0, 80), hash32(p.detailsHash, 'detailsHash'), hash32(p.agreementHash, 'agreementHash'),
        str(pay.ref), p.payment ? enumIdx(PAYMENT_METHODS.slice(0, 2), pay.method, 'payment.method') : 0, p.payment ? big(pay.amount, 'payment.amount') : 0n, pay.paidOn ? toDay(pay.paidOn, 'payment.paidOn') : 0]]];
    },
    dec: (a) => {
      const x = a[0];
      return {
        gardenId: x[0], ...(x[1] !== ZERO ? { holder: x[1].toLowerCase() } : {}), package: PACKAGES[n(x[2])], purpose: PURPOSES[n(x[3])], publicName: x[4],
        ...(x[4] ? { dedicatedTo: x[5], descriptor: x[6], inscription: x[8] } : { nameHash: x[7] }),
        preferredSpecies: x[9], detailsHash: x[10] === ZERO32 ? null : x[10], agreementHash: x[11] === ZERO32 ? null : x[11],
        ...(x[12] ? { payment: { ref: x[12], method: PAYMENT_METHODS[n(x[13])], currency: 'GBP', amount: s(x[14]), paidOn: fromDay(x[15]) } } : {}),
      };
    },
  },
  planting_window_close: { c: 'LegacyGarden', fn: 'closePlantingWindow', enc: (p) => [[str(p.gardenId), str(p.nextWindow)]], dec: (a) => ({ gardenId: a[0], nextWindow: a[1] }) },
  tree_plant: {
    c: 'LegacyGarden', fn: 'plantTree',
    enc(p) {
      const [lat, lon] = toGps(p.gps);
      return [[[num(p.dedicationId, 'DED', 'dedicationId'), str(p.treeId).toUpperCase(), str(p.species), str(p.scientific), lat, lon, toDay(p.plantedOn, 'plantedOn'), str(p.seedSource), hash32(p.photoHash, 'photoHash')]]];
    },
    dec: (a) => {
      const x = a[0];
      return { dedicationId: ids.dedication(x[0]), treeId: x[1], species: x[2], scientific: x[3], gps: fromGps(x[4], x[5]), plantedOn: fromDay(x[6]), seedSource: x[7], photoHash: x[8] };
    },
  },
  tree_monitor: {
    c: 'LegacyGarden', fn: 'monitorTree',
    enc(p) {
      const health = enumIdx(HEALTH, p.health, 'health');
      const crown = health === 3 ? 2 : enumIdx(CROWN, p.crown, 'crown');
      return [[[str(p.treeId), toDay(p.date, 'date'), n(p.heightCm), n(p.stemMm), crown, health, hash32(p.photoHash, 'photoHash'), str(p.note).slice(0, 300), str(p.cause)]]];
    },
    dec: (a) => {
      const x = a[0];
      return { treeId: x[0], date: fromDay(x[1]), heightCm: n(x[2]), stemMm: n(x[3]), crown: CROWN[n(x[4])], health: HEALTH[n(x[5])], photoHash: x[6] === ZERO32 ? null : x[6], note: x[7], ...(x[8] ? { cause: x[8] } : {}) };
    },
  },
  tree_replace: {
    c: 'LegacyGarden', fn: 'replaceTree',
    enc(p) {
      const [lat, lon] = toGps(p.gps);
      return [[[str(p.treeId), toDay(p.plantedOn, 'plantedOn'), lat, lon, str(p.seedSource), hash32(p.photoHash, 'photoHash'), str(p.coveredBy), str(p.species), str(p.scientific)]]];
    },
    dec: (a) => {
      const x = a[0];
      return { treeId: x[0], plantedOn: fromDay(x[1]), gps: fromGps(x[2], x[3]), seedSource: x[4], photoHash: x[5], ...(x[6] ? { coveredBy: x[6] } : {}), ...(x[7] ? { species: x[7] } : {}), ...(x[8] ? { scientific: x[8] } : {}) };
    },
  },
  maintenance_renew: {
    c: 'LegacyGarden', fn: 'renewMaintenance',
    enc: (p) => [[num(p.dedicationId, 'DED', 'dedicationId'), n(p.year), str(p.paymentRef)]],
    dec: (a) => ({ dedicationId: ids.dedication(a[0]), year: n(a[1]), paymentRef: a[2] }),
  },
};

export const ACTION_TYPES = Object.keys(A);
const BY_FN = {};
for (const [type, a] of Object.entries(A)) if (a.c) BY_FN[`${a.c}.${a.fn}`] = type;

function call(contract, fn, args, value = 0n) {
  return { to: ADDRESSES[contract], data: IFACE[contract].encodeFunctionData(fn, args), value };
}

/**
 * Turn a Fedrok action into an EVM call.
 * @returns {{ to, data, value, spends }} spends: contract that needs an fUSD allowance, if any.
 */
export function encodeAction(type, payload = {}, ctx = {}) {
  const a = A[type];
  if (!a) throw new Error(`unknown action ${type}`);
  if (a.build) return { ...a.build(payload, ctx), spends: null };
  const [args, value = 0n] = a.enc(payload, ctx);
  const spends = typeof a.spends === 'function' ? a.spends(payload) : a.spends || null;
  return { ...call(a.c, a.fn, args, value), spends };
}

/** Turn a mined EVM transaction ({ from, to, data, value }) back into a Fedrok action. */
export function decodeAction(tx) {
  const to = tx.to ? tx.to.toLowerCase() : null;
  const data = tx.data && tx.data !== '0x' ? tx.data : null;
  if (!to) return { type: 'contract_deploy', payload: { bytes: data ? (data.length - 2) / 2 : 0 } };
  const contract = BY_ADDRESS[to];
  if (!data) return contract ? { type: 'evm_call', payload: { contract, value: s(tx.value) } } : { type: 'transfer', payload: { to, asset: 'FDK', amount: s(tx.value) } };
  if (!contract) return { type: 'evm_call', payload: { to, selector: data.slice(0, 10), value: s(tx.value) } };
  try {
    const parsed = IFACE[contract].parseTransaction({ data, value: tx.value });
    if (contract === 'FUSD' && parsed.name === 'transfer') return { type: 'transfer', payload: { to: parsed.args[0].toLowerCase(), asset: 'STABLE', amount: s(parsed.args[1]) } };
    const type = BY_FN[`${contract}.${parsed.name}`];
    if (!type) return { type: 'evm_call', payload: { contract, method: parsed.name } };
    return { type, payload: A[type].dec(parsed.args, tx) };
  } catch (e) {
    return { type: 'evm_call', payload: { contract, selector: data.slice(0, 10), error: e.message } };
  }
}
