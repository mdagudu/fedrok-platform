// Bitcoin header helpers shared by the simulator, the light client and the
// Proof of Green engine. The devnet simulator hashes a canonical JSON header;
// a production light client verifies real 80-byte Bitcoin headers instead.
import { canonical, sha256Hex } from './crypto.js';

export const MAX_BTC_HEADERS_PER_BLOCK = 50;

export function btcHeaderHash(h) {
  return sha256Hex(canonical({ height: h.height, prevHash: h.prevHash, time: h.time, nonce: h.nonce, minerAddress: h.minerAddress, merkle: h.merkle }));
}

export function meetsDifficulty(hash, difficulty) {
  return hash.slice(2, 2 + difficulty) === '0'.repeat(difficulty);
}

/** Check that `headers` extend the anchor (height + hash) with valid proof of work. */
export function verifyBtcHeaders(anchor, difficulty, headers) {
  if (!Array.isArray(headers)) throw new Error('btcHeaders must be an array');
  if (headers.length > MAX_BTC_HEADERS_PER_BLOCK) throw new Error('too many btc headers');
  let prevHash = anchor.hash;
  let prevHeight = anchor.height;
  for (const h of headers) {
    if (h.height !== prevHeight + 1) throw new Error(`btc header height gap at ${h.height}`);
    if (h.prevHash !== prevHash) throw new Error(`btc header ${h.height} does not link to previous`);
    if (btcHeaderHash(h) !== h.hash) throw new Error(`btc header ${h.height} hash mismatch`);
    if (!meetsDifficulty(h.hash, difficulty)) throw new Error(`btc header ${h.height} fails proof of work`);
    prevHash = h.hash;
    prevHeight = h.height;
  }
}
