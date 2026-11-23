// EVM runtime for Fedrok nodes (Node.js and the browser): an ethereumjs VM
// configured for the Fedrok chain, plus the genesis that deploys the system
// contracts. Execution follows the Shanghai rule set.
import { createVM, runTx } from '@ethereumjs/vm';
import { createCustomCommon, Mainnet, Hardfork } from '@ethereumjs/common';
import { createBlock } from '@ethereumjs/block';
import { createAddressFromString, createAccount, bytesToHex, hexToBytes } from '@ethereumjs/util';
import { AbiCoder } from 'ethers';
import { ADDRESSES, ARTIFACTS, CONTRACT_NAMES, GENESIS_DEPLOYER, IFACE, revertReason } from './contracts.js';

export { runTx, bytesToHex, hexToBytes };
export const BLOCK_GAS_LIMIT = 100_000_000n;
export const CALL_GAS = 50_000_000n;
export const addrOf = (a) => createAddressFromString(a);

export function makeCommon(genesis) {
  return createCustomCommon({ chainId: Number(genesis.chainId), name: genesis.network }, Mainnet, { hardfork: Hardfork.Shanghai });
}

export function blockContext(common, { number, timestampSec, coinbase, baseFeePerGas }) {
  return createBlock({ header: { number: BigInt(number), timestamp: BigInt(timestampSec), coinbase: coinbase || '0x' + '0'.repeat(40), gasLimit: BLOCK_GAS_LIMIT, baseFeePerGas: BigInt(baseFeePerGas || 0) } }, { common, skipConsensusFormatValidation: true });
}

/** Static call (no state change kept). Throws with the revert reason. */
export async function viewCall(vm, block, contract, fn, args = [], from = GENESIS_DEPLOYER) {
  const iface = IFACE[contract];
  const r = await vm.evm.runCall({ caller: addrOf(from), to: addrOf(ADDRESSES[contract]), data: hexToBytes(iface.encodeFunctionData(fn, args)), gasLimit: CALL_GAS, block, isStatic: true, skipBalance: true });
  if (r.execResult.exceptionError) throw new Error(revertReason(r.execResult.returnValue));
  const out = iface.decodeFunctionResult(fn, r.execResult.returnValue);
  return out.length === 1 ? out[0] : out;
}

/** State-changing call as `from` without a signature (genesis setup and system calls only). */
export async function systemCall(vm, block, from, to, data, value = 0n) {
  const r = await vm.evm.runCall({ caller: addrOf(from), to: to ? addrOf(to) : undefined, data: hexToBytes(data), value, gasLimit: CALL_GAS, block, skipBalance: false });
  if (r.execResult.exceptionError) throw new Error(revertReason(r.execResult.returnValue));
  return r;
}

/**
 * Build the genesis state: deploy the five system contracts from the genesis
 * deployer (with the authority validator set and the project types) and apply
 * the allocations. Deterministic: every node computes the same state root.
 */
export async function createGenesisVM(genesis) {
  const common = makeCommon(genesis);
  const vm = await createVM({ common });
  const sm = vm.stateManager;
  const block = blockContext(common, { number: 0, timestampSec: Math.floor(genesis.timestamp / 1000) });
  const cap = BigInt(genesis.fdkCap);
  const allocFdk = (genesis.alloc || []).reduce((t, a) => t + BigInt(a.fdk || 0), 0n);
  if (allocFdk > cap) throw new Error('genesis allocations exceed the FDK cap');

  const deployer = addrOf(GENESIS_DEPLOYER);
  const acct = (await sm.getAccount(deployer)) ?? createAccount({});
  acct.balance = cap;
  await sm.putAccount(deployer, acct);

  const p = genesis.params;
  const coder = AbiCoder.defaultAbiCoder();
  const ctor = {
    FedrokGovernance: [[genesis.admin, genesis.stableIssuer, genesis.validators.map((v) => v.address), genesis.validators.map((v) => v.name), [p.blockTimeMs, p.minGasPrice, p.maxTxPerBlock]]],
    FDKIssuer: [[ADDRESSES.FedrokGovernance], cap - allocFdk],
    FUSD: [[ADDRESSES.FedrokGovernance, genesis.stable.name, genesis.stable.symbol]],
    ProjectRegistry: [[ADDRESSES.FedrokGovernance, genesis.projectTypes || []]],
    LegacyGarden: [[ADDRESSES.FedrokGovernance, ADDRESSES.FUSD]],
  };
  for (const name of CONTRACT_NAMES) {
    const [args, value = 0n] = ctor[name];
    const abiCtor = IFACE[name].deploy;
    const data = ARTIFACTS[name].bytecode + coder.encode(abiCtor.inputs, args).slice(2);
    const r = await systemCall(vm, block, GENESIS_DEPLOYER, null, data, value);
    const at = r.createdAddress?.toString().toLowerCase();
    if (at !== ADDRESSES[name]) throw new Error(`genesis: ${name} deployed at ${at}, expected ${ADDRESSES[name]}`);
  }

  const call = (from, contract, fn, args, value = 0n) => systemCall(vm, block, from, ADDRESSES[contract], IFACE[contract].encodeFunctionData(fn, args), value);
  for (const a of genesis.alloc || []) {
    if (a.fdk && BigInt(a.fdk) > 0n) await systemCall(vm, block, GENESIS_DEPLOYER, a.address, '0x', BigInt(a.fdk));
    if (a.stable && BigInt(a.stable) > 0n) await call(genesis.stableIssuer, 'FUSD', 'mint', [a.address, BigInt(a.stable), 'genesis allocation']);
  }
  const left = (await sm.getAccount(deployer)).balance;
  if (left !== 0n) throw new Error(`genesis deployer kept ${left} wei`);
  // Genesis setup calls bumped the role accounts' nonces; reset them so the
  // first real transaction of every account uses nonce 0.
  for (const a of new Set([genesis.admin, genesis.stableIssuer])) {
    const x = await sm.getAccount(addrOf(a));
    if (x) {
      x.nonce = 0n;
      await sm.putAccount(addrOf(a), x);
    }
  }
  const stateRoot = bytesToHex(await sm.getStateRoot());
  return { vm, common, stateRoot };
}
