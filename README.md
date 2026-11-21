# Fedrok Network

An EVM-compatible Layer 1 for environmental asset records, built for Fedrok AG. Authorised issuers issue, transfer and retire verified carbon credits through Solidity contracts; blocks are produced under Proof of Green, anchored to Bitcoin; every payment settles in a stablecoin. Includes a branded explorer, wallet and governance console, and standard Ethereum JSON-RPC for MetaMask, ethers.js, viem and Foundry.

> **Changing the world, one small project at a time.**

![Overview](docs/screenshots/overview.png)

## Hosted demo

`npm run build:demo` builds `dist/fedrok-demo.html`: the full web app plus a complete network running inside the browser (simulated Bitcoin chain, a validating node with three block generators, faucet and demo data). It runs the same EVM, Solidity contracts, Proof of Green block rules and API layer (`src/node/api-core.js`) as a server node; only the transport differs. Each visitor gets their own network, saved in their browser. No backend is needed, so the file works offline for presentations.

## Quick start

Requires Node.js 20.10 or newer.

```bash
npm install
npm run devnet -- --reset   # Bitcoin simulator + 3 Fedrok nodes (Zurich, Geneva, Zug)
npm run demo                # in a second terminal: seeds miners, generators, credits, trades
```

Open **http://127.0.0.1:8545** for the explorer and wallet. The other nodes serve the same UI on ports 8546 and 8547.

To try the wallet, either create a new wallet and press **Get devnet FDK and fUSD**, or import one of the demo keys from `devnet/keys/`:

| Key file | Role |
|---|---|
| `demo-buyer.key` | Corporate buyer holding fUSD |
| `auditor.key` | Accredited auditor: issues credits, accredits miners, back-mints FDK |
| `governance.key` | Fedrok AG governance: auditors, parameters, fallback validator |
| `stable-issuer.key` | Stablecoin issuer: mints fUSD against reserve attestations |
| `developer-*.key` | Project developers who listed credits |
| `miner-*.key` | Owners of the accredited green miners |

Run the protocol tests with `npm test`.

### Connect MetaMask or ethers.js

Every node serves standard Ethereum JSON-RPC at `/rpc`. The **Developers** page has an *Add to MetaMask* button; by hand, use:

| Setting | Value |
|---|---|
| RPC URL | `http://127.0.0.1:8545/rpc` |
| Chain ID | `7701` |
| Currency symbol | `FDK` (18 decimals, gas only) |

```js
import { JsonRpcProvider, Contract } from 'ethers';
const provider = new JsonRpcProvider('http://127.0.0.1:8545/rpc');
const contracts = await (await fetch('http://127.0.0.1:8545/api/contracts?abi=1')).json();
const { address, abi } = contracts.find((c) => c.name === 'CarbonRegistry');
const registry = new Contract(address, abi, provider);
```

## Architecture

```
 Web app / MetaMask / ethers ──JSON-RPC, REST──▶ Fedrok node
                                                  ├─ Proof of Green consensus (JS): Bitcoin light client, slot leader,
                                                  │  generator signatures, fork choice, P2P gossip and sync
                                                  ├─ EVM execution (ethereumjs, Shanghai rules, EIP-1559 fees)
                                                  │    └─ system contracts deployed at genesis (contracts/*.sol)
                                                  └─ Indexer: contract events ▶ explorer and REST API views
```

| Contract | What it holds |
|---|---|
| `FedrokGovernance` | Admin, auditors, stablecoin issuer, fallback validator, network parameters |
| `FDKIssuer` | The fixed FDK supply cap; FDK is only released by Proof of Green (Piggy Bank pre-fill) and auditor back-minting |
| `FUSD` | ERC-20 settlement stablecoin (6 decimals), minted against reserve attestations |
| `CarbonRegistry` | ERC-1155 credit batches, serial double-count protection, retirements, backing vault |
| `CarbonMarketplace` | Escrowed listings priced in fUSD, atomic purchase |
| `ProofOfGreen` | Miner accreditation (Bitcoin signature checked on-chain), generators, stakes, links, the slot schedule and Piggy Bank |
| `LegacyGarden` | Personal Legacy Garden: gardens, dedications, planting batches, trees |

