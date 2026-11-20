// Cryptographic primitives shared by the node, the SDK and the browser wallet.
// Keys are secp256k1 and addresses are derived exactly like Ethereum
// (last 20 bytes of keccak256 of the uncompressed public key), so keys are
// portable to EVM tooling when the EVM execution layer is added.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export { bytesToHex, hexToBytes, utf8ToBytes };

const strip = (h) => (h.startsWith('0x') ? h.slice(2) : h);
export const toHex = (b) => '0x' + bytesToHex(b);
export const fromHex = (h) => hexToBytes(strip(h));

export function keccakHex(data) {
  return toHex(keccak_256(typeof data === 'string' ? utf8ToBytes(data) : data));
}

export function sha256Hex(data) {
  return toHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));
}

/** Deterministic JSON: sorted keys, BigInt as decimal strings. */
export function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  throw new Error('cannot canonicalise ' + typeof value);
}

export function generatePrivateKey() {
  return toHex(secp256k1.utils.randomSecretKey());
}

export function publicKeyOf(privHex) {
  return toHex(secp256k1.getPublicKey(fromHex(privHex), false));
}

export function addressOf(pubHex) {
  const pub = fromHex(pubHex);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('expected uncompressed public key');
  return toHex(keccak_256(pub.slice(1)).slice(-20));
}

export function addressFromPrivate(privHex) {
  return addressOf(publicKeyOf(privHex));
}

export function isAddress(a) {
  return typeof a === 'string' && /^0x[0-9a-f]{40}$/.test(a);
}

/** Sign a 32-byte hex digest. */
export function signDigest(digestHex, privHex) {
  return toHex(secp256k1.sign(fromHex(digestHex), fromHex(privHex), { prehash: false }));
}

export function verifyDigest(sigHex, digestHex, pubHex) {
  try {
    return secp256k1.verify(fromHex(sigHex), fromHex(digestHex), fromHex(pubHex), { prehash: false });
  } catch {
    return false;
  }
}

/** Simulated Bitcoin address derived from a secp256k1 key (devnet only). */
export function btcSimAddressOf(pubHex) {
  return 'bcsim1' + bytesToHex(sha256(fromHex(pubHex))).slice(0, 38);
}

export function btcLinkMessage(btcAddress, fedrokAddress, chainId) {
  return keccakHex(`Fedrok green miner link|${chainId}|${btcAddress}|${fedrokAddress}`);
}

export function merkleRoot(hashes) {
  if (hashes.length === 0) return keccakHex('');
  let level = hashes.map((h) => fromHex(h));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] || level[i];
      const joined = new Uint8Array(64);
      joined.set(a, 0);
      joined.set(b, 32);
      next.push(keccak_256(joined));
    }
    level = next;
  }
  return toHex(level[0]);
}
