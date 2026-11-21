// Devnet genesis shared by the local devnet launcher and the in-browser node.
import { fdk, stable } from './units.js';

export const DEVNET_CHAIN_ID = 7701;

/** A: addresses keyed by role name; btcGenesis: Bitcoin header at height 0. */
export function buildDevnetGenesis(A, btcGenesis, timestamp = Date.now(), network = 'fedrok-devnet-1', chainId = DEVNET_CHAIN_ID) {
  return {
    network,
    chainId,
    timestamp: Math.floor(timestamp / 1000) * 1000,
    admin: A.governance,
    stableIssuer: A['stable-issuer'],
    stable: { symbol: 'fUSD', name: 'Fedrok Settlement USD (devnet stablecoin)', decimals: 6 },
    fallbackValidator: A['generator-1'],
    btc: { anchorHeight: btcGenesis.height, anchorHash: btcGenesis.hash, difficulty: 3 },
    // Devnet supply cap held by the FDKIssuer contract. FDK leaves it only via
    // Piggy Bank pre-fills and auditor back-minting (plus the devnet faucet
    // allocation below).
    fdkCap: fdk('1000000000').toString(),
    params: {
      blockTimeMs: 3000,
      minGasPrice: '1000000000', // 1 gwei of FDK per gas
      minGeneratorStake: fdk('1000').toString(),
      fdkPerUnitYear: fdk('23').toString(),
      greenWindow: 6,
      maxGeneratorsPerMiner: 21,
      marketFeeBps: 50,
      maxTxPerBlock: 500,
    },
    auditors: [{ address: A.auditor, name: 'Alpine Climate Assurance (devnet auditor)' }],
    alloc: [
      // Devnet only: a genesis FDK reserve so test wallets can pay network
      // fees and stake. On mainnet FDK is only issued by accreditation
      // (Piggy Bank pre-fill) or by auditor back-minting against credits.
      { address: A.faucet, fdk: fdk('1000000').toString(), stable: stable('100000000').toString(), note: 'devnet faucet' },
      { address: A.governance, fdk: fdk('1000').toString() },
      { address: A.auditor, fdk: fdk('1000').toString() },
      { address: A['stable-issuer'], fdk: fdk('100').toString() },
      { address: A['generator-1'], fdk: fdk('2000').toString() },
      { address: A['generator-2'], fdk: fdk('2000').toString() },
      { address: A['generator-3'], fdk: fdk('2000').toString() },
      { address: A['demo-buyer'], fdk: fdk('100').toString(), stable: stable('500000').toString() },
    ],
    faucet: { fdk: '50', stable: '25000' },
  };
}