- **FDK is the native gas token.** Each block's base fee (`minGasPrice`) is burned; the priority tip goes to the block generator. FDK is never used as a payment between parties.
- **Every block starts with a system call** to `ProofOfGreen.onBlock` (like EIP-4788's beacon-root call) carrying the verified Bitcoin headers. The contract checks that the block's generator is the slot leader and pays the Piggy Bank production payment, so validators re-executing the block reject anything else.
- **Block headers** commit to the EVM state root, transaction and receipt roots, gas used, base fee, consensus mode, active miner and Bitcoin anchor, and are signed by the generator.
- Contract sources are in `contracts/`; `npm run compile` rebuilds `src/evm/artifacts.json` with solc 0.8.28.

## Token model: FDK is a utility token, payments use a stablecoin

| | FDK | fUSD (settlement stablecoin) |
|---|---|---|
| Purpose | Utility: gas for network fees, block generator staking, Proof of Green production payments (for producing blocks, not a return on holding FDK), protocol access, burn to record carbon consumption | All payments between parties, including every marketplace purchase |
| Created by | Piggy Bank pre-fill when an auditor accredits a green miner (23 FDK per S9-equivalent unit per year), or auditor back-minting 1 FDK per tonne of verified credits locked in the backing vault | The designated stablecoin issuer, against a reserve attestation reference |
| Priced in | Never priced or used as payment on the platform. Holding FDK earns nothing | 6 decimals, 1:1 USD (devnet stand-in) |

`fUSD` is a placeholder for whichever regulated stablecoin Fedrok selects (USD or CHF). It is an ERC-20 contract; its symbol and name are set in `devnet/genesis.json`, and the issuer address can be changed by governance (`gov_set_stable_issuer`).

## Personal Legacy Garden (prototype)

A memorial tree registry on Fedrok for the Bibiani Pilot Indigenous Tree Garden. Families, friends and institutions subscribe to dedicate an indigenous tree; every subscription, planting, GPS position, inspection and replacement is recorded on-chain.

![Legacy Garden](docs/screenshots/garden.png)

| On-chain (`contracts/LegacyGarden.sol`) | Off-chain (Garden records, fingerprint on-chain) |
|---|---|
| Garden, compartments, capacity, prices, accredited stewards | Customer contact details and consents |
| Dedications: holder account, package, plaque text (only with consent to display), GBP payment reference | Names without display consent (salted hash only) |
| Planting batches of 50: released when full, carried over to the next window if not | Photographs (SHA-256 fingerprint only) |
| Trees: Tree ID (`BITG-2026-A-001`), species, GPS, seed source, inspections, deaths and replacements | Signed subscribership agreement (hash only) |
| Annual maintenance renewals | |

Rules enforced by the contract:

- Only governance registers a Garden; only its operator accredits stewards; only the operator or a steward records subscriptions and field data.
- Subscribers never need FDK. The Garden signs every record and pays the FDK network fee. Payments are GBP (card or bank transfer, reference recorded once) or, optionally, the settlement stablecoin paid straight to the operator. FDK is never a payment.
- A tree can only be planted for a dedication in a **released** batch (50 paid). Closing a planting window with an unfilled batch moves its paid subscriptions to the next window.
- A Tree ID is unique, must match the garden code, a real compartment and the planting year. A tree that dies keeps its Tree ID and dedication; the replacement gets a new date and GPS. Replacement within 24 months is recorded as free; after that it must say how it is covered.
- Dedications cannot be transferred or traded.

Actions (each one a `LegacyGarden` contract call): `garden_register`, `garden_steward`, `dedication_create`, `planting_window_close`, `tree_plant`, `tree_monitor`, `tree_replace`, `maintenance_renew`. API: `/api/gardens`, `/api/garden/:id`, `/api/tree/:id`, `/api/dedication/:id`, `/api/dedications?holder=`. Web pages: **Legacy Garden** (site plan, batches, field records), tree page with a scannable QR tag, subscribership certificate, **My trees** member dashboard and a steward console. `npm run demo` (and the hosted demo) seed the Bibiani pilot with fictional sample data: 71 subscriptions, 50 trees planted, two replaced under guarantee, one batch carried over.

## How Proof of Green works here

1. An **auditor** accredits a Bitcoin miner after a green audit. The miner proves it controls its Bitcoin address by signing a link message with the Bitcoin key. Accreditation pre-fills the **Piggy Bank** with `units × 23 FDK × auditDays/365`.
2. Staked **block generators** link to miners (public miners accept anyone; private miners approve generators first).
3. Every Fedrok node runs a **Bitcoin light client**. Each Fedrok block carries the new Bitcoin headers, which every validator checks for linkage and proof of work.
4. When an accredited miner wins a Bitcoin block, that miner becomes active and **its generators take turns** producing Fedrok blocks in fixed time slots (round robin). A generator that misses its slot is replaced by the next one automatically. The `ProofOfGreen` contract enforces the slot leader on every block.
5. Each block releases a Piggy Bank production payment of `sum(active yearly allowances) × elapsed time / year`, split between the miner owner and the generator by the miner's generator share. This pays for producing blocks; it is not interest or a return on staked or held FDK. Priority tips go to the generator, base fees are burned.
6. If no green Bitcoin block arrives within `greenWindow` Bitcoin blocks, the governance-assigned **fallback validator** produces blocks until green mining resumes.
7. Revoking a miner burns the unserved part of its yearly allowance from the Piggy Bank. Accreditation expires at the end of the audit period.

## What's included

- **Solidity contracts** (`contracts/`): the seven system contracts above, deployed at genesis at fixed addresses (`/api/contracts`).
- **Node** (`src/node.js`, `src/evm/`): EVM execution, mempool with simulation before admission, Proof of Green block production, longest-chain fork choice with reorgs, WebSocket P2P gossip and sync, REST API, Ethereum JSON-RPC (`eth_*`, `net_*`, `web3_*`) plus Fedrok methods, and a live WebSocket feed.
- **Client SDK** (`src/core/client.js`, `src/evm/actions.js`): turns Fedrok actions (`market_buy`, `tree_plant`, …) into signed EIP-1559 contract calls with gas estimation and automatic fUSD approval. The same modules run in the browser for local signing.
- **Carbon registry**: auditor-issued credit batches with registry, methodology, vintage and serial range. A serial can only be tokenised once (double counting blocked on-chain). Transfers, retirements with printable certificates, and a backing vault.
- **Marketplace**: escrowed listings priced per tonne in fUSD, atomic purchase (stablecoin to seller, credits to buyer in one transaction), configurable platform fee paid in fUSD.
- **Web app** (`web/`): overview, explorer and search, wallet, marketplace, registry, retirement certificates, Proof of Green monitor, governance and auditor console, developer docs. Built to the Fedrok brand guidelines (Dark green, Sandy→Cinnabar gradient, Eerie black, Cream; Unbounded and Work Sans; 90° corners; outline icons; UK English).
- **Bitcoin simulator** (`src/btc/simulator.js`): a proof-of-work header chain with green and non-green miners for local networks.
- **Personal Legacy Garden** (`contracts/LegacyGarden.sol`, `src/core/garden-scenario.js`): memorial tree registry, see above.
- **Tests** (`test/`): Legacy Garden registry rules, settlement, stablecoin-only payments, double-counting protection, auditor permissions, Proof of Green mode switching and rewards, forged Bitcoin proofs, tampered blocks and governance checks.

## API

```bash
curl -s http://127.0.0.1:8545/api/status
curl -s http://127.0.0.1:8545/rpc -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}'
curl -s http://127.0.0.1:8545/rpc -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"carbon_getListings"}'
```

The full endpoint and method list is on the **Developers** page of the web app.

## Running a node by hand

```bash
node src/node.js --name=my-node --genesis=devnet/genesis.json --data=data/my-node \
  --api-port=8550 --p2p-port=30310 --peers=ws://127.0.0.1:30303 \
  --btc=http://127.0.0.1:18443 [--key=path/to/generator.key]
```

A node without `--key` is a full validating node that does not produce blocks.

## Decisions where the specification conflicted

The whitepaper (V1, 1 Aug 2025) contradicts the instruction that FDK is a utility token. This build follows the instruction:

- p.22 calls FDK "the native currency of the Fedrok blockchain" and gives "a final price target of approximately $0.2". FDK is the native gas token here, but it has no price target and nothing on the platform is priced in FDK.
- p.25 says developers use FDK "for transaction fees, payments, and on-chain interactions" and compares FDK to USDT (p.25–26). Here FDK covers fees and protocol access only; payments use the stablecoin.
- The summary (p.29) and brand glossary say "Fedrok Coins (FDKs)" / "FDK Coin". The UI says "FDK utility token".
- The spec also disagrees with itself on units: "1 FDK represents one tonne" vs "$0.2 ... offsetting one kilogram of CO₂", and p.24 defines a carbon credit as the right to emit one kilogram (the market standard is one tonne). This build uses 1 credit unit = 1 tCO₂e and 1 back-minted FDK = 1 tonne locked.
- The spec's block reward divides "the Piggy Bank balance" by seconds per year, which would shrink rewards every block. This build uses the sum of active miners' yearly reward amounts, which equals the pre-fill at accreditation and keeps emission steady.

## Devnet versus production

This is a complete, running EVM network suitable for demos, pilots and as the base for the production chain. The business logic already lives in Solidity contracts, so it moves to a production client unchanged. Before a public mainnet, plan for:

- **Production execution client.** Run the contracts on Geth or Reth with Proof of Green as the consensus engine (the `onBlock` system call maps onto a pre-block system contract call). Today's node replays blocks from genesis at start-up; a production client keeps a persistent state database.
- **Real Bitcoin light client** (SPV over real headers and coinbase outputs) in place of the simulator, and the standard Bitcoin `signmessage` format for miner link proofs.
- **Smart contract audit** of `contracts/` before mainnet.
- **Hardened consensus**: generator slashing for equivocation, finality checkpoints, and a minimum anchor-freshness rule across peers.
- **Key management**: governance and auditor keys in HSMs or multisig, and a production wallet (hardware or custodial) instead of browser-stored keys.
- **Regulated stablecoin** integration, FINMA review, security audit and penetration test, persistent indexed storage (LevelDB or Postgres) and monitoring.
- **Brand assets**: replace the PNG logo extracted from the guidelines PDF with the official SVG files.

## Project layout

```
contracts/      Solidity system contracts
src/evm/        EVM chain, genesis VM, indexer, actions, compiled artifacts
src/core/       crypto, units, Bitcoin header checks, genesis, SDK client, demo scenarios
src/node/       P2P, Bitcoin light client, REST and JSON-RPC server
src/btc/        Bitcoin network simulator
src/node.js     node entrypoint
scripts/        devnet launcher, end-to-end demo, contract compiler, hosted demo build
web/            explorer, wallet, marketplace and console (vanilla JS)
test/           protocol tests
docs/           screenshots
```
