// World state and the state-transition function for every transaction type.
// The state is a plain object (BigInt values) so it can be structuredClone'd
// and hashed canonically.
import { canonical, sha256Hex, isAddress, verifyDigest, btcSimAddressOf, btcLinkMessage, keccakHex } from './crypto.js';
import { gardenHandlers } from './garden.js';

export const MS_PER_YEAR = 365n * 24n * 3600n * 1000n;
export const KG_TO_FDK = 10n ** 15n; // 1 tonne CO2e backs 1 FDK (18 decimals)

const PARAM_RULES = {
  blockTimeMs: (v) => Number.isInteger(v) && v >= 500 && v <= 60_000,
  minFee: (v) => /^\d+$/.test(String(v)),
  minGeneratorStake: (v) => /^\d+$/.test(String(v)),
  fdkPerUnitYear: (v) => /^\d+$/.test(String(v)),
  greenWindow: (v) => Number.isInteger(v) && v >= 1 && v <= 1000,
  maxGeneratorsPerMiner: (v) => Number.isInteger(v) && v >= 1 && v <= 101,
  marketFeeBps: (v) => Number.isInteger(v) && v >= 0 && v <= 1000,
  maxTxPerBlock: (v) => Number.isInteger(v) && v >= 1 && v <= 5000,
};
const BIGINT_PARAMS = ['minFee', 'minGeneratorStake', 'fdkPerUnitYear'];

export function createGenesisState(genesis) {
  const p = genesis.params;
  const state = {
    chainId: genesis.chainId,
    height: 0,
    tipHash: keccakHex(canonical(genesis)),
    lastTimestamp: genesis.timestamp,
    params: {
      ...p,
      minFee: BigInt(p.minFee),
      minGeneratorStake: BigInt(p.minGeneratorStake),
      fdkPerUnitYear: BigInt(p.fdkPerUnitYear),
    },
    admin: genesis.admin,
    stableIssuer: genesis.stableIssuer,
    stable: genesis.stable, // { symbol, name }
    fallbackValidator: genesis.fallbackValidator,
    btcDifficulty: genesis.btc.difficulty,
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
    pog: {
      anchorHeight: genesis.btc.anchorHeight,
      anchorHash: genesis.btc.anchorHash,
      activeMiner: null,
      lastGreenBtcHeight: -1,
      greenBlocksSeen: 0,
    },
    supply: {
      fdkMinted: 0n, fdkBurned: 0n, fdkRewards: 0n, fdkFees: 0n,
      stableMinted: 0n, stableBurned: 0n,
      creditsIssued: 0n, creditsRetired: 0n, creditsBacking: 0n,
    },
    counters: { batches: 0, listings: 0, retirements: 0, txs: 0 },
  };
  for (const a of genesis.auditors || []) {
    state.auditors[a.address] = { name: a.name, addedAt: genesis.timestamp, active: true };
  }
  for (const a of genesis.alloc || []) {
    const acct = account(state, a.address);
    if (a.fdk) {
      acct.fdk += BigInt(a.fdk);
      state.supply.fdkMinted += BigInt(a.fdk);
    }
    if (a.stable) {
      acct.stable += BigInt(a.stable);
      state.supply.stableMinted += BigInt(a.stable);
    }
  }
  return state;
}

export function account(state, addr) {
  if (!state.accounts[addr]) state.accounts[addr] = { fdk: 0n, stable: 0n, nonce: 0, credits: {} };
  return state.accounts[addr];
}

export function peekAccount(state, addr) {
  return state.accounts[addr] || { fdk: 0n, stable: 0n, nonce: 0, credits: {} };
}

export function stateRoot(state) {
  return sha256Hex(canonical(state));
}

export function cloneState(state) {
  return structuredClone(state);
}

