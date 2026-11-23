# Fedrok Registry

A duplicate of the Fedrok platform, reshaped as a simple **digital ledger for environmental data**: a place where people register the environmental projects they run, or propose the ones they would like to see happen. It lives in its own folder and leaves the main Fedrok platform (the repository root) untouched.

> **Changing the world, one small project at a time.**

What is different from the main platform:

| Main platform | Fedrok Registry |
|---|---|
| Carbon registry (credit batches, retirements, back-minting) | Removed |
| Proof of Green consensus (Bitcoin anchor, green miners, Piggy Bank) | Removed. Blocks are produced by a small set of authority validators (Proof of Authority), held in the governance contract |
| Carbon marketplace | Replaced by **Register your project / Propose a project**, starting from a dropdown of 19 environmental project types |
| | New: **project pages**, built with **Sprout**, an AI project guide powered by Claude |
| | New: **Lock & submit**: a project becomes permanently read-only, enforced by the contract; the owner can still retire it |
| Legacy Garden, explorer, wallet, stablecoin, developer page | Kept |

## Hosted demo

`npm run build:demo` builds `dist/fedrok-registry-demo.html`: the full web app plus a complete network running inside the browser (three authority validators, the EVM with the registry contracts, faucet and demo data). Each visitor gets their own network, saved in their browser. The build seeds it with demo projects first, so the page opens on a working registry. Pick a demo identity on the **Wallet** page, or create a wallet and press **Get devnet FDK**.

## Quick start

Requires Node.js 20.10 or newer. Run everything from this folder.

```bash
cd registry
npm install
npm run devnet -- --reset   # 3 Fedrok validator nodes (Zurich, Geneva, Zug)
npm run demo                # in a second terminal: demo projects and the Legacy Garden
```

Open **http://127.0.0.1:8545**. To give Sprout a Claude connection for every visitor, start the devnet with an API key in the environment (see below). Run the tests with `npm test`.

## How a project works

1. **Register or propose.** On **Register a project**, choose *Register your project* (you run it) or *Propose a project* (an idea), pick the environmental project type from the dropdown, and give it a name. This creates a **draft** record on-chain, owned by your wallet.
2. **Sprout interviews you.** You land on the new project page and Sprout opens by itself. It asks about the project one topic at a time (objectives, activities, location, beneficiaries, expected impact, monitoring, land tenure, partners, budget, risks, SDGs and more) and saves each answer to the project record as an on-chain revision.
3. **Change it any time.** While the project is a draft, talk to Sprout ("change the start date to March 2027", "add WWF Kenya as a partner") or use **Edit by hand**. Every change is a transaction in the project's public history.
4. **Lock & submit.** When the record is complete, press **Lock & submit**. The ProjectRegistry contract stores a fingerprint of the final content and from then on rejects every change, from anyone: the owner, governance, and Sprout (which signs with the owner's key). The page also stops offering Sprout its edit tool.
5. **Retire.** A locked (or draft) project can still be retired with a public reason. Its content stays on the ledger unchanged.

Rules enforced by `contracts/ProjectRegistry.sol`:

- Only listed project types can be used; governance can add types.
- Only the owner can edit, lock or retire a project. Governance cannot edit anyone's project.
- `updateProject` reverts with *"project is locked and submitted: it can no longer be changed"* once a project is locked or retired.
- `lockAndSubmit` needs a summary and details, and the fingerprint of the content the owner reviewed, so nobody can slip in a change between review and lock.
- `retire` needs a reason and works once.

## Sprout, the AI project guide

Sprout runs in the browser on each project page (`web/sprout.js`) and calls the Claude API (`claude-opus-5-5`) with two tools of its own:

| Tool | What it does |
|---|---|
| `get_project` | Reads the current on-chain record and the fields that are still empty |
| `update_project` | Saves changes as one `project_update` transaction signed by the owner's wallet. Offered only while the project is a draft and the owner's wallet is active |

Sprout has no lock or retire tool: those are buttons for the owner. It can also read pages on **fedrok.com** with Claude's web fetch tool (restricted to that domain) to answer questions about Fedrok, and the panel links to the site.

### Connecting Sprout to Claude

Sprout picks the first connection that is available:

1. **Node proxy (recommended for a shared site).** Start the node with `ANTHROPIC_API_KEY` set, e.g. `ANTHROPIC_API_KEY=sk-ant-... npm run devnet -- --reset`. The node then serves `POST /api/assistant/v1/messages` and forwards Sprout's requests to Claude with a fixed model, a token cap, a tool allowlist and a simple rate limit. Visitors need no key, and the key never reaches a browser.
2. **Your own API key.** On a static host (such as the GitHub Pages preview) there is no server to hold a key. Open Sprout's settings (gear icon) and paste an Anthropic API key. It is stored only in that browser and sent only to `api.anthropic.com`. Use a key with a spending limit.
3. **Guided mode.** With neither, Sprout still runs a scripted interview without AI, and still saves every answer on-chain, so the demo works offline.

## Architecture

```
 Web app + Sprout ──REST, JSON-RPC──▶ Fedrok node
        │                             ├─ Proof of Authority: validator set from FedrokGovernance,
        │                             │  one slot leader per block time, P2P gossip and sync
        │                             ├─ EVM execution (ethereumjs, Shanghai rules, EIP-1559 fees)
        │                             │    └─ system contracts deployed at genesis (contracts/*.sol)
        │                             ├─ Indexer: contract events ▶ explorer and REST views
        └──── Claude API ◀────────────┴─ optional /api/assistant proxy (ANTHROPIC_API_KEY)
```

| Contract | What it holds |
|---|---|
| `FedrokGovernance` | Admin, stablecoin issuer, the authority validator set, network parameters |
| `FDKIssuer` | The fixed FDK supply cap (FDK pays network fees) and burns |
| `FUSD` | ERC-20 settlement stablecoin stand-in (6 decimals) |
| `ProjectRegistry` | Project types, projects, revisions, lock & submit, retirement |
| `LegacyGarden` | Personal Legacy Garden: gardens, dedications, planting batches, trees |

Every node re-executes each block and rejects it if it was sealed by anyone other than the slot's validator, or if the state root, receipts or fees differ. Contract sources are in `contracts/`; `npm run compile` rebuilds `src/evm/artifacts.json` with solc 0.8.28.

API additions: `/api/projects?type=&status=&kind=&owner=`, `/api/project/:id`, `/api/project-types`, `/api/validators`; JSON-RPC `registry_getProjects`, `registry_getProject`, `poa_getValidators`. Actions: `project_create`, `project_update`, `project_lock`, `project_retire`, `gov_add_project_type`, `gov_add_validator`, `gov_remove_validator`.

## Personal Legacy Garden

Unchanged from the main platform: the memorial tree registry for the Bibiani pilot, with 120 sample subscriptions seeded in the demo. See the main README for its rules.
