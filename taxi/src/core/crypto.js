// Cryptographic primitives for the taxi ledger.
// SHA-256 for record hashes and Merkle roots; Ed25519 for the signatures made
// by in-car secure chips, the fleet operator and the permissioned validators.
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export { bytesToHex, hexToBytes, utf8ToBytes };

const bytes = (d) => (typeof d === 'string' ? utf8ToBytes(d) : d);
export const sha256Hex = (d) => bytesToHex(sha256(bytes(d)));

/** Deterministic JSON: sorted keys, no undefined. Everything hashed or signed goes through this. */
export function canonical(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number');
    return JSON.stringify(v);
  }
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (typeof v === 'object') {
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  throw new Error('cannot canonicalise ' + typeof v);
}

export const hashObject = (o) => sha256Hex(canonical(o));

/** A signing key. Demo keys are derived from a seed phrase so the network can be replayed. */
export function keyFromSeed(seed) {
  const secret = sha256(utf8ToBytes('fedrok-taxi-key:' + seed));
  return { secret: bytesToHex(secret), pub: bytesToHex(ed25519.getPublicKey(secret)) };
}

export function sign(secretHex, message) {
  return bytesToHex(ed25519.sign(bytes(message), hexToBytes(secretHex)));
}

export function verify(pubHex, message, sigHex) {
  try {
    return ed25519.verify(hexToBytes(sigHex), bytes(message), hexToBytes(pubHex));
  } catch {
    return false;
  }
}

export function merkleRoot(hashes) {
  if (!hashes.length) return sha256Hex('');
  let level = hashes.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256Hex(level[i] + (level[i + 1] ?? level[i])));
    }
    level = next;
  }
  return level[0];
}

/** Small seeded PRNG (mulberry32) for repeatable demo data and simulated sensor noise. */
export function rng(seed) {
  let a = typeof seed === 'number' ? seed : parseInt(sha256Hex(String(seed)).slice(0, 8), 16);
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randomHex = (n = 16) => {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return bytesToHex(b);
};
