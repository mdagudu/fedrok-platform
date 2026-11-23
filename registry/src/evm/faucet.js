// Devnet faucet helper shared by the server node and the in-browser node.
import { addressFromPrivate } from '../core/crypto.js';
import { fdk, stable } from '../core/units.js';
import { encodeAction } from './actions.js';
import { signEvmTx } from './signer.js';

/** Devnet faucet: FDK (native) and fUSD (ERC-20) from the faucet account. */
export async function faucetSend(chain, faucetKey, to, amounts = {}) {
  const from = addressFromPrivate(faucetKey);
  const base = chain.nextNonce(from);
  const s = chain.state;
  const calls = [
    encodeAction('transfer', { to, asset: 'FDK', amount: fdk(amounts.fdk || '50').toString() }),
    encodeAction('transfer', { to, asset: 'STABLE', amount: stable(amounts.stable || '25000').toString() }),
  ];
  const hashes = [];
  for (const [i, c] of calls.entries()) {
    const { raw } = signEvmTx({ chainId: s.chainId, nonce: base + i, to: c.to, data: c.data, value: c.value, gasLimit: 100_000n, minGasPrice: s.params.minGasPrice }, faucetKey);
    hashes.push((await chain.addTx(raw)).hash);
  }
  return hashes;
}

