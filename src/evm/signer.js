// Sign Fedrok transactions: standard EIP-1559 Ethereum transactions.
import { createFeeMarket1559Tx } from '@ethereumjs/tx';
import { createCustomCommon, Mainnet, Hardfork } from '@ethereumjs/common';
import { bytesToHex, hexToBytes } from '@ethereumjs/util';

const commons = new Map();
export function commonFor(chainId) {
  if (!commons.has(chainId)) commons.set(chainId, createCustomCommon({ chainId: Number(chainId), name: `fedrok-${chainId}` }, Mainnet, { hardfork: Hardfork.Shanghai }));
  return commons.get(chainId);
}

/**
 * @param c { chainId, nonce, to, data, value, gasLimit, minGasPrice }
 * @returns { raw, hash }
 */
export function signEvmTx({ chainId, nonce, to, data = '0x', value = 0n, gasLimit = 3_000_000n, minGasPrice }, privKey) {
  const base = BigInt(minGasPrice);
  const tx = createFeeMarket1559Tx({
    chainId: BigInt(chainId), nonce: BigInt(nonce), to, data: hexToBytes(data), value: BigInt(value), gasLimit: BigInt(gasLimit),
    maxPriorityFeePerGas: base, maxFeePerGas: base * 2n,
  }, { common: commonFor(chainId) }).sign(hexToBytes(privKey));
  return { raw: bytesToHex(tx.serialize()), hash: bytesToHex(tx.hash()) };
}