// ---------------------------------------------------------------- helpers
function req(cond, msg) {
  if (!cond) throw new Error(msg);
}
function big(v, name) {
  req(v !== undefined && v !== null && /^\d+$/.test(String(v)), `${name} must be a non-negative integer string`);
  return BigInt(v);
}
function pos(v, name) {
  const b = big(v, name);
  req(b > 0n, `${name} must be greater than zero`);
  return b;
}
function str(v, name, max = 200) {
  req(typeof v === 'string' && v.trim().length > 0 && v.length <= max, `${name} is required (max ${max} chars)`);
  return v.trim();
}
function addr(v, name) {
  req(isAddress(v), `${name} must be a 0x address`);
  return v;
}
function isAuditor(state, a) {
  return state.auditors[a] && state.auditors[a].active;
}
const pad = (n) => String(n).padStart(6, '0');

function burnFromPiggy(state, amount) {
  const amt = amount > state.piggyBank ? state.piggyBank : amount;
  state.piggyBank -= amt;
  state.supply.fdkBurned += amt;
  return amt;
}

function moveCredits(from, to, batchId, kg) {
  const have = from.credits[batchId] || 0n;
  req(have >= kg, `insufficient credits in batch ${batchId}`);
  from.credits[batchId] = have - kg;
  if (from.credits[batchId] === 0n) delete from.credits[batchId];
  if (to) {
    const target = typeof to === 'function' ? to() : to;
    target.credits[batchId] = (target.credits[batchId] || 0n) + kg;
  }
}

export function yearlyEmission(state) {
  let total = 0n;
  for (const m of Object.values(state.miners)) if (m.active) total += m.yearlyReward;
  return total;
}

