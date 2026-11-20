// Proof of Green consensus and block execution.
//
// Block production is anchored to Bitcoin. Each Fedrok block carries the new
// Bitcoin headers since its parent. When an accredited green miner wins a
// Bitcoin block, that miner becomes the active miner and its linked block
// generators take turns producing Fedrok blocks (round robin by time slot,
// so a generator that misses its slot is automatically replaced by the next
// one). If no green Bitcoin block has been seen within `greenWindow` Bitcoin
// blocks, the governance-assigned fallback validator produces blocks until
// green mining resumes.
import { canonical, sha256Hex, keccakHex, signDigest, verifyDigest, addressOf, publicKeyOf, merkleRoot } from './crypto.js';
import { applyTx, stateRoot, account, yearlyEmission, MS_PER_YEAR } from './state.js';
import { verifyTxEnvelope } from './transaction.js';

export const MAX_BTC_HEADERS_PER_BLOCK = 50;

// ------------------------------------------------------------- Bitcoin
export function btcHeaderHash(h) {
  return sha256Hex(canonical({ height: h.height, prevHash: h.prevHash, time: h.time, nonce: h.nonce, minerAddress: h.minerAddress, merkle: h.merkle }));
}

export function meetsDifficulty(hash, difficulty) {
  return hash.slice(2, 2 + difficulty) === '0'.repeat(difficulty);
}

export function verifyBtcHeaders(state, headers) {
  if (!Array.isArray(headers)) throw new Error('btcHeaders must be an array');
  if (headers.length > MAX_BTC_HEADERS_PER_BLOCK) throw new Error('too many btc headers');
  let prevHash = state.pog.anchorHash;
  let prevHeight = state.pog.anchorHeight;
  for (const h of headers) {
    if (h.height !== prevHeight + 1) throw new Error(`btc header height gap at ${h.height}`);
    if (h.prevHash !== prevHash) throw new Error(`btc header ${h.height} does not link to previous`);
    if (btcHeaderHash(h) !== h.hash) throw new Error(`btc header ${h.height} hash mismatch`);
    if (!meetsDifficulty(h.hash, state.btcDifficulty)) throw new Error(`btc header ${h.height} fails proof of work`);
    prevHash = h.hash;
    prevHeight = h.height;
  }
}

function isGreen(state, minerId, time) {
  const m = minerId && state.miners[minerId];
  return Boolean(m && m.active && m.expiresAt > time);
}

function processBtcHeaders(state, headers, timestamp) {
  for (const h of headers) {
    const minerId = state.btcToMiner[h.minerAddress];
    if (isGreen(state, minerId, timestamp)) {
      state.pog.activeMiner = minerId;
      state.pog.lastGreenBtcHeight = h.height;
      state.pog.greenBlocksSeen += 1;
      state.miners[minerId].greenBlocks += 1;
    }
    state.pog.anchorHeight = h.height;
    state.pog.anchorHash = h.hash;
  }
}

function expireMiners(state, timestamp) {
  for (const m of Object.values(state.miners)) {
    if (m.active && m.expiresAt <= timestamp) {
      m.active = false;
      m.revokedReason = 'audit period expired';
    }
  }
}

// ------------------------------------------------------------ schedule
export function schedule(state) {
  const pog = state.pog;
  const m = pog.activeMiner && state.miners[pog.activeMiner];
  const fresh = pog.lastGreenBtcHeight >= 0 && pog.anchorHeight - pog.lastGreenBtcHeight < state.params.greenWindow;
  if (m && m.active && fresh) {
    const gens = m.generators.filter((g) => state.generators[g]);
    if (gens.length > 0) return { mode: 'green', miner: m.id, generators: gens };
  }
  return { mode: 'fallback', miner: null, generators: [state.fallbackValidator] };
}

export function slotOf(timestamp, state) {
  return Math.floor(timestamp / state.params.blockTimeMs);
}

export function leaderFor(sched, slot) {
  return sched.generators[slot % sched.generators.length];
}

// --------------------------------------------------------------- blocks
export function blockHash(header) {
  return keccakHex(canonical(header));
}

export function genesisHash(genesis) {
  return keccakHex(canonical(genesis));
}

/**
 * Execute a block body against `state` (mutates it).
 * mode 'build'  : skip failing txs, return the ones included.
 * mode 'verify' : any failing tx throws.
 */
