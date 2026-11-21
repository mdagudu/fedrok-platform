// Cryptographic primitives shared by the node, the SDK and the browser wallet.
// Keys are secp256k1 and addresses are derived exactly like Ethereum
// (last 20 bytes of keccak256 of the uncompressed public key): the same key
// signs Fedrok EVM transactions and works in MetaMask or any EVM wallet.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { AbiCoder, keccak256 } from 'ethers';
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

/** Sign a 32-byte digest with a recoverable signature: 0x r(32) s(32) v(1, 27/28). */
export function signRecoverable(digestHex, privHex) {
  const sig = secp256k1.sign(fromHex(digestHex), fromHex(privHex), { prehash: false, format: 'recovered' });
  return toHex(sig.slice(1, 65)) + (27 + sig[0]).toString(16);
}

/**
 * Devnet Bitcoin address of a key: "bcsim1" + hex(hash160(compressed key)).
 * hash160 = RIPEMD-160(SHA-256(key)), as for Bitcoin P2PKH. The Proof of Green
 * contract derives the same address on-chain from the public key.
 */
export function btcSimAddressOf(pubHex) {
  const pub = fromHex(pubHex);
  const compressed = pub.length === 33 ? pub : secp256k1.Point.fromBytes(pub).toBytes(true);
  return 'bcsim1' + bytesToHex(ripemd160(sha256(compressed)));
}

/**
 * Digest a Bitcoin miner signs to link its Bitcoin address to a Fedrok owner
 * account (checked on-chain with ecrecover by ProofOfGreen.accredit).
 */
export function btcLinkMessage(btcAddress, owner, chainId, pogAddress) {
  const h160 = '0x' + btcAddress.replace(/^bcsim1/, '');
  return keccak256(AbiCoder.defaultAbiCoder().encode(['string', 'uint256', 'address', 'bytes20', 'address'], ['Fedrok green miner link', chainId, pogAddress, h160, owner]));
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
