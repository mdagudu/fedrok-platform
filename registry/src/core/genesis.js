// Devnet genesis shared by the local devnet launcher and the in-browser node.
import { fdk, stable } from './units.js';

export const DEVNET_CHAIN_ID = 7702;

/** The environmental project types offered when someone registers or proposes a project. */
export const PROJECT_TYPES = [
  'Reforestation & afforestation',
  'Agroforestry',
  'Mangrove & coastal restoration',
  'Peatland & wetland restoration',
  'Biodiversity & habitat conservation',
  'Regenerative agriculture & soil health',
  'Solar energy',
  'Wind energy',
  'Small-scale hydropower',
  'Clean cookstoves',
  'Biogas & waste-to-energy',
  'Water access & watershed protection',
  'Waste reduction & recycling',
  'Energy efficiency',
  'Sustainable transport',
  'Urban greening',
  'Ocean & marine conservation',
  'Climate education & community action',
  'Other environmental project',
];

/** A: addresses keyed by role name. */
export function buildDevnetGenesis(A, timestamp = Date.now(), network = 'fedrok-registry-devnet-1', chainId = DEVNET_CHAIN_ID) {
  return {
    network,
    chainId,
    timestamp: Math.floor(timestamp / 1000) * 1000,
    admin: A.governance,
    stableIssuer: A['stable-issuer'],
    stable: { symbol: 'fUSD', name: 'Fedrok Settlement USD (devnet stablecoin)', decimals: 6 },
    // Proof of Authority: these validators take turns producing blocks.
    validators: [
      { address: A['validator-1'], name: 'Fedrok validator Zurich' },
      { address: A['validator-2'], name: 'Fedrok validator Geneva' },
      { address: A['validator-3'], name: 'Fedrok validator Zug' },
    ],
    projectTypes: PROJECT_TYPES,
    // Devnet supply cap held by the FDKIssuer contract (minus the allocations below).
    fdkCap: fdk('1000000000').toString(),
    params: {
      blockTimeMs: 3000,
      minGasPrice: '1000000000', // 1 gwei of FDK per gas
      maxTxPerBlock: 500,
    },
    alloc: [
      // Devnet only: a genesis FDK reserve so wallets can pay network fees.
      { address: A.faucet, fdk: fdk('1000000').toString(), stable: stable('100000000').toString(), note: 'devnet faucet' },
      { address: A.governance, fdk: fdk('1000').toString() },
      { address: A['stable-issuer'], fdk: fdk('100').toString() },
      { address: A['validator-1'], fdk: fdk('100').toString() },
      { address: A['validator-2'], fdk: fdk('100').toString() },
      { address: A['validator-3'], fdk: fdk('100').toString() },
      { address: A['demo-buyer'], fdk: fdk('100').toString(), stable: stable('500000').toString(), note: 'Legacy Garden supporter' },
    ],
    faucet: { fdk: '50', stable: '25000' },
  };
}
