// Fedrok system contracts: ABIs, interfaces and their fixed addresses.
//
// Every Fedrok network deploys the same five contracts in the same order
// from the same genesis deployer, so their addresses are identical on every
// network (devnet, hosted demo, tests). See src/evm/vm.js.
import { Interface, getCreateAddress, hexlify, AbiCoder } from 'ethers';
import artifacts from './artifacts.json' with { type: 'json' };

export const GENESIS_DEPLOYER = '0x0000000000000000000000000000000000fed000';
export const SYSTEM_ADDRESS = '0xfffffffffffffffffffffffffffffffffffffffe';
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dead';

/** Deployment order (= deployer nonce). */
export const CONTRACT_NAMES = ['FedrokGovernance', 'FDKIssuer', 'FUSD', 'ProjectRegistry', 'LegacyGarden'];

export const ADDRESSES = Object.fromEntries(CONTRACT_NAMES.map((name, nonce) => [name, getCreateAddress({ from: GENESIS_DEPLOYER, nonce }).toLowerCase()]));
export const BY_ADDRESS = Object.fromEntries(Object.entries(ADDRESSES).map(([n, a]) => [a, n]));

export const ARTIFACTS = artifacts.contracts;
export const IFACE = Object.fromEntries(CONTRACT_NAMES.map((n) => [n, new Interface(ARTIFACTS[n].abi)]));

/** Decode an EVM revert payload into a readable reason. */
export function revertReason(returnData) {
  const hex = typeof returnData === 'string' ? returnData : hexlify(returnData || new Uint8Array());
  if (!hex || hex === '0x') return 'transaction reverted';
  if (hex.startsWith('0x08c379a0')) {
    try {
      return AbiCoder.defaultAbiCoder().decode(['string'], '0x' + hex.slice(10))[0];
    } catch {}
  }
  if (hex.startsWith('0x4e487b71')) return 'arithmetic error (panic)';
  return 'transaction reverted';
}
