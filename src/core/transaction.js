// Transaction envelope: build, hash, sign and verify.
// Shared verbatim between Node and the browser wallet.
import { GARDEN_TX_TYPES } from './garden.js';
import { canonical, keccakHex, signDigest, verifyDigest, publicKeyOf, addressOf } from './crypto.js';

export const TX_TYPES = [
  // value movement
  'transfer', 'fdk_burn',
  // settlement stablecoin (issuer-controlled mint, holder redemption)
  'stable_mint', 'stable_burn',
  // tokenised carbon credits
  'credit_issue', 'credit_transfer', 'credit_retire', 'fdk_back_mint',
  // stablecoin-settled marketplace
  'market_list', 'market_buy', 'market_cancel',
  // Proof of Green
  'miner_accredit', 'miner_revoke', 'miner_update',
  'generator_register', 'generator_link', 'generator_approve', 'generator_unlink', 'generator_exit',
  // governance (Fedrok AG today, DAO later)
  'gov_add_auditor', 'gov_remove_auditor', 'gov_set_fallback', 'gov_set_param', 'gov_set_stable_issuer',
  // Personal Legacy Garden: memorial tree registry
  ...GARDEN_TX_TYPES,
];

export function txBody(tx) {
  const { sig, hash, ...body } = tx;
  return body;
}

export function txHash(tx) {
  return keccakHex(canonical(txBody(tx)));
}

/**
 * Create and sign a transaction.
 * @param {object} p { chainId, type, nonce, fee (base-unit string), payload }
 */
export function signTx({ chainId, type, nonce, fee, payload }, privKey) {
  const pubKey = publicKeyOf(privKey);
  const tx = {
    chainId,
    type,
    from: addressOf(pubKey),
    nonce: Number(nonce),
    fee: String(fee),
    payload: payload || {},
    timestamp: Date.now(),
    pubKey,
  };
  const hash = txHash(tx);
  return { ...tx, sig: signDigest(hash, privKey), hash };
}

/** Structural and signature checks that do not need state. */
export function verifyTxEnvelope(tx, chainId) {
  if (!tx || typeof tx !== 'object') throw new Error('tx must be an object');
  if (tx.chainId !== chainId) throw new Error(`wrong chainId ${tx.chainId}`);
  if (!TX_TYPES.includes(tx.type)) throw new Error(`unknown tx type ${tx.type}`);
  if (!Number.isInteger(tx.nonce) || tx.nonce < 0) throw new Error('bad nonce');
  if (!/^\d+$/.test(String(tx.fee))) throw new Error('bad fee');
  if (typeof tx.payload !== 'object' || tx.payload === null) throw new Error('bad payload');
  if (canonical(tx).length > 16_384) throw new Error('tx too large');
  let addr;
  try {
    addr = addressOf(tx.pubKey);
  } catch {
    throw new Error('bad public key');
  }
  if (addr !== tx.from) throw new Error('from does not match public key');
  const h = txHash(tx);
  if (tx.hash && tx.hash !== h) throw new Error('hash mismatch');
  if (!verifyDigest(tx.sig, h, tx.pubKey)) throw new Error('invalid signature');
  return h;
}