// ------------------------------------------------------------ tx handlers
// Each handler validates fully before mutating. `spend` is the FDK the
// handler itself will debit; the dispatcher ensures fee + spend is covered.
const handlers = {
  transfer(s, tx, a) {
    const { to, asset } = tx.payload;
    addr(to, 'to');
    const amount = pos(tx.payload.amount, 'amount');
    req(asset === 'FDK' || asset === 'STABLE', 'asset must be FDK or STABLE');
    if (asset === 'FDK') {
      req(a.fdk >= amount + BigInt(tx.fee), 'insufficient FDK');
      a.fdk -= amount;
      account(s, to).fdk += amount;
    } else {
      req(a.stable >= amount, `insufficient ${s.stable.symbol}`);
      a.stable -= amount;
      account(s, to).stable += amount;
    }
    return [{ event: 'Transfer', asset, from: tx.from, to, amount }];
  },

  fdk_burn(s, tx, a) {
    const amount = pos(tx.payload.amount, 'amount');
    const reason = str(tx.payload.reason || 'utility consumption', 'reason');
    req(a.fdk >= amount + BigInt(tx.fee), 'insufficient FDK');
    a.fdk -= amount;
    s.supply.fdkBurned += amount;
    return [{ event: 'FdkBurned', from: tx.from, amount, reason }];
  },

  stable_mint(s, tx) {
    req(tx.from === s.stableIssuer, 'only the stablecoin issuer can mint');
    const { to } = tx.payload;
    addr(to, 'to');
    const amount = pos(tx.payload.amount, 'amount');
    const reserveRef = str(tx.payload.reserveRef, 'reserveRef');
    account(s, to).stable += amount;
    s.supply.stableMinted += amount;
    return [{ event: 'StableMinted', to, amount, reserveRef }];
  },

  stable_burn(s, tx, a) {
    const amount = pos(tx.payload.amount, 'amount');
    req(a.stable >= amount, `insufficient ${s.stable.symbol}`);
    a.stable -= amount;
    s.supply.stableBurned += amount;
    return [{ event: 'StableRedeemed', from: tx.from, amount, redemptionRef: tx.payload.redemptionRef || '' }];
  },

  credit_issue(s, tx, a, ctx) {
    req(isAuditor(s, tx.from), 'only an accredited auditor can issue carbon credits');
    const p = tx.payload;
    const quantityKg = pos(p.quantityKg, 'quantityKg');
    const to = p.to ? addr(p.to, 'to') : tx.from;
    const batch = {
      project: str(p.project, 'project'),
      country: str(p.country, 'country', 80),
      registry: str(p.registry, 'registry', 80),
      methodology: str(p.methodology, 'methodology', 120),
      projectType: str(p.projectType || 'Other', 'projectType', 80),
      vintage: Number(p.vintage),
      serial: str(p.serial, 'serial', 160),
      description: typeof p.description === 'string' ? p.description.slice(0, 1000) : '',
    };
    req(Number.isInteger(batch.vintage) && batch.vintage >= 1990 && batch.vintage <= 2100, 'vintage must be a year');
    for (const b of Object.values(s.batches)) {
      req(!(b.registry === batch.registry && b.serial === batch.serial), 'serial already tokenised (double counting blocked)');
    }
    s.counters.batches += 1;
    const id = `CCB-${pad(s.counters.batches)}`;
    s.batches[id] = { id, ...batch, auditor: tx.from, issuedKg: quantityKg, retiredKg: 0n, backingKg: 0n, issuedAt: ctx.timestamp, issueTx: tx.hash, height: ctx.height };
    account(s, to).credits[id] = (account(s, to).credits[id] || 0n) + quantityKg;
    s.supply.creditsIssued += quantityKg;
    return [{ event: 'CreditsIssued', batchId: id, to, quantityKg }];
  },

  credit_transfer(s, tx, a) {
    const { batchId, to } = tx.payload;
    req(s.batches[batchId], 'unknown batch');
    addr(to, 'to');
    const kg = pos(tx.payload.quantityKg, 'quantityKg');
    moveCredits(a, () => account(s, to), batchId, kg);
    return [{ event: 'CreditsTransferred', batchId, from: tx.from, to, quantityKg: kg }];
  },

  credit_retire(s, tx, a, ctx) {
    const { batchId } = tx.payload;
    const batch = s.batches[batchId];
    req(batch, 'unknown batch');
    const kg = pos(tx.payload.quantityKg, 'quantityKg');
    const beneficiary = str(tx.payload.beneficiary, 'beneficiary');
    const reason = str(tx.payload.reason || 'Voluntary offset', 'reason', 300);
    moveCredits(a, null, batchId, kg);
    batch.retiredKg += kg;
    s.supply.creditsRetired += kg;
    s.counters.retirements += 1;
    const id = `RET-${pad(s.counters.retirements)}`;
    s.retirements[id] = { id, batchId, quantityKg: kg, beneficiary, reason, retiredBy: tx.from, timestamp: ctx.timestamp, tx: tx.hash, height: ctx.height };
    return [{ event: 'CreditsRetired', retirementId: id, batchId, quantityKg: kg, beneficiary }];
  },

  fdk_back_mint(s, tx, a) {
    // An auditor locks verified, existing carbon credits in the backing vault
    // and FDK is minted 1:1 per tonne. FDK stays a utility token: it records
    // verified reduction and pays for protocol access; it is never priced
    // against or used as a payment currency on this platform.
    req(isAuditor(s, tx.from), 'only an accredited auditor can back-mint FDK');
    const { batchId } = tx.payload;
    const batch = s.batches[batchId];
    req(batch, 'unknown batch');
    const kg = pos(tx.payload.quantityKg, 'quantityKg');
    const to = tx.payload.to ? addr(tx.payload.to, 'to') : tx.from;
    moveCredits(a, null, batchId, kg);
    s.backingVault[batchId] = (s.backingVault[batchId] || 0n) + kg;
    batch.backingKg += kg;
    s.supply.creditsBacking += kg;
    const minted = kg * KG_TO_FDK;
    account(s, to).fdk += minted;
    s.supply.fdkMinted += minted;
    return [{ event: 'FdkBackMinted', batchId, quantityKg: kg, to, amount: minted }];
  },

  market_list(s, tx, a, ctx) {
    const { batchId } = tx.payload;
    req(s.batches[batchId], 'unknown batch');
    const kg = pos(tx.payload.quantityKg, 'quantityKg');
    const price = pos(tx.payload.pricePerTonne, 'pricePerTonne');
    moveCredits(a, null, batchId, kg);
    s.counters.listings += 1;
    const id = `LST-${pad(s.counters.listings)}`;
    s.listings[id] = { id, seller: tx.from, batchId, remainingKg: kg, listedKg: kg, pricePerTonne: price, status: 'open', createdAt: ctx.timestamp, height: ctx.height };
    return [{ event: 'Listed', listingId: id, batchId, quantityKg: kg, pricePerTonne: price }];
  },

  market_buy(s, tx, a) {
    const l = s.listings[tx.payload.listingId];
    req(l && l.status === 'open', 'listing is not open');
    req(l.seller !== tx.from, 'cannot buy your own listing');
    const kg = pos(tx.payload.quantityKg, 'quantityKg');
    req(kg <= l.remainingKg, 'not enough credits left in listing');
    if (tx.payload.maxPricePerTonne !== undefined) {
      req(l.pricePerTonne <= big(tx.payload.maxPricePerTonne, 'maxPricePerTonne'), 'price above your limit');
    }
    const cost = (l.pricePerTonne * kg + 999n) / 1000n;
    req(a.stable >= cost, `insufficient ${s.stable.symbol}: need ${cost}`);
    const fee = (cost * BigInt(s.params.marketFeeBps)) / 10000n;
    a.stable -= cost;
    account(s, l.seller).stable += cost - fee;
    if (fee > 0n) account(s, s.admin).stable += fee;
    a.credits[l.batchId] = (a.credits[l.batchId] || 0n) + kg;
    l.remainingKg -= kg;
    if (l.remainingKg === 0n) l.status = 'filled';
    return [{ event: 'Purchased', listingId: l.id, buyer: tx.from, seller: l.seller, batchId: l.batchId, quantityKg: kg, paid: cost, platformFee: fee, currency: s.stable.symbol }];
  },

  market_cancel(s, tx, a) {
    const l = s.listings[tx.payload.listingId];
    req(l && l.status === 'open', 'listing is not open');
    req(l.seller === tx.from, 'only the seller can cancel');
    a.credits[l.batchId] = (a.credits[l.batchId] || 0n) + l.remainingKg;
    l.status = 'cancelled';
    return [{ event: 'ListingCancelled', listingId: l.id, returnedKg: l.remainingKg }];
  },

  miner_accredit(s, tx, a, ctx) {
    req(isAuditor(s, tx.from), 'only an accredited auditor can accredit miners');
    const p = tx.payload;
    const owner = addr(p.owner, 'owner');
    const btcAddress = str(p.btcAddress, 'btcAddress', 100);
    req(btcSimAddressOf(p.btcPubKey) === btcAddress, 'btcPubKey does not match btcAddress');
    req(verifyDigest(p.btcSig, btcLinkMessage(btcAddress, owner, s.chainId), p.btcPubKey), 'Bitcoin ownership proof is invalid');
    const units = Number(p.units);
    req(Number.isInteger(units) && units >= 1 && units <= 1_000_000, 'units must be a whole number of S9-equivalents');
    const auditDays = Number(p.auditDays || 365);
    req(Number.isInteger(auditDays) && auditDays >= 1 && auditDays <= 730, 'auditDays must be 1-730');
    const shareBps = Number(p.generatorShareBps ?? 1000);
    req(Number.isInteger(shareBps) && shareBps >= 0 && shareBps <= 10000, 'generatorShareBps must be 0-10000');
    const existing = s.btcToMiner[btcAddress];
    req(!existing || !s.miners[existing].active, 'miner already accredited');
    const id = 'MNR-' + keccakHex(btcAddress).slice(2, 10).toUpperCase();
    const yearlyReward = BigInt(units) * s.params.fdkPerUnitYear;
    const prefill = (yearlyReward * BigInt(auditDays)) / 365n;
    const prev = s.miners[id];
    s.miners[id] = {
      id, name: str(p.name || id, 'name', 120), btcAddress, owner, units, auditor: tx.from,
      site: typeof p.site === 'string' ? p.site.slice(0, 160) : '',
      energy: typeof p.energy === 'string' ? p.energy.slice(0, 120) : '',
      reportRef: typeof p.reportRef === 'string' ? p.reportRef.slice(0, 200) : '',
      accreditedAt: ctx.timestamp, expiresAt: ctx.timestamp + auditDays * 86_400_000,
      active: true, yearlyReward, prefill,
      publicGenerators: Boolean(p.publicGenerators), generatorShareBps: shareBps,
      generators: prev ? prev.generators : [], approved: prev ? prev.approved : [],
      greenBlocks: prev ? prev.greenBlocks : 0, rewardsEarned: prev ? prev.rewardsEarned : 0n,
    };
    s.btcToMiner[btcAddress] = id;
    s.piggyBank += prefill;
    s.supply.fdkMinted += prefill;
    return [{ event: 'MinerAccredited', minerId: id, btcAddress, owner, units, piggyBankPrefill: prefill }];
  },

  miner_revoke(s, tx, a, ctx) {
    const m = s.miners[tx.payload.minerId];
    req(m && m.active, 'miner is not active');
    req(tx.from === s.admin || tx.from === m.auditor, 'only the accrediting auditor or governance can revoke');
    const reason = str(tx.payload.reason || 'revoked', 'reason', 300);
    const remaining = BigInt(Math.max(0, m.expiresAt - ctx.timestamp));
    const unserved = (m.yearlyReward * remaining) / MS_PER_YEAR;
    const burned = burnFromPiggy(s, unserved);
    m.active = false;
    m.revokedReason = reason;
    return [{ event: 'MinerRevoked', minerId: m.id, unservedBurned: burned }];
  },

  miner_update(s, tx) {
    const m = s.miners[tx.payload.minerId];
    req(m, 'unknown miner');
    req(m.owner === tx.from, 'only the miner owner can update');
    if (tx.payload.publicGenerators !== undefined) m.publicGenerators = Boolean(tx.payload.publicGenerators);
    if (tx.payload.generatorShareBps !== undefined) {
      const v = Number(tx.payload.generatorShareBps);
      req(Number.isInteger(v) && v >= 0 && v <= 10000, 'generatorShareBps must be 0-10000');
      m.generatorShareBps = v;
    }
    return [{ event: 'MinerUpdated', minerId: m.id }];
  },

  generator_register(s, tx, a, ctx) {
    req(!s.generators[tx.from], 'already registered as block generator');
    const stake = big(tx.payload.stake, 'stake');
    req(stake >= s.params.minGeneratorStake, `stake must be at least the minimum generator stake`);
    req(a.fdk >= stake + BigInt(tx.fee), 'insufficient FDK for stake');
    a.fdk -= stake;
    s.generators[tx.from] = { address: tx.from, stake, links: [], registeredAt: ctx.timestamp, blocks: 0, name: typeof tx.payload.name === 'string' ? tx.payload.name.slice(0, 80) : '' };
    return [{ event: 'GeneratorRegistered', generator: tx.from, stake }];
  },

  generator_approve(s, tx) {
    const m = s.miners[tx.payload.minerId];
    req(m, 'unknown miner');
    req(m.owner === tx.from, 'only the miner owner can approve generators');
    const g = addr(tx.payload.generator, 'generator');
    if (!m.approved.includes(g)) m.approved.push(g);
    return [{ event: 'GeneratorApproved', minerId: m.id, generator: g }];
  },

  generator_link(s, tx) {
    const g = s.generators[tx.from];
    req(g, 'register as a block generator first');
    const m = s.miners[tx.payload.minerId];
    req(m && m.active, 'miner is not active');
    req(m.publicGenerators || m.approved.includes(tx.from) || m.owner === tx.from, 'miner is private and has not approved you');
    req(!m.generators.includes(tx.from), 'already linked');
    req(m.generators.length < s.params.maxGeneratorsPerMiner, 'miner has the maximum number of generators');
    m.generators.push(tx.from);
    g.links.push(m.id);
    return [{ event: 'GeneratorLinked', minerId: m.id, generator: tx.from }];
  },

  generator_unlink(s, tx) {
    const g = s.generators[tx.from];
    req(g, 'not a generator');
    const m = s.miners[tx.payload.minerId];
    req(m && m.generators.includes(tx.from), 'not linked to that miner');
    m.generators = m.generators.filter((x) => x !== tx.from);
    g.links = g.links.filter((x) => x !== m.id);
    return [{ event: 'GeneratorUnlinked', minerId: m.id, generator: tx.from }];
  },

  generator_exit(s, tx, a) {
    const g = s.generators[tx.from];
    req(g, 'not a generator');
    req(g.links.length === 0, 'unlink from all miners first');
    a.fdk += g.stake;
    delete s.generators[tx.from];
    return [{ event: 'GeneratorExited', generator: tx.from, returnedStake: g.stake }];
  },

  gov_add_auditor(s, tx, a, ctx) {
    req(tx.from === s.admin, 'governance only');
    const au = addr(tx.payload.auditor, 'auditor');
    s.auditors[au] = { name: str(tx.payload.name, 'name', 120), addedAt: ctx.timestamp, active: true };
    return [{ event: 'AuditorAdded', auditor: au }];
  },
  gov_remove_auditor(s, tx) {
    req(tx.from === s.admin, 'governance only');
    const au = s.auditors[tx.payload.auditor];
    req(au, 'unknown auditor');
    au.active = false;
    return [{ event: 'AuditorRemoved', auditor: tx.payload.auditor }];
  },
  gov_set_fallback(s, tx) {
    req(tx.from === s.admin, 'governance only');
    s.fallbackValidator = addr(tx.payload.validator, 'validator');
    return [{ event: 'FallbackValidatorSet', validator: s.fallbackValidator }];
  },
  gov_set_stable_issuer(s, tx) {
    req(tx.from === s.admin, 'governance only');
    s.stableIssuer = addr(tx.payload.issuer, 'issuer');
    return [{ event: 'StableIssuerSet', issuer: s.stableIssuer }];
  },
  gov_set_param(s, tx) {
    req(tx.from === s.admin, 'governance only');
    const { key, value } = tx.payload;
    req(PARAM_RULES[key], `unknown parameter ${key}`);
    req(PARAM_RULES[key](value), `invalid value for ${key}`);
    s.params[key] = BIGINT_PARAMS.includes(key) ? BigInt(value) : value;
    return [{ event: 'ParamSet', key, value: String(value) }];
  },

  // Personal Legacy Garden registry (src/core/garden.js)
  ...gardenHandlers,
};

/**
 * Apply one transaction in place. Throws (without mutating) if invalid.
 * ctx: { height, timestamp, collectFee(amount) }
 */
export function applyTx(state, tx, ctx) {
  const a = peekAccount(state, tx.from);
  req(tx.nonce === a.nonce, `bad nonce: expected ${a.nonce}, got ${tx.nonce}`);
  const fee = BigInt(tx.fee);
  req(fee >= state.params.minFee, 'fee below network minimum');
  req(a.fdk >= fee, 'insufficient FDK for network fee');
  // The sender always exists here (it holds FDK for the fee).
  const events = handlers[tx.type](state, tx, state.accounts[tx.from], ctx);
  a.fdk -= fee;
  a.nonce += 1;
  state.supply.fdkFees += fee;
  state.counters.txs += 1;
  ctx.collectFee(fee);
  return events;
}