export function executeBlock(state, { timestamp, btcHeaders, txs, generator }, mode) {
  if (timestamp <= state.lastTimestamp) throw new Error('timestamp must increase');
  const slot = slotOf(timestamp, state);
  if (slot <= slotOf(state.lastTimestamp, state)) throw new Error('slot already used');

  verifyBtcHeaders(state, btcHeaders);
  processBtcHeaders(state, btcHeaders, timestamp);
  expireMiners(state, timestamp);

  const sched = schedule(state);
  const leader = leaderFor(sched, slot);
  if (leader !== generator) throw new Error(`not this generator's slot (leader is ${leader})`);

  const height = state.height + 1;
  let fees = 0n;
  const ctx = { height, timestamp, collectFee: (f) => (fees += f) };
  const included = [];
  const receipts = [];
  const rejected = [];
  if (txs.length > state.params.maxTxPerBlock) {
    if (mode === 'verify') throw new Error('too many transactions');
    txs = txs.slice(0, state.params.maxTxPerBlock);
  }
  for (const tx of txs) {
    try {
      verifyTxEnvelope(tx, state.chainId);
      const events = applyTx(state, tx, ctx);
      included.push(tx);
      receipts.push({ hash: tx.hash, status: 'ok', events });
    } catch (e) {
      if (mode === 'verify') throw new Error(`tx ${tx.hash}: ${e.message}`);
      rejected.push({ hash: tx.hash, error: e.message });
    }
  }

  // Emission from the Piggy Bank: per-second rate = active yearly reward / year.
  let reward = 0n;
  let minerReward = 0n;
  let generatorReward = 0n;
  if (sched.mode === 'green') {
    const dt = BigInt(Math.min(timestamp - state.lastTimestamp, state.params.blockTimeMs * 10));
    reward = (yearlyEmission(state) * dt) / MS_PER_YEAR;
    if (reward > state.piggyBank) reward = state.piggyBank;
    const m = state.miners[sched.miner];
    generatorReward = (reward * BigInt(m.generatorShareBps)) / 10000n;
    minerReward = reward - generatorReward;
    state.piggyBank -= reward;
    account(state, m.owner).fdk += minerReward;
    m.rewardsEarned += minerReward;
    state.supply.fdkRewards += reward;
  }
  account(state, generator).fdk += generatorReward + fees;
  if (state.generators[generator]) state.generators[generator].blocks += 1;

  state.height = height;
  state.lastTimestamp = timestamp;
  return { slot, sched, included, receipts, rejected, reward, minerReward, generatorReward, fees };
}

export function buildBlock(state, { timestamp, btcHeaders, txs, privKey }) {
  const pubKey = publicKeyOf(privKey);
  const generator = addressOf(pubKey);
  const prevHash = state.tipHash;
  const r = executeBlock(state, { timestamp, btcHeaders, txs, generator }, 'build');
  const header = {
    chainId: state.chainId,
    height: state.height,
    prevHash,
    timestamp,
    slot: r.slot,
    mode: r.sched.mode,
    activeMiner: r.sched.miner,
    generator,
    generatorPubKey: pubKey,
    btcAnchor: { height: state.pog.anchorHeight, hash: state.pog.anchorHash },
    txRoot: merkleRoot(r.included.map((t) => t.hash)),
    txCount: r.included.length,
    reward: r.reward.toString(),
    fees: r.fees.toString(),
    stateRoot: null,
  };
  // The state root is computed with tipHash blanked (the hash depends on the root).
  header.stateRoot = stateRootWithoutTip(state);
  const hash = blockHash(header);
  state.tipHash = hash;
  const block = { header, btcHeaders, txs: r.included, hash, sig: signDigest(hash, privKey) };
  return { block, receipts: r.receipts, rejected: r.rejected };
}

function stateRootWithoutTip(state) {
  const tip = state.tipHash;
  state.tipHash = null;
  const root = stateRoot(state);
  state.tipHash = tip;
  return root;
}

/** Validate and apply a received block onto `state` (mutates). */
export function applyBlock(state, block) {
  const h = block.header;
  if (h.chainId !== state.chainId) throw new Error('wrong chain');
  if (h.height !== state.height + 1) throw new Error(`expected height ${state.height + 1}`);
  if (h.prevHash !== state.tipHash) throw new Error('prevHash does not match tip');
  if (blockHash(h) !== block.hash) throw new Error('block hash mismatch');
  if (addressOf(h.generatorPubKey) !== h.generator) throw new Error('generator key mismatch');
  if (!verifyDigest(block.sig, block.hash, h.generatorPubKey)) throw new Error('bad block signature');
  if (merkleRoot(block.txs.map((t) => t.hash)) !== h.txRoot) throw new Error('txRoot mismatch');
  const r = executeBlock(state, { timestamp: h.timestamp, btcHeaders: block.btcHeaders, txs: block.txs, generator: h.generator }, 'verify');
  if (r.slot !== h.slot || r.sched.mode !== h.mode || r.sched.miner !== h.activeMiner) throw new Error('schedule mismatch');
  if (r.reward.toString() !== h.reward || r.fees.toString() !== h.fees) throw new Error('reward mismatch');
  if (state.pog.anchorHeight !== h.btcAnchor.height || state.pog.anchorHash !== h.btcAnchor.hash) throw new Error('btc anchor mismatch');
  state.tipHash = null;
  if (stateRoot(state) !== h.stateRoot) throw new Error('stateRoot mismatch');
  state.tipHash = block.hash;
  return r;
}
