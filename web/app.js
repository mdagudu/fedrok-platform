// Fedrok Network web app: explorer, wallet, marketplace, registry,
// Proof of Green monitor, governance/auditor console and developer docs.
// Vanilla ES modules. Every action is an ordinary EIP-1559 Ethereum
// transaction to a Fedrok system contract, signed in the browser.
import { FedrokClient } from '/core/client.js';
import { generatePrivateKey, addressFromPrivate, isAddress, signRecoverable, btcLinkMessage, sha256Hex } from '/core/crypto.js';
import { qrSvg } from './qr.js';
import { formatFdk, formatStable, formatTonnes, fdk, stable, tonnesToKg, parseUnits } from '/core/units.js';

const api = new FedrokClient('');
const app = document.getElementById('app');
let STATUS = null;
let currentRoute = '';
let liveTimer = null;
const LOCAL = window.FedrokLocal || null; // set by the hosted in-browser demo
const LOGO_POSITIVE = '/assets/logo-horizontal-positive.png';

// ------------------------------------------------------------------ icons
const I = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  wallet: '<rect x="3" y="6" width="18" height="13"/><path d="M3 10h18"/><path d="M16 14.5h2"/><path d="M6 6l9-3 1 3"/>',
  market: '<path d="M4 9l1.5-5h13L20 9"/><path d="M4 9h16v2a3 3 0 0 1-5.33 1.9A3 3 0 0 1 12 14a3 3 0 0 1-2.67-1.1A3 3 0 0 1 4 11z"/><path d="M5 14v6h14v-6"/><path d="M10 20v-4h4v4"/>',
  leaf: '<path d="M5 19c0-8 5-14 15-15-1 10-7 15-15 15z"/><path d="M5 19l8-8"/>',
  mine: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 3"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 9.5h4.5a1.75 1.75 0 0 1 0 3.5H10a1.75 1.75 0 0 0 0 3.5H15"/>',
  print: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8"/><path d="M7 14h10v7H7z"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  tree: '<path d="M12 21v-7"/><path d="M12 14c-4.2 0-7-2.6-7-6a7 7 0 0 1 14 0c0 3.4-2.8 6-7 6z"/><path d="M9.5 21h5"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.1 4.1 0 0 1 12 7.4a4.1 4.1 0 0 1 7.5 2.4C19.5 15.4 12 20 12 20z"/>',
};
const icon = (n, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${I[n]}</svg>`;

const NAV = [
  ['/', 'Overview', 'home'],
  ['/explorer', 'Explorer', 'cube'],
  ['/wallet', 'Wallet', 'wallet'],
  ['/market', 'Marketplace', 'market'],
  ['/registry', 'Carbon registry', 'leaf'],
  ['/garden', 'Legacy Garden', 'tree'],
  ['/member', 'My trees', 'heart'],
  ['/mining', 'Proof of Green', 'mine'],
  ['/console', 'Console', 'shield'],
  ['/developers', 'Developers', 'code'],
];

// ---------------------------------------------------------------- helpers
// Routes use plain hash names (#explorer, #block-12, #batch-CCB-000001) so links
// survive hosts that only pass simple fragments. Legacy #/path links still work.
const toHash = (path) => '#' + path.replace(/^\//, '').replace(/\//, '-');
function hashToPath(h) {
  const raw = decodeURIComponent((h || '').replace(/^#/, ''));
  if (!raw || raw === '/') return '/';
  if (raw.startsWith('/')) return raw.split('?')[0];
  const i = raw.indexOf('-');
  return i < 0 ? '/' + raw : '/' + raw.slice(0, i) + '/' + raw.slice(i + 1);
}
const go = (path) => { location.hash = toHash(path); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (a, n = 6) => (a ? `${a.slice(0, n + 2)}…${a.slice(-4)}` : '—');
const addrLink = (a, label) => (a ? `<a class="addr" href="#/address/${a}" title="${a}">${esc(label || short(a))}</a>` : '—');
const txLink = (h) => `<a class="addr" href="#/tx/${h}" title="${h}">${short(h, 8)}</a>`;
const blockLink = (n) => `<a href="#/block/${n}">#${Number(n).toLocaleString('en-GB')}</a>`;
const F = (v, d) => formatFdk(v, d ?? 2);
const S = (v) => { const x = formatStable(v, 2); const [w, f = ''] = x.split('.'); return `${w}.${f.padEnd(2, '0')}`; };
const T = (kg, d = 3) => formatTonnes(kg, d);
const SYM = () => STATUS?.stable?.symbol || 'fUSD';
function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString('en-GB');
}
const date = (ts) => new Date(ts).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const day = (ts) => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const TX_LABEL = {
  transfer: 'Transfer', fdk_burn: 'FDK burn', stable_mint: 'Stablecoin mint', stable_burn: 'Stablecoin redemption',
  credit_issue: 'Credit issuance', credit_transfer: 'Credit transfer', credit_retire: 'Credit retirement', fdk_back_mint: 'FDK back-mint',
  market_list: 'Market listing', market_buy: 'Market purchase', market_cancel: 'Listing cancelled',
  miner_accredit: 'Miner accreditation', miner_revoke: 'Miner revoked', miner_update: 'Miner update',
  generator_register: 'Generator stake', generator_link: 'Generator link', generator_approve: 'Generator approval', generator_unlink: 'Generator unlink', generator_exit: 'Generator exit',
  gov_add_auditor: 'Auditor added', gov_remove_auditor: 'Auditor removed', gov_set_fallback: 'Fallback validator set', gov_set_param: 'Parameter change', gov_set_stable_issuer: 'Stablecoin issuer set',
  garden_register: 'Garden registered', garden_steward: 'Garden steward', dedication_create: 'Tree dedication', planting_window_close: 'Planting window closed',
  tree_plant: 'Tree planted', tree_monitor: 'Tree inspection', tree_replace: 'Tree replaced', maintenance_renew: 'Maintenance renewal',
  stable_approve: 'Stablecoin approval', evm_call: 'Contract call', contract_deploy: 'Contract deployment',
};
const txPill = (t) => `<span class="pill ${t.startsWith('market') || t.startsWith('stable') ? 'grad' : t.startsWith('credit') || t === 'fdk_back_mint' || t.startsWith('tree') || t.startsWith('garden') || t === 'dedication_create' || t === 'planting_window_close' || t === 'maintenance_renew' ? 'green' : 'grey'}">${esc(TX_LABEL[t] || t)}</span>`;
const modePill = (m) => (m === 'green' ? '<span class="pill green"><span class="d"></span>Green</span>' : '<span class="pill warn"><span class="d"></span>Fallback</span>');
const table = (head, rows, empty = 'Nothing here yet.') =>
  rows.length
    ? `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th class="${h.startsWith('#') ? 'num' : ''}">${esc(h.replace(/^#/, ''))}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : `<div class="empty">${empty}</div>`;
const kpi = (label, value, sub = '', cls = '') => `<div class="kpi ${cls}"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
const head = (eyebrow, title, lede = '', right = '') => `<div class="page-head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${lede ? `<p class="lede">${lede}</p>` : ''}</div>${right}</div>`;

function toast(html, kind = '', ms = 6000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = html;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ----------------------------------------------------------------- wallet
const WKEY = 'fedrok.wallets.v1';
const Wallet = {
  mem: null,
  list() {
    try {
      const v = localStorage.getItem(WKEY);
      if (v) return JSON.parse(v);
    } catch {}
    return this.mem ? structuredClone(this.mem) : { items: [], active: null };
  },
  save(w) {
    this.mem = structuredClone(w);
    try {
      localStorage.setItem(WKEY, JSON.stringify(w));
    } catch {}
  },
  add(name, privKey) {
    const w = this.list();
    const address = addressFromPrivate(privKey);
    if (!w.items.find((i) => i.address === address)) w.items.push({ name, privKey, address });
    w.active = address;
    this.save(w);
    return address;
  },
  active() {
    const w = this.list();
    return w.items.find((i) => i.address === w.active) || null;
  },
  select(address) {
    const w = this.list();
    w.active = address;
    this.save(w);
  },
  remove(address) {
    const w = this.list();
    w.items = w.items.filter((i) => i.address !== address);
    if (w.active === address) w.active = w.items[0]?.address || null;
    this.save(w);
  },
};

async function submit(type, payload, label) {
  const w = Wallet.active();
  if (!w) {
    toast('Create or import a wallet first.', 'err');
    go('/wallet');
    return null;
  }
  try {
    const { hash } = await api.send(w.privKey, type, payload);
    toast(`${esc(label)} submitted · ${txLink(hash)}`);
    const r = await api.wait(hash, 45_000);
    toast(`${esc(label)} confirmed in block ${blockLink(r.height)}`, 'ok');
    render();
    return r;
  } catch (e) {
    toast(`${esc(label)} failed: ${esc(e.message)}`, 'err', 9000);
    return null;
  }
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// -------------------------------------------------------------- overview
async function viewOverview() {
  const [blocks, btc, listings, retirements] = await Promise.all([api.get('/api/blocks?limit=8'), api.get('/api/btc?limit=8'), api.get('/api/listings'), api.get('/api/retirements')]);
  const s = STATUS;
  const sched = s.schedule;
  const tokenised = BigInt(s.supply.creditsIssued);
  const retired = BigInt(s.supply.creditsRetired);
  const pctRetired = tokenised > 0n ? Number((retired * 1000n) / tokenised) / 10 : 0;
  const seed = LOCAL?.seed;
  const banner = LOCAL
    ? `<div class="note no-print" style="margin-bottom:18px"><b>Hosted demo.</b> This page runs a complete Fedrok network in your browser: a simulated Bitcoin chain, a validating node with three block generators, and the same protocol and API code as a server node. Your data stays in this browser. ${seed.running ? `<br><b>Setting up demo data…</b> ${esc(seed.lines.filter((l) => l.startsWith('✓') || l.startsWith('▸')).slice(-1)[0] || 'starting')}` : ''}<div class="actions" style="margin-top:10px"><a class="btn sm" href="#/wallet">Try it: pick a demo identity</a><button class="btn ghost sm" id="reset-net">Reset network</button></div></div>`
    : '';
  return `${banner}
  <section class="hero">
    <div class="ring"></div><div class="disc"></div>
    <div class="eyebrow" style="color:var(--sandy)">Fedrok EVM Layer 1 · chain ${esc(s.chainId)} · ${esc(s.network)}</div>
    <h1>Changing the world, one small project at a time.</h1>
    <p>An EVM-compatible blockchain for environmental asset records: authorised registries issue, transfer and retire verified credits through Solidity contracts. Blocks are produced under Proof of Green, and every purchase settles in ${esc(SYM())} stablecoin.</p>
    <div class="mode">${sched.mode === 'green' ? icon('leaf') : icon('shield')} <span>${sched.mode === 'green' ? `Green mode · active miner <a style="color:#fff;text-decoration:underline" href="#/miner/${sched.miner}">${esc(sched.miner)}</a>` : 'Fallback validator producing blocks until a green miner wins a Bitcoin block'}</span></div>
  </section>
  <div class="grid g4">
    ${kpi('Block height', Number(s.height).toLocaleString('en-GB'), `every ${(s.params.blockTimeMs / 1000).toFixed(0)} s · ${s.peers.length} peers`, 'green')}
    ${kpi('Tokenised carbon', `${T(tokenised, 0)}<small>tCO₂e</small>`, `${Object.keys(s.counters).length ? s.counters.batches : 0} verified batches`)}
    ${kpi('Retired', `${T(retired, 0)}<small>tCO₂e</small>`, `${pctRetired}% of tokenised credits`)}
    ${kpi('Green miners', s.activeMiners, `${s.pog.greenBlocksSeen} green Bitcoin blocks seen`, 'green')}
  </div>
  <div class="grid g4 section" style="margin-top:18px">
    ${kpi('FDK utility supply', `${F(s.fdkCirculating, 0)}<small>FDK</small>`, 'utility token, not a currency')}
    ${kpi('Piggy Bank', `${F(s.piggyBank, 0)}<small>FDK</small>`, `${F(s.yearlyEmission, 0)} FDK / year to green miners`)}
    ${kpi(`${esc(SYM())} in circulation`, `${S(BigInt(s.supply.stableMinted) - BigInt(s.supply.stableBurned))}`, 'settlement stablecoin')}
    ${kpi('Bitcoin anchor', s.btc.tip ? `#${s.btc.tip.height}` : '—', s.btc.synced ? 'light client in sync' : 'syncing…', 'green')}
  </div>
  <div class="grid g2 section">
    <div class="card"><h2>Latest blocks <a class="aside" href="#/explorer">View all</a></h2>
      <div class="feed">${blocks.map((b) => `<div class="feed-item"><div class="blockbadge ${b.mode === 'green' ? 'g' : ''}">${b.height}</div><div><div>${modePill(b.mode)} <span class="small muted">by</span> ${addrLink(b.generator)}</div><div class="small muted">${b.txCount} tx · ${Number(b.gasUsed || 0).toLocaleString('en-GB')} gas · BTC anchor #${b.btcAnchor.height}</div></div><div class="small muted">${ago(b.timestamp)}</div></div>`).join('') || '<div class="empty">Waiting for the first block…</div>'}</div>
    </div>
    <div class="card"><h2>Bitcoin anchor feed <a class="aside" href="#/mining">Proof of Green</a></h2>
      <div class="feed">${btc.map((h) => `<div class="feed-item"><div class="blockbadge ${h.green ? 'g' : ''}">${h.height}</div><div><div>${h.green ? `<span class="pill green"><span class="d"></span>Green</span> <a href="#/miner/${h.minerId}">${esc(h.minerName)}</a>` : '<span class="pill grey">Not accredited</span> <span class="addr muted">' + esc(short(h.minerAddress, 10)) + '</span>'}</div><div class="small muted mono">${short(h.hash, 12)}</div></div><div class="small muted">${ago(h.time)}</div></div>`).join('')}</div>
    </div>
  </div>
  <div class="grid g2 section">
    <div class="card"><h2>Open marketplace listings <a class="aside" href="#/market">Marketplace</a></h2>
      ${table(['Project', 'Vintage', '#Available', `#Price / t`], listings.slice(0, 5).map((l) => `<tr><td><a href="#/batch/${l.batchId}">${esc(l.batch.project)}</a><div class="small muted">${esc(l.batch.country)} · ${esc(l.batch.registry)}</div></td><td>${l.batch.vintage}</td><td class="num">${T(l.remainingKg, 0)} t</td><td class="num">${S(l.pricePerTonne)} ${esc(SYM())}</td></tr>`), 'No open listings yet.')}
    </div>
    <div class="card"><h2>Recent retirements <a class="aside" href="#/registry">Registry</a></h2>
      ${table(['Certificate', 'Beneficiary', '#Tonnes'], retirements.slice(0, 5).map((r) => `<tr><td><a href="#/retirement/${r.id}">${r.id}</a><div class="small muted">${esc(r.batch.project)}</div></td><td>${esc(r.beneficiary)}</td><td class="num">${T(r.quantityKg, 0)} t</td></tr>`), 'No retirements yet.')}
    </div>
  </div>
  <div class="grid g3 section">
    <div class="card feature">${icon('target', 'icon-outline')}<div><h3>Impact before hype</h3><p>Every credit is issued by an accredited auditor with its registry serial on-chain, so double counting is blocked at protocol level.</p></div></div>
    <div class="card feature">${icon('check', 'icon-outline')}<div><h3>Transparency creates trust</h3><p>Issuance, trades and retirements are public and auditable in real time. Retirement certificates are verifiable by anyone.</p></div></div>
    <div class="card feature">${icon('coin', 'icon-outline')}<div><h3>Stablecoin settlement</h3><p>Payments settle in ${esc(SYM())}. FDK is a utility token for staking, network fees and protocol access, never a means of payment.</p></div></div>
  </div>
  <a class="card feature section" href="#/garden" style="display:flex;margin-top:18px;text-decoration:none">${icon('tree', 'icon-outline')}<div><h3>Personal Legacy Garden · Bibiani pilot</h3><p>Dedicated memorial trees recorded on Fedrok: every subscription, planting, GPS position, inspection and replacement, with a QR tag on each tree. Open the Garden →</p></div></a>`;
}

// -------------------------------------------------------------- explorer
async function viewExplorer() {
  const [blocks, txs] = await Promise.all([api.get('/api/blocks?limit=25'), api.get('/api/txs')]);
  return `${head('Explorer', 'Blocks and transactions', 'Search by block number, block or transaction hash, address, batch (CCB-…), retirement (RET-…), miner (MNR-…), tree (BITG-2026-A-001) or dedication (DED-…).', `<form class="search" id="search"><input name="q" placeholder="Search the Fedrok chain" aria-label="Search"><button class="btn">Search</button></form>`)}
  <div class="grid g2">
    <div class="card"><h2>Blocks</h2>${table(['Block', 'Mode', 'Generator', '#Tx', '#Age'], blocks.map((b) => `<tr><td>${blockLink(b.height)}</td><td>${modePill(b.mode)}</td><td>${addrLink(b.generator)}</td><td class="num">${b.txCount}</td><td class="num muted">${ago(b.timestamp)}</td></tr>`))}</div>
    <div class="card"><h2>Transactions</h2>${table(['Hash', 'Type', 'From', '#Block'], txs.map((t) => `<tr><td>${txLink(t.hash)}</td><td>${txPill(t.type)}</td><td>${addrLink(t.from)}</td><td class="num">${blockLink(t.height)}</td></tr>`), 'No transactions yet.')}</div>
  </div>`;
}

async function viewBlock(id) {
  const b = await api.get('/api/block/' + id);
  const h = b.header;
  return `${head('Block', `Block #${h.height.toLocaleString('en-GB')}`, '', `<div class="actions">${h.height > 1 ? `<a class="btn ghost sm" href="#/block/${h.height - 1}">← Previous</a>` : ''}<a class="btn ghost sm" href="#/block/${h.height + 1}">Next →</a></div>`)}
  <div class="card"><div class="kv">
    <div>Hash</div><div class="mono">${b.hash}</div>
    <div>Parent</div><div class="mono">${h.height > 1 ? `<a href="#/block/${h.height - 1}">${h.prevHash}</a>` : h.prevHash}</div>
    <div>Timestamp</div><div>${date(h.timestamp)} (${ago(h.timestamp)}) · slot ${h.slot}</div>
    <div>Consensus</div><div>${modePill(h.mode)} ${h.activeMiner ? `active miner <a href="#/miner/${h.activeMiner}">${h.activeMiner}</a>` : 'fallback validator'}</div>
    <div>Block generator</div><div>${addrLink(h.generator, h.generator)}</div>
    <div>Bitcoin anchor</div><div>#${h.btcAnchor.height} · <span class="mono">${short(h.btcAnchor.hash, 14)}</span> · ${b.btcHeaders.length} new header(s) verified</div>
    <div>Piggy Bank production payment</div><div>${F(h.reward, 6)} FDK</div>
    <div>Gas used</div><div>${Number(h.gasUsed || 0).toLocaleString('en-GB')} · base fee ${F(h.baseFeePerGas || 0, 9)} FDK/gas</div>
    <div>State root</div><div class="mono small">${esc(h.stateRoot || '')}</div>
    <div>Network fees</div><div>${F(h.fees, 6)} FDK</div>
    <div>Transaction root</div><div class="mono">${h.txRoot}</div>
    <div>State root</div><div class="mono">${h.stateRoot}</div>
    <div>Signature</div><div class="mono small">${short(b.sig, 30)}</div>
  </div></div>
  <div class="card section"><h2>Transactions <span class="aside">${b.txs.length}</span></h2>${table(['Hash', 'Type', 'From', '#Fee (FDK)'], b.txs.map((t) => `<tr><td>${txLink(t.hash)}</td><td>${txPill(t.type)}</td><td>${addrLink(t.from)}</td><td class="num">${F(t.fee, 4)}</td></tr>`), 'No transactions in this block.')}</div>`;
}

function describeEvent(ev) {
  const sym = SYM();
  switch (ev.event) {
    case 'Transfer': return `${ev.asset === 'FDK' ? F(ev.amount, 4) + ' FDK' : S(ev.amount) + ' ' + sym} from ${addrLink(ev.from)} to ${addrLink(ev.to)}`;
    case 'StableMinted': return `${S(ev.amount)} ${sym} minted to ${addrLink(ev.to)} · reserve: ${esc(ev.reserveRef)}`;
    case 'StableRedeemed': return `${S(ev.amount)} ${sym} redeemed`;
    case 'CreditsIssued': return `${T(ev.quantityKg)} t issued as <a href="#/batch/${ev.batchId}">${ev.batchId}</a> to ${addrLink(ev.to)}`;
    case 'CreditsTransferred': return `${T(ev.quantityKg)} t of <a href="#/batch/${ev.batchId}">${ev.batchId}</a> to ${addrLink(ev.to)}`;
    case 'CreditsRetired': return `${T(ev.quantityKg)} t retired for ${esc(ev.beneficiary)} · <a href="#/retirement/${ev.retirementId}">certificate ${ev.retirementId}</a>`;
    case 'FdkBackMinted': return `${T(ev.quantityKg)} t of <a href="#/batch/${ev.batchId}">${ev.batchId}</a> locked, ${F(ev.amount)} FDK minted`;
    case 'Listed': return `${ev.listingId}: ${T(ev.quantityKg)} t of <a href="#/batch/${ev.batchId}">${ev.batchId}</a> at ${S(ev.pricePerTonne)} ${sym}/t`;
    case 'Purchased': return `${T(ev.quantityKg)} t of <a href="#/batch/${ev.batchId}">${ev.batchId}</a> bought for ${S(ev.paid)} ${esc(ev.currency)} (platform fee ${S(ev.platformFee)})`;
    case 'MinerAccredited': return `<a href="#/miner/${ev.minerId}">${ev.minerId}</a> accredited (${ev.units} units), Piggy Bank +${F(ev.piggyBankPrefill)} FDK`;
    case 'GeneratorRegistered': return `${addrLink(ev.generator)} staked ${F(ev.stake)} FDK`;
    case 'GardenRegistered': return `<a href="#/garden">${esc(ev.gardenId)}</a> registered (${ev.capacity} trees, batches of ${ev.batchSize}), operator ${addrLink(ev.operator)}`;
    case 'StewardAccredited': return `${addrLink(ev.steward)} accredited as steward of ${esc(ev.gardenId)}`;
    case 'DedicationCreated': return `<a href="#/dedication/${ev.dedicationId}">${ev.dedicationId}</a> (${esc(ev.package)}) for ${addrLink(ev.holder)} · paid by ${esc(ev.method)} · batch ${esc(ev.batchId)}`;
    case 'BatchReleased': return `Batch ${esc(ev.batchId)} reached ${ev.trees} paid trees and is released for planting`;
    case 'BatchPlanted': return `Batch ${esc(ev.batchId)} fully planted (${ev.trees} trees)`;
    case 'PlantingWindowClosed': return `Planting window “${esc(ev.window)}” closed${ev.carriedOver ? `: ${ev.carriedOver} paid trees carried over to ${esc(ev.to)}` : ''}`;
    case 'TreePlanted': return `<a href="#/tree/${ev.treeId}">${ev.treeId}</a> (${esc(ev.species)}) planted on ${esc(ev.plantedOn)} for <a href="#/dedication/${ev.dedicationId}">${ev.dedicationId}</a>`;
    case 'TreeMonitored': return `<a href="#/tree/${ev.treeId}">${ev.treeId}</a> inspected on ${esc(ev.date)}: ${ev.heightCm} cm, ${esc(ev.health)}`;
    case 'TreeDied': return `<a href="#/tree/${ev.treeId}">${ev.treeId}</a> recorded as dead on ${esc(ev.date)} (${esc(ev.cause)})`;
    case 'TreeReplaced': return `<a href="#/tree/${ev.treeId}">${ev.treeId}</a> replaced on ${esc(ev.plantedOn)}${ev.underGuarantee ? ' under the free-replacement guarantee' : ''}`;
    case 'MaintenanceRenewed': return `Maintenance for <a href="#/dedication/${ev.dedicationId}">${ev.dedicationId}</a> recorded for ${ev.year}`;
    case 'GeneratorLinked': return `${addrLink(ev.generator)} linked to <a href="#/miner/${ev.minerId}">${ev.minerId}</a>`;
    default: return `<span class="mono small">${esc(JSON.stringify(ev))}</span>`;
  }
}

async function viewTx(hash) {
  const t = await api.get('/api/tx/' + hash);
  if (t.status === 'rejected') return `${head('Transaction', 'Rejected')}<div class="note">This transaction was rejected by the block producer: <b>${esc(t.error)}</b></div>`;
  const tx = t.tx;
  const contract = Object.entries(STATUS.contracts || {}).find(([, a]) => a === tx.to)?.[0];
  return `${head('Transaction', TX_LABEL[tx.type] || tx.type)}
  <div class="card"><div class="kv">
    <div>Hash</div><div class="mono">${tx.hash}</div>
    <div>Status</div><div>${t.status === 'confirmed' ? `<span class="pill green"><span class="d"></span>Confirmed</span> in ${blockLink(t.height)} · ${t.confirmations} confirmation(s)` : t.status === 'failed' ? `<span class="pill grey">Reverted</span> in ${blockLink(t.height)}: <b>${esc(t.error)}</b>` : '<span class="pill grad">Pending</span>'}</div>
    ${t.timestamp ? `<div>Time</div><div>${date(t.timestamp)}</div>` : ''}
    <div>From</div><div>${addrLink(tx.from, tx.from)}</div>
    <div>To</div><div>${tx.to ? `${contract ? `<span class="pill grey">${esc(contract)}</span> ` : ''}${addrLink(tx.to, tx.to)}` : 'contract creation'}</div>
    <div>Nonce</div><div>${tx.nonce}</div>
    <div>Gas</div><div>${t.gasUsed ? `${Number(t.gasUsed).toLocaleString('en-GB')} used of ${Number(tx.gasLimit).toLocaleString('en-GB')}` : `limit ${Number(tx.gasLimit).toLocaleString('en-GB')}`}</div>
    <div>Network fee</div><div>${F(t.fee || tx.fee, 6)} FDK <span class="muted small">(gas, paid in the native utility token)</span></div>
    <div>Effects</div><div>${(t.events || []).map(describeEvent).join('<br>') || '—'}</div>
  </div></div>
  <div class="grid g2 section">
    <div class="card"><h2>Decoded action</h2><pre class="code">${esc(JSON.stringify(tx.payload, null, 2))}</pre></div>
    <div class="card"><h2>EVM transaction</h2><pre class="code">${esc(JSON.stringify({ type: tx.evmType === 2 ? 'EIP-1559' : tx.evmType, to: tx.to, value: tx.value, input: tx.data.length > 202 ? tx.data.slice(0, 202) + '…' : tx.data, logs: (t.logs || []).length }, null, 2))}</pre></div>
  </div>`;
}

async function viewAddress(addr) {
  const a = await api.account(addr);
  const mine = Wallet.active()?.address === addr;
  return `${head('Address', mine ? 'Your account' : 'Account', `<span class="mono">${addr}</span>`)}
  <div class="grid g4">
    ${kpi('FDK (utility)', F(a.fdk, 4), 'fees, staking, protocol access', 'green')}
    ${kpi(esc(SYM()), S(a.stable), 'settlement stablecoin')}
    ${kpi('Carbon credits', `${T(a.credits.reduce((s, c) => s + BigInt(c.kg), 0n), 0)}<small>t</small>`, `${a.credits.length} batch(es)`, 'green')}
    ${kpi('Roles', a.roles.length ? a.roles.map((r) => `<span class="pill green" style="margin:2px">${r}</span>`).join('') : '<span class="muted small">none</span>', `nonce ${a.nonce}`)}
  </div>
  <div class="grid g2 section">
    <div class="card"><h2>Carbon credit holdings</h2>${table(['Batch', 'Project', '#Tonnes'], a.credits.map((c) => `<tr><td><a href="#/batch/${c.batchId}">${c.batchId}</a></td><td>${esc(c.batch.project)}<div class="small muted">${c.batch.vintage} · ${esc(c.batch.registry)}</div></td><td class="num">${T(c.kg)}</td></tr>`), 'No credits held.')}</div>
    ${a.dedications?.length ? `<div class="card"><h2>Tree dedications</h2>${table(['Dedication', 'Name', 'Tree'], a.dedications.map((d) => `<tr><td><a href="#/dedication/${d.id}">${d.id}</a></td><td>${dname(d)}</td><td>${d.tree ? `<a href="#/tree/${d.tree.id}">${d.tree.id}</a>` : '<span class="muted small">awaiting planting</span>'}</td></tr>`))}</div>` : ''}
    <div class="card"><h2>Activity</h2>${table(['Tx', 'Type', '#Block'], a.history.filter(Boolean).slice(0, 25).map((h) => `<tr><td>${txLink(h.tx.hash)}</td><td>${txPill(h.tx.type)}</td><td class="num">${h.height ? blockLink(h.height) : 'pending'}</td></tr>`), 'No activity yet.')}</div>
  </div>`;
}

// ---------------------------------------------------------------- wallet
async function viewWallet() {
  const w = Wallet.list();
  const active = Wallet.active();
  const acct = active ? await api.account(active.address) : null;
  const holdings = acct ? acct.credits : [];
  return `${head('Wallet', 'Your Fedrok wallet', 'Keys are generated and stored in this browser and transactions are signed locally. This devnet wallet is for testing: use a hardware or custodial wallet for real value.')}
  ${LOCAL ? `<div class="card" style="margin-bottom:18px"><h2>Demo identities <span class="aside">one click to act as each participant</span></h2><div class="grid g3">${LOCAL.demoIdentities.map((d) => { const a = addressFromPrivate(d.key); return `<div class="feature" style="border:1px solid var(--line);padding:14px">${icon(a === active?.address ? 'check' : 'wallet', 'icon-outline')}<div><h3>${esc(d.name)}</h3><p>${esc(d.role)}</p><button class="btn sm ${a === active?.address ? 'ghost' : ''}" style="margin-top:10px" data-demo="${esc(d.name)}" ${a === active?.address ? 'disabled' : ''}>${a === active?.address ? 'Active' : 'Use this identity'}</button></div></div>`; }).join('')}</div></div>` : ''}
  ${active ? `
  <div class="grid g4">
    ${kpi('FDK (utility token)', F(acct.fdk, 4), 'network fees · staking · protocol access', 'green')}
    ${kpi(esc(SYM()) + ' (stablecoin)', S(acct.stable), 'used for all payments')}
    ${kpi('Carbon credits', `${T(holdings.reduce((s, c) => s + BigInt(c.kg), 0n), 0)}<small>t</small>`, `${holdings.length} batch(es)`, 'green')}
    ${kpi('Account', `<span class="mono" style="font-size:14px">${short(active.address, 8)}</span>`, `${esc(active.name)} · ${acct.roles.join(', ') || 'no roles'}`)}
  </div>
  <div class="actions section" style="margin-top:16px">
    <a class="btn ghost sm" href="#/address/${active.address}">View on explorer</a>
    <button class="btn ghost sm" id="copy-addr">Copy address</button>
    ${STATUS.faucet ? '<button class="btn accent sm" id="faucet">Get devnet FDK and ' + esc(SYM()) + '</button>' : ''}
  </div>
  <div class="grid g2 section">
    <div class="card"><h2>Send</h2>
      <form class="stack" id="send">
        <label>Recipient address<input name="to" placeholder="0x…" required></label>
        <div class="row">
          <label>Asset<select name="asset"><option value="STABLE">${esc(SYM())} (payment)</option><option value="FDK">FDK (utility)</option></select></label>
          <label>Amount<input name="amount" inputmode="decimal" placeholder="0.00" required></label>
        </div>
        <div class="actions"><button class="btn">Sign and send</button><span class="small muted">Gas: ${F(BigInt(STATUS.params.minGasPrice) * 2n, 9)} FDK per gas at most</span></div>
      </form>
    </div>
    <div class="card"><h2>Retire or transfer credits</h2>
      <form class="stack" id="retire">
        <label>Batch<select name="batchId" required>${holdings.map((c) => `<option value="${c.batchId}">${c.batchId} · ${esc(c.batch.project)} (${T(c.kg, 0)} t)</option>`).join('') || '<option value="">No credits held</option>'}</select></label>
        <div class="row"><label>Tonnes<input name="tonnes" inputmode="decimal" required></label><label>Action<select name="action"><option value="retire">Retire (offset)</option><option value="transfer">Transfer</option></select></label></div>
        <label>Beneficiary or recipient<input name="beneficiary" placeholder="Organisation name, or 0x address for a transfer" required></label>
        <label>Retirement reason <span class="hint">shown on the certificate</span><input name="reason" placeholder="e.g. 2026 business travel emissions"></label>
        <div class="actions"><button class="btn" ${holdings.length ? '' : 'disabled'}>Submit</button></div>
      </form>
    </div>
  </div>
  <div class="grid g2 section">
    <div class="card"><h2>Pending and recent activity</h2>${table(['Tx', 'Type', '#Status'], [...acct.pending.map((p) => `<tr><td>${txLink(p.hash)}</td><td>${txPill(p.type)}</td><td class="num"><span class="pill grad">pending</span></td></tr>`), ...acct.history.filter(Boolean).slice(0, 12).map((h) => `<tr><td>${txLink(h.tx.hash)}</td><td>${txPill(h.tx.type)}</td><td class="num">${blockLink(h.height)}</td></tr>`)], 'No activity yet.')}</div>
    <div class="card"><h2>Use FDK</h2>
      <p class="small" style="margin-top:0">FDK is a utility token. Besides network fees you can stake it to become a block generator on the Proof of Green page, or burn it to record carbon consumed in your own processes.</p>
      <form class="stack" id="burn"><div class="row"><label>FDK to burn<input name="amount" inputmode="decimal" required></label><label>Reason<input name="reason" placeholder="Manufacturing consumption" required></label></div><div class="actions"><button class="btn ghost">Burn FDK</button></div></form>
    </div>
  </div>` : LOCAL ? `<div class="note plain">Pick a demo identity below to act as a buyer, auditor, governance or stablecoin issuer. You can also create a fresh wallet and fund it from the faucet.</div>` : `<div class="note plain">You don't have a wallet in this browser yet. Create a new one, or import a private key (for the devnet demo, keys are in <code>devnet/keys/</code>, for example <code>demo-buyer.key</code>).</div>`}
  <div class="grid g2 section">
    <div class="card"><h2>Wallets in this browser</h2>${table(['Name', 'Address', ''], w.items.map((i) => `<tr><td>${esc(i.name)} ${i.address === w.active ? '<span class="pill green">active</span>' : ''}</td><td>${addrLink(i.address)}</td><td class="num"><button class="btn ghost sm" data-select="${i.address}">Use</button> <button class="btn ghost sm" data-remove="${i.address}">Remove</button></td></tr>`), 'No wallets yet.')}</div>
    <div class="card"><h2>Add a wallet</h2>
      <form class="stack" id="create"><label>Name<input name="name" placeholder="e.g. Treasury" required></label><div class="actions"><button class="btn">Create new wallet</button></div></form>
      <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
      <form class="stack" id="import"><label>Name<input name="name" placeholder="e.g. Demo buyer" required></label><label>Private key<input name="key" placeholder="0x… (64 hex characters)" required autocomplete="off"></label><div class="actions"><button class="btn ghost">Import key</button></div></form>
    </div>
  </div>`;
}

function bindWallet() {
  const on = (id, fn) => document.getElementById(id)?.addEventListener('submit', (e) => { e.preventDefault(); fn(formData(e.target), e.target); });
  on('create', (d) => { Wallet.add(d.name, generatePrivateKey()); toast('Wallet created. Back up the key from your browser storage before using real value.', 'ok'); render(); });
  on('import', (d) => {
    try {
      const k = d.key.trim().startsWith('0x') ? d.key.trim() : '0x' + d.key.trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error('expected 64 hex characters');
      Wallet.add(d.name, k.toLowerCase());
      toast('Wallet imported.', 'ok');
      render();
    } catch (e) { toast('Import failed: ' + esc(e.message), 'err'); }
  });
  on('send', (d) => {
    const amount = d.asset === 'FDK' ? fdk(d.amount) : stable(d.amount);
    if (!isAddress(d.to.trim().toLowerCase())) return toast('Recipient must be a 0x address.', 'err');
    submit('transfer', { to: d.to.trim().toLowerCase(), asset: d.asset, amount: amount.toString() }, `Send ${d.amount} ${d.asset === 'FDK' ? 'FDK' : SYM()}`);
  });
  on('retire', (d) => {
    const kg = tonnesToKg(d.tonnes).toString();
    if (d.action === 'transfer') {
      const to = d.beneficiary.trim().toLowerCase();
      if (!isAddress(to)) return toast('For a transfer, enter a 0x address as recipient.', 'err');
      submit('credit_transfer', { batchId: d.batchId, to, quantityKg: kg }, `Transfer ${d.tonnes} t`);
    } else {
      submit('credit_retire', { batchId: d.batchId, quantityKg: kg, beneficiary: d.beneficiary, reason: d.reason || 'Voluntary offset' }, `Retire ${d.tonnes} t`).then((r) => {
        const id = r?.events?.[0]?.retirementId;
        if (id) go('/retirement/' + id);
      });
    }
  });
  on('burn', (d) => submit('fdk_burn', { amount: fdk(d.amount).toString(), reason: d.reason }, `Burn ${d.amount} FDK`));
  document.getElementById('faucet')?.addEventListener('click', async () => {
    try {
      await api.post('/api/faucet', { address: Wallet.active().address });
      toast('Faucet transfer submitted. Balances update in the next block.', 'ok');
      setTimeout(render, 3500);
    } catch (e) { toast(esc(e.message), 'err'); }
  });
  document.getElementById('copy-addr')?.addEventListener('click', () => { Promise.resolve(navigator.clipboard?.writeText(Wallet.active().address)).then(() => toast('Address copied.'), () => toast('Copy failed. Address: ' + esc(Wallet.active().address))); });
  document.querySelectorAll('[data-demo]').forEach((b) => b.addEventListener('click', () => {
    const d = LOCAL.demoIdentities.find((x) => x.name === b.dataset.demo);
    Wallet.add(d.name, d.key);
    toast(`Now acting as ${esc(d.name)}.`, 'ok');
    render();
  }));
  document.querySelectorAll('[data-select]').forEach((b) => b.addEventListener('click', () => { Wallet.select(b.dataset.select); render(); }));
  document.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => { Wallet.remove(b.dataset.remove); render(); }));
}

// ----------------------------------------------------------- marketplace
async function viewMarket() {
  const listings = await api.get('/api/listings');
  const active = Wallet.active();
  const acct = active ? await api.account(active.address) : null;
  const totalT = listings.reduce((s, l) => s + BigInt(l.remainingKg), 0n);
  return `${head('Marketplace', 'Carbon credit marketplace', `Peer-to-peer trading of tokenised carbon credits. Prices and payments are in ${esc(SYM())} stablecoin; FDK is only used for the network fee.`)}
  <div class="grid g4">
    ${kpi('Open listings', listings.length, '', 'green')}
    ${kpi('Credits for sale', `${T(totalT, 0)}<small>t</small>`)}
    ${kpi('Your balance', acct ? `${S(acct.stable)}<small>${esc(SYM())}</small>` : '—', active ? 'available for purchases' : 'connect a wallet', 'green')}
    ${kpi('Platform fee', `${(STATUS.params.marketFeeBps / 100).toFixed(2)}%`, `paid by sellers in ${esc(SYM())}`)}
  </div>
  <div class="card section"><h2>Listings</h2>
    ${table(['Listing', 'Project', 'Type', 'Vintage', '#Available', '#Price / t', ''], listings.map((l) => `<tr>
      <td>${l.id}<div class="small muted">by ${addrLink(l.seller)}</div></td>
      <td><a href="#/batch/${l.batchId}">${esc(l.batch.project)}</a><div class="small muted">${esc(l.batch.country)} · ${esc(l.batch.registry)}</div></td>
      <td>${esc(l.batch.projectType)}</td><td>${l.batch.vintage}</td>
      <td class="num">${T(l.remainingKg, 0)} t</td><td class="num"><b>${S(l.pricePerTonne)}</b> ${esc(SYM())}</td>
      <td class="num">${active && active.address !== l.seller ? `<form class="buy actions" data-id="${l.id}" data-price="${l.pricePerTonne}" style="justify-content:flex-end;flex-wrap:nowrap"><input name="t" inputmode="decimal" placeholder="t" style="width:84px" required><button class="btn sm">Buy</button></form>` : active ? `<button class="btn ghost sm" data-cancel="${l.id}">Cancel</button>` : ''}</td></tr>`), 'No open listings. Credits appear here once holders list them.')}
  </div>
  ${active ? `<div class="grid g2 section">
    <div class="card"><h2>List your credits</h2>
      <form class="stack" id="list">
        <label>Batch<select name="batchId" required>${acct.credits.map((c) => `<option value="${c.batchId}">${c.batchId} · ${esc(c.batch.project)} (${T(c.kg, 0)} t)</option>`).join('') || '<option value="">No credits held</option>'}</select></label>
        <div class="row"><label>Tonnes<input name="tonnes" inputmode="decimal" required></label><label>Price per tonne (${esc(SYM())})<input name="price" inputmode="decimal" required></label></div>
        <div class="actions"><button class="btn" ${acct.credits.length ? '' : 'disabled'}>Create listing</button><span class="small muted">Credits are held in escrow until sold or cancelled.</span></div>
      </form>
    </div>
    <div class="card"><h2>How settlement works</h2>
      <div class="feature" style="margin-bottom:14px">${icon('coin', 'icon-outline')}<div><h3>Paid in ${esc(SYM())}</h3><p>The buyer's stablecoin moves to the seller in the same transaction that moves the credits. No counterparty risk, no FDK price exposure.</p></div></div>
      <div class="feature">${icon('check', 'icon-outline')}<div><h3>Atomic and auditable</h3><p>Every trade is on-chain with its batch, registry serial and price, ready for ESG and carbon accounting.</p></div></div>
    </div>
  </div>` : ''}`;
}

function bindMarket() {
  document.querySelectorAll('form.buy').forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = new FormData(f).get('t');
    submit('market_buy', { listingId: f.dataset.id, quantityKg: tonnesToKg(t).toString(), maxPricePerTonne: f.dataset.price }, `Buy ${t} t`);
  }));
  document.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => submit('market_cancel', { listingId: b.dataset.cancel }, `Cancel ${b.dataset.cancel}`)));
  document.getElementById('list')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const d = formData(e.target);
    submit('market_list', { batchId: d.batchId, quantityKg: tonnesToKg(d.tonnes).toString(), pricePerTonne: stable(d.price).toString() }, `List ${d.tonnes} t`);
  });
}

// --------------------------------------------------------------- registry
async function viewRegistry() {
  const [batches, retirements] = await Promise.all([api.get('/api/batches'), api.get('/api/retirements')]);
  return `${head('Carbon registry', 'Tokenised carbon credits', 'Every batch is issued by an accredited auditor and carries its source registry serial. A serial can only be tokenised once.')}
  <div class="card"><h2>Credit batches</h2>${table(['Batch', 'Project', 'Registry', 'Vintage', '#Issued', '#Retired', '#Backing FDK'], batches.map((b) => `<tr><td><a href="#/batch/${b.id}">${b.id}</a></td><td>${esc(b.project)}<div class="small muted">${esc(b.country)} · ${esc(b.projectType)}</div></td><td>${esc(b.registry)}</td><td>${b.vintage}</td><td class="num">${T(b.issuedKg, 0)} t</td><td class="num">${T(b.retiredKg, 0)} t</td><td class="num">${T(b.backingKg, 0)} t</td></tr>`), 'No credits tokenised yet.')}</div>
  <div class="card section"><h2>Retirement certificates</h2>${table(['Certificate', 'Beneficiary', 'Project', '#Tonnes', '#Date'], retirements.map((r) => `<tr><td><a href="#/retirement/${r.id}">${r.id}</a></td><td>${esc(r.beneficiary)}</td><td>${esc(r.batch.project)}</td><td class="num">${T(r.quantityKg)}</td><td class="num">${day(r.timestamp)}</td></tr>`), 'No retirements yet.')}</div>`;
}

async function viewBatch(id) {
  const b = await api.get('/api/batch/' + id);
  const issued = BigInt(b.issuedKg);
  const pct = (x) => (issued > 0n ? Number((BigInt(x) * 1000n) / issued) / 10 : 0);
  return `${head('Credit batch', esc(b.project), `${esc(b.country)} · ${esc(b.projectType)} · vintage ${b.vintage}`)}
  <div class="grid g4">
    ${kpi('Issued', `${T(b.issuedKg, 0)}<small>t</small>`, '', 'green')}
    ${kpi('Retired', `${T(b.retiredKg, 0)}<small>t</small>`, `${pct(b.retiredKg)}%`)}
    ${kpi('Locked as FDK backing', `${T(b.backingKg, 0)}<small>t</small>`, `${pct(b.backingKg)}%`, 'green')}
    ${kpi('Open listings', b.listings.length, b.listings.length ? `from ${S(b.listings.reduce((m, l) => (BigInt(l.pricePerTonne) < m ? BigInt(l.pricePerTonne) : m), BigInt(b.listings[0].pricePerTonne)))} ${esc(SYM())}/t` : '')}
  </div>
  <div class="bar section" style="margin-top:16px"><span style="width:${pct(b.retiredKg)}%"></span></div>
  <div class="grid g2 section">
    <div class="card"><h2>Batch details</h2><div class="kv">
      <div>Batch ID</div><div>${b.id}</div>
      <div>Registry</div><div>${esc(b.registry)}</div>
      <div>Serial range</div><div class="mono">${esc(b.serial)}</div>
      <div>Methodology</div><div>${esc(b.methodology)}</div>
      <div>Issued by auditor</div><div>${addrLink(b.auditor, b.auditor)}</div>
      <div>Issued</div><div>${date(b.issuedAt)} · ${txLink(b.issueTx)}</div>
      ${b.description ? `<div>Description</div><div>${esc(b.description)}</div>` : ''}
    </div></div>
    <div class="card"><h2>Holders</h2>${table(['Address', '#Tonnes'], b.holders.map((h) => `<tr><td>${addrLink(h.address)}</td><td class="num">${T(h.kg)}</td></tr>`), 'All credits are retired, listed or locked.')}</div>
  </div>
  <div class="card section"><h2>Retirements</h2>${table(['Certificate', 'Beneficiary', 'Reason', '#Tonnes'], b.retirements.map((r) => `<tr><td><a href="#/retirement/${r.id}">${r.id}</a></td><td>${esc(r.beneficiary)}</td><td>${esc(r.reason)}</td><td class="num">${T(r.quantityKg)}</td></tr>`), 'None yet.')}</div>`;
}

async function viewRetirement(id) {
  const r = await api.get('/api/retirement/' + id);
  return `<div class="actions no-print" style="margin-bottom:16px"><a class="btn ghost sm" href="#/registry">← Registry</a>${LOCAL ? '' : `<button class="btn sm" onclick="window.print()">${icon('print')} Print or save as PDF</button>`}</div>
  <div class="cert">
    <img class="logo" src="${LOGO_POSITIVE}" alt="Fedrok">
    <div class="eyebrow" style="margin-top:34px">Carbon credit retirement certificate</div>
    <h1>${esc(r.beneficiary)}</h1>
    <p class="lede" style="margin-top:8px">has permanently retired verified carbon credits on the Fedrok blockchain.</p>
    <div class="big">${T(r.quantityKg)} tCO₂e</div>
    <div class="muted">${esc(r.reason)}</div>
    <div class="grid g2">
      <div class="kv">
        <div>Certificate</div><div><b>${r.id}</b></div>
        <div>Retired on</div><div>${day(r.timestamp)}</div>
        <div>Project</div><div>${esc(r.batch.project)}</div>
        <div>Location</div><div>${esc(r.batch.country)}</div>
      </div>
      <div class="kv">
        <div>Registry</div><div>${esc(r.batch.registry)}</div>
        <div>Serial range</div><div class="mono">${esc(r.batch.serial)}</div>
        <div>Vintage</div><div>${r.batch.vintage}</div>
        <div>On-chain proof</div><div><a class="mono" href="#/tx/${r.tx}">${short(r.tx, 10)}</a> · block ${r.height}</div>
      </div>
    </div>
    <p class="small muted" style="margin-top:30px">Verify this certificate at any Fedrok node: <span class="mono">GET /api/retirement/${r.id}</span>. Retired credits are removed from circulation and can never be transferred or retired again.</p>
  </div>`;
}

// ---------------------------------------------------------------- mining
async function viewMining() {
  const [miners, gens, btc] = await Promise.all([api.get('/api/miners'), api.get('/api/generators'), api.get('/api/btc?limit=12')]);
  const s = STATUS;
  const sched = s.schedule;
  const slotNow = Math.floor(Date.now() / s.params.blockTimeMs);
  const slots = Array.from({ length: Math.min(6, Math.max(sched.generators.length, 3)) }, (_, i) => ({ slot: slotNow + i, g: sched.generators[(slotNow + i) % sched.generators.length] }));
  const active = Wallet.active();
  const me = active ? gens.find((g) => g.address === active.address) : null;
  const greenSince = s.pog.lastGreenBtcHeight >= 0 ? s.pog.anchorHeight - s.pog.lastGreenBtcHeight : null;
  return `${head('Proof of Green', 'Green mining and block production', 'Accredited green Bitcoin miners and their block generators are paid from the Piggy Bank for producing Fedrok blocks: a fee for work done, not a return on holding FDK. When an accredited miner wins a Bitcoin block, its generators take turns producing blocks; the ProofOfGreen system contract enforces the schedule. If no green Bitcoin block appears within the green window, the fallback validator keeps the chain running.')}
  <div class="grid g4">
    ${kpi('Consensus mode', sched.mode === 'green' ? 'Green' : 'Fallback', sched.mode === 'green' ? `active miner ${esc(sched.miner)}` : 'waiting for a green Bitcoin block', 'green')}
    ${kpi('Green window', `${greenSince === null ? '—' : greenSince} / ${s.params.greenWindow}`, 'Bitcoin blocks since last green block')}
    ${kpi('Piggy Bank', `${F(s.piggyBank, 0)}<small>FDK</small>`, `${F(BigInt(s.yearlyEmission) / 31536000n, 6)} FDK per second`, 'green')}
    ${kpi('Block generators', gens.length, `min. stake ${F(s.params.minGeneratorStake, 0)} FDK`)}
  </div>
  <div class="card section"><h2>Round-robin schedule <span class="aside">${sched.generators.length} generator(s) in rotation</span></h2>
    <div class="rr">${slots.map((x, i) => `<div class="slot ${i === 0 ? 'now' : ''}"><b>${i === 0 ? 'Now' : `+${i * s.params.blockTimeMs / 1000}s`}</b>${addrLink(x.g)}</div>`).join('')}</div>
    <p class="small muted" style="margin:12px 0 0">If a generator misses its ${s.params.blockTimeMs / 1000}-second slot, the next generator in line produces the block, so no single node can halt the chain.</p>
  </div>
  <div class="card section"><h2>Accredited miners</h2>${table(['Miner', 'Energy', '#Units', 'Generators', '#Green blocks', '#Paid for production (FDK)', 'Status'], miners.map((m) => `<tr><td><a href="#/miner/${m.id}">${esc(m.name)}</a><div class="small muted">${m.id}</div></td><td>${esc(m.energy)}<div class="small muted">${esc(m.site)}</div></td><td class="num">${m.units}</td><td>${m.generators.length} ${m.publicGenerators ? '<span class="pill grey">public</span>' : '<span class="pill grey">private</span>'}</td><td class="num">${m.greenBlocks}</td><td class="num">${F(m.rewardsEarned, 2)}</td><td>${m.active ? (s.schedule.miner === m.id ? '<span class="pill grad">producing</span>' : '<span class="pill green">accredited</span>') : `<span class="pill warn">${esc(m.revokedReason || 'inactive')}</span>`}</td></tr>`), 'No accredited miners yet. Auditors accredit miners in the Console.')}</div>
  <div class="grid g2 section">
    <div class="card"><h2>Block generators</h2>${table(['Generator', '#Stake (FDK)', 'Linked miners', '#Blocks'], gens.map((g) => `<tr><td>${addrLink(g.address)}<div class="small muted">${esc(g.name)}</div></td><td class="num">${F(g.stake, 0)}</td><td>${g.links.map((l) => `<a href="#/miner/${l}">${l}</a>`).join('<br>') || '—'}</td><td class="num">${g.blocks}</td></tr>`), 'No generators yet.')}</div>
    <div class="card"><h2>Bitcoin chain (light client)</h2>${table(['Height', 'Miner', '#Age'], btc.map((h) => `<tr><td>${h.height}</td><td>${h.green ? `<span class="pill green"><span class="d"></span>Green</span> ${esc(h.minerName)}` : `<span class="muted mono">${esc(short(h.minerAddress, 10))}</span>`}</td><td class="num muted">${ago(h.time)}</td></tr>`))}</div>
  </div>
  ${active ? `<div class="card section"><h2>Become a block generator</h2>
    ${me ? `<p style="margin-top:0">You are a block generator with ${F(me.stake, 0)} FDK staked, linked to ${me.links.length} miner(s).</p>
      <form class="actions" id="link"><select name="minerId" style="max-width:360px">${miners.filter((m) => m.active).map((m) => `<option value="${m.id}">${esc(m.name)} (${m.publicGenerators ? 'public' : 'needs approval'})</option>`).join('')}</select><button class="btn">Link to miner</button></form>`
      : `<form class="stack" id="stake" style="max-width:520px"><label>Stake (FDK) <span class="hint">minimum ${F(s.params.minGeneratorStake, 0)} FDK, locked while you generate blocks</span><input name="stake" value="${F(s.params.minGeneratorStake, 0).replace(/,/g, '')}" required></label><label>Display name<input name="name" placeholder="e.g. Basel generator"></label><div class="actions"><button class="btn">Stake and register</button></div></form>`}
  </div>` : ''}`;
}

function bindMining() {
  document.getElementById('stake')?.addEventListener('submit', (e) => { e.preventDefault(); const d = formData(e.target); submit('generator_register', { stake: fdk(d.stake).toString(), name: d.name }, 'Generator registration'); });
  document.getElementById('link')?.addEventListener('submit', (e) => { e.preventDefault(); submit('generator_link', { minerId: formData(e.target).minerId }, 'Link to miner'); });
}

async function viewMiner(id) {
  const miners = await api.get('/api/miners');
  const m = miners.find((x) => x.id === id);
  if (!m) throw new Error('miner not found');
  const active = Wallet.active();
  const owner = active?.address === m.owner;
  return `${head('Green miner', esc(m.name), `${esc(m.energy)} · ${esc(m.site)}`)}
  <div class="grid g4">
    ${kpi('Status', m.active ? 'Accredited' : 'Inactive', m.active ? `until ${day(m.expiresAt)}` : esc(m.revokedReason || ''), 'green')}
    ${kpi('Capacity', `${m.units}<small>units</small>`, `≈ ${m.units} × S9 (95 TH/s, 3.2 kW)`)}
    ${kpi('Yearly production allowance', `${F(m.yearlyReward, 0)}<small>FDK</small>`, `${F(BigInt(m.yearlyReward) / BigInt(m.units), 0)} FDK per unit = tCO₂e reduced`, 'green')}
    ${kpi('Paid for production', `${F(m.rewardsEarned, 3)}<small>FDK</small>`, `${m.greenBlocks} green Bitcoin blocks`)}
  </div>
  <div class="grid g2 section">
    <div class="card"><h2>Accreditation</h2><div class="kv">
      <div>Miner ID</div><div>${m.id}</div>
      <div>Bitcoin address</div><div class="mono">${esc(m.btcAddress)}</div>
      <div>Fedrok owner</div><div>${addrLink(m.owner, m.owner)}</div>
      <div>Auditor</div><div>${addrLink(m.auditor, m.auditor)}</div>
      <div>Audit report</div><div>${esc(m.reportRef || '—')}</div>
      <div>Accredited</div><div>${date(m.accreditedAt)}</div>
      <div>Piggy Bank pre-fill</div><div>${F(m.prefill, 0)} FDK</div>
      <div>Generator share</div><div>${(m.generatorShareBps / 100).toFixed(1)}% of production payments</div>
      <div>Generators</div><div>${m.publicGenerators ? 'Public: any staked generator may link' : 'Private: owner approval required'}</div>
    </div></div>
    <div class="card"><h2>Linked block generators</h2>${table(['Generator'], m.generators.map((g) => `<tr><td>${addrLink(g, g)}</td></tr>`), 'No generators linked.')}
      ${owner ? `<form class="stack section" id="approve"><label>Approve a generator address<input name="generator" placeholder="0x…" required></label><div class="actions"><button class="btn">Approve</button><button type="button" class="btn ghost" id="toggle-public">${m.publicGenerators ? 'Make private' : 'Make public'}</button></div></form>` : ''}
    </div>
  </div>`;
}

function bindMiner(id) {
  document.getElementById('approve')?.addEventListener('submit', (e) => { e.preventDefault(); submit('generator_approve', { minerId: id, generator: formData(e.target).generator.trim().toLowerCase() }, 'Approve generator'); });
  document.getElementById('toggle-public')?.addEventListener('click', async () => {
    const m = (await api.get('/api/miners')).find((x) => x.id === id);
    submit('miner_update', { minerId: id, publicGenerators: !m.publicGenerators }, 'Update miner');
  });
}

// --------------------------------------------------------------- console
async function viewConsole() {
  const active = Wallet.active();
  if (!active) return `${head('Console', 'Governance and auditor console')}<div class="note plain">Connect a wallet with a governance, auditor or stablecoin-issuer role to use the console. ${LOCAL ? 'Pick the Auditor or Fedrok AG governance identity on the <a href="#/wallet">Wallet</a> page.' : 'On the devnet these keys are in <code>devnet/keys/</code>.'}</div>`;
  const [acct, auditors] = await Promise.all([api.account(active.address), api.get('/api/auditors')]);
  const roles = acct.roles;
  const isGov = roles.includes('governance'), isAud = roles.includes('auditor'), isIss = roles.includes('stablecoin-issuer');
  const s = STATUS;
  let simMiners = [];
  if (isAud) { try { simMiners = await api.get('/api/btc-sim-miners'); } catch {} }
  return `${head('Console', 'Governance and auditor console', `Signed in as ${addrLink(active.address, active.name)} · roles: ${roles.map((r) => `<span class="pill green">${r}</span>`).join(' ') || 'none'}`)}
  ${!isGov && !isAud && !isIss ? '<div class="note">This wallet has no privileged role. Governance (Fedrok AG, later the DAO) can add auditors; auditors accredit miners and issue credits; the stablecoin issuer mints against reserves.</div>' : ''}
  <div class="grid g2">
  ${isAud ? `
    <div class="card"><h2>Issue carbon credits</h2>
      <form class="stack" id="issue">
        <label>Project name<input name="project" required></label>
        <div class="row"><label>Country<input name="country" required></label><label>Project type<input name="projectType" placeholder="Reforestation" required></label></div>
        <div class="row"><label>Registry<select name="registry"><option>Verra VCS</option><option>Gold Standard</option><option>Puro.earth</option><option>Isometric</option><option>Article 6.4</option></select></label><label>Vintage<input name="vintage" inputmode="numeric" value="2025" required></label></div>
        <label>Methodology<input name="methodology" required></label>
        <label>Registry serial range <span class="hint">must be unique: blocks double counting</span><input name="serial" required></label>
        <div class="row"><label>Quantity (tCO₂e)<input name="tonnes" inputmode="decimal" required></label><label>Issue to address <span class="hint">blank = yourself</span><input name="to" placeholder="0x…"></label></div>
        <label>Description<textarea name="description"></textarea></label>
        <div class="actions"><button class="btn">Issue batch</button></div>
      </form>
    </div>
    <div class="card"><h2>Accredit a green miner</h2>
      <form class="stack" id="accredit">
        <label>Simulated Bitcoin miner <span class="hint">devnet: the simulator signs the Bitcoin ownership proof</span><select name="sim">${simMiners.map((m, i) => `<option value="${i}">${esc(m.name)} · ${esc(m.energy)}</option>`).join('')}</select></label>
        <label>Fedrok owner address<input name="owner" placeholder="0x…" required></label>
        <div class="row"><label>Units (S9-equivalent)<input name="units" inputmode="numeric" value="50" required></label><label>Audit period (days)<input name="auditDays" inputmode="numeric" value="365" required></label></div>
        <div class="row"><label>Generator share (%)<input name="share" inputmode="decimal" value="15" required></label><label>Generators<select name="publicGenerators"><option value="1">Public</option><option value="0">Private</option></select></label></div>
        <label>Audit report reference<input name="reportRef" placeholder="ISO 14064-3 verification report …"></label>
        <div class="actions"><button class="btn">Accredit miner</button><span class="small muted">Pre-fills the Piggy Bank with ${F(s.params.fdkPerUnitYear, 0)} FDK per unit per year.</span></div>
      </form>
    </div>
    <div class="card"><h2>Back-mint FDK against credits</h2>
      <p class="small" style="margin-top:0">Locks verified credits you hold in the backing vault and mints FDK utility tokens 1:1 per tonne.</p>
      <form class="stack" id="backmint">
        <label>Batch<select name="batchId">${acct.credits.map((c) => `<option value="${c.batchId}">${c.batchId} · ${esc(c.batch.project)} (${T(c.kg, 0)} t)</option>`).join('') || '<option value="">No credits held</option>'}</select></label>
        <div class="row"><label>Tonnes<input name="tonnes" inputmode="decimal" required></label><label>Mint to <span class="hint">blank = yourself</span><input name="to" placeholder="0x…"></label></div>
        <div class="actions"><button class="btn" ${acct.credits.length ? '' : 'disabled'}>Lock and mint</button></div>
      </form>
    </div>` : ''}
  ${isIss ? `<div class="card"><h2>Mint ${esc(SYM())} stablecoin</h2>
      <form class="stack" id="smint">
        <label>Recipient<input name="to" placeholder="0x…" required></label>
        <div class="row"><label>Amount (${esc(SYM())})<input name="amount" inputmode="decimal" required></label><label>Reserve attestation reference<input name="reserveRef" required></label></div>
        <div class="actions"><button class="btn">Mint</button></div>
      </form></div>` : ''}
  ${isGov ? `<div class="card"><h2>Governance</h2>
      <form class="stack" id="addaud"><h3>Add an auditor</h3><div class="row"><label>Auditor address<input name="auditor" placeholder="0x…" required></label><label>Organisation<input name="name" required></label></div><div class="actions"><button class="btn">Add auditor</button></div></form>
      <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
      <form class="stack" id="param"><h3>Change a network parameter</h3><div class="row"><label>Parameter<select name="key">${['blockTimeMs', 'greenWindow', 'marketFeeBps', 'maxGeneratorsPerMiner', 'maxTxPerBlock', 'minGasPrice', 'minGeneratorStake', 'fdkPerUnitYear'].map((k) => `<option>${k}</option>`).join('')}</select></label><label>Value <span class="hint">FDK values in base units (18 decimals)</span><input name="value" required></label></div><div class="actions"><button class="btn ghost">Update parameter</button></div></form>
      <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
      <form class="stack" id="fallback"><h3>Fallback validator</h3><label>Address<input name="validator" value="${s.fallbackValidator}" required></label><div class="actions"><button class="btn ghost">Set fallback validator</button></div></form>
    </div>
    <div class="card"><h2>Auditors</h2>${table(['Auditor', 'Status'], auditors.map((a) => `<tr><td>${esc(a.name)}<div>${addrLink(a.address)}</div></td><td>${a.active ? '<span class="pill green">active</span>' : '<span class="pill warn">removed</span>'} ${a.active ? `<button class="btn ghost sm" data-rmaud="${a.address}">Remove</button>` : ''}</td></tr>`))}</div>` : ''}
  </div>`;
}

function bindConsole() {
  const on = (id, fn) => document.getElementById(id)?.addEventListener('submit', async (e) => { e.preventDefault(); try { await fn(formData(e.target)); } catch (err) { toast(esc(err.message), 'err'); } });
  on('issue', (d) => submit('credit_issue', { project: d.project, country: d.country, projectType: d.projectType, registry: d.registry, vintage: Number(d.vintage), methodology: d.methodology, serial: d.serial, quantityKg: tonnesToKg(d.tonnes).toString(), to: d.to ? d.to.trim().toLowerCase() : undefined, description: d.description }, `Issue ${d.tonnes} t`));
  on('accredit', async (d) => {
    const sims = await api.get('/api/btc-sim-miners');
    const m = sims[Number(d.sim)];
    const owner = d.owner.trim().toLowerCase();
    const btcSig = signRecoverable(btcLinkMessage(m.address, owner, STATUS.chainId, STATUS.contracts.ProofOfGreen), m.privKey);
    await submit('miner_accredit', { name: m.name, btcAddress: m.address, btcPubKey: m.pubKey, btcSig, owner, units: Number(d.units), auditDays: Number(d.auditDays), generatorShareBps: Math.round(Number(d.share) * 100), publicGenerators: d.publicGenerators === '1', site: m.site, energy: m.energy, reportRef: d.reportRef }, 'Accredit miner');
  });
  on('backmint', (d) => submit('fdk_back_mint', { batchId: d.batchId, quantityKg: tonnesToKg(d.tonnes).toString(), to: d.to ? d.to.trim().toLowerCase() : undefined }, `Back-mint ${d.tonnes} FDK`));
  on('smint', (d) => submit('stable_mint', { to: d.to.trim().toLowerCase(), amount: stable(d.amount).toString(), reserveRef: d.reserveRef }, `Mint ${d.amount} ${SYM()}`));
  on('addaud', (d) => submit('gov_add_auditor', { auditor: d.auditor.trim().toLowerCase(), name: d.name }, 'Add auditor'));
  on('param', (d) => submit('gov_set_param', { key: d.key, value: String(d.value).trim() }, `Set ${d.key}`));
  on('fallback', (d) => submit('gov_set_fallback', { validator: d.validator.trim().toLowerCase() }, 'Set fallback validator'));
  document.querySelectorAll('[data-rmaud]').forEach((b) => b.addEventListener('click', () => submit('gov_remove_auditor', { auditor: b.dataset.rmaud }, 'Remove auditor')));
}

// ------------------------------------------------------------ developers
async function viewDevelopers() {
  const s = STATUS;
  const origin = location.origin;
  const C = s.contracts || {};
  const CONTRACT_INFO = {
    FedrokGovernance: 'Roles (governance, auditors, stablecoin issuer, fallback validator) and network parameters',
    FDKIssuer: 'Capped FDK reserve: issues only for Piggy Bank pre-fills and auditor back-minting; burns',
    FUSD: 'Settlement stablecoin stand-in (ERC-20, 6 decimals)',
    CarbonRegistry: 'Environmental asset registry (ERC-1155, 1 unit = 1 kg CO₂e): issue, transfer, retire, back-mint',
    CarbonMarketplace: 'Escrowed listings, atomic stablecoin settlement',
    ProofOfGreen: 'Green miners, block generators, Bitcoin anchor, schedule and Piggy Bank (system contract)',
    LegacyGarden: 'Personal Legacy Garden memorial tree registry',
  };
  return `${head('Developers', 'Build on Fedrok', 'Fedrok is EVM-compatible: transactions are standard signed Ethereum transactions, the protocol is a set of Solidity contracts, and every node speaks Ethereum JSON-RPC at /rpc. MetaMask, ethers.js, viem, Foundry and Hardhat work unchanged. FDK is the native gas token.')}
  <div class="grid g4">
    ${kpi('Chain ID', `<span style="font-size:16px">${esc(s.chainId)}</span>`, `<span class="mono">0x${Number(s.chainId).toString(16)}</span> · ${esc(s.network)}`, 'green')}
    ${kpi('Execution', '<span style="font-size:16px">EVM</span>', 'Shanghai rules · EIP-1559 fees')}
    ${kpi('Gas token', '<span style="font-size:16px">FDK</span>', `base fee ${F(s.params.minGasPrice, 9)} FDK/gas`, 'green')}
    ${kpi('This node', `<span style="font-size:16px">${esc(s.node)}</span>`, `${s.peers.length} peers connected`)}
  </div>
  ${LOCAL ? '<div class="note plain section">This hosted demo runs a complete Fedrok node, EVM included, inside your browser tab, so external wallets cannot reach it. Run <code>npm run devnet</code> to get a JSON-RPC endpoint for MetaMask or Foundry.</div>' : `<div class="card section"><h2>Add Fedrok to MetaMask</h2><p class="small" style="margin-top:0">Network name <b>Fedrok ${esc(s.network)}</b> · RPC URL <code>${origin}/rpc</code> · Chain ID <code>${esc(s.chainId)}</code> · Currency <b>FDK</b></p><div class="actions"><button class="btn sm" id="add-metamask">Add network to wallet</button></div></div>`}
  <div class="card section"><h2>System contracts</h2><p class="small" style="margin-top:0">Deployed at genesis at the same addresses on every Fedrok network. Sources in <code>contracts/</code>, ABIs in <code>src/evm/artifacts.json</code>.</p>${table(['Contract', 'Address', 'Role'], Object.entries(C).map(([n, a]) => `<tr><td><b>${esc(n)}</b></td><td class="mono small">${esc(a)}</td><td class="small">${esc(CONTRACT_INFO[n] || '')}</td></tr>`))}</div>
  <div class="grid g2 section">
    <div class="card"><h2>Ethereum JSON-RPC</h2><pre class="code">cast block-number --rpc-url ${origin}/rpc
cast call ${C.FUSD || '0x…'} \
  "balanceOf(address)(uint256)" 0xYourAddress \
  --rpc-url ${origin}/rpc</pre>
      <p class="small">Standard: <code>eth_chainId</code> <code>eth_blockNumber</code> <code>eth_getBalance</code> <code>eth_getTransactionCount</code> <code>eth_getCode</code> <code>eth_getStorageAt</code> <code>eth_call</code> <code>eth_estimateGas</code> <code>eth_gasPrice</code> <code>eth_feeHistory</code> <code>eth_sendRawTransaction</code> <code>eth_getTransactionByHash</code> <code>eth_getTransactionReceipt</code> <code>eth_getBlockByNumber</code> <code>eth_getBlockByHash</code> <code>eth_getLogs</code> <code>net_version</code> <code>web3_clientVersion</code></p>
      <p class="small">Fedrok read model: <code>fdk_status</code> <code>fdk_getAccount</code> <code>pog_getSchedule</code> <code>pog_getMiners</code> <code>carbon_getBatches</code> <code>carbon_getListings</code> <code>carbon_getRetirement</code> <code>garden_getGarden</code> <code>garden_getTree</code> <code>garden_getDedication</code></p>
    </div>
    <div class="card"><h2>ethers.js</h2><pre class="code">import { JsonRpcProvider, Wallet, Contract } from 'ethers';

const provider = new JsonRpcProvider('${origin}/rpc');
const wallet = new Wallet(privKey, provider);
const market = new Contract('${C.CarbonMarketplace || '0x…'}', [
  'function buy(uint256 listingId, uint256 quantityKg, uint256 maxPricePerTonne)',
], wallet);
// buy 10 t from listing LST-000001, paid in ${esc(SYM())}
// (approve the marketplace on the ${esc(SYM())} contract first)
await (await market.buy(1, 10_000, 0)).wait();</pre>
    <p class="small">Or use the bundled SDK, which encodes the same calls: <code>new FedrokClient(url).sendAndWait(privKey, 'market_buy', { listingId: 'LST-000001', quantityKg: '10000' })</code>.</p></div>
  </div>
  <div class="card section"><h2>REST endpoints</h2>${table(['Method', 'Path', 'Description'], [
    ['GET', '/api/status', 'Chain, consensus, supply and peer status'], ['GET', '/api/blocks?limit=&before=', 'Recent block summaries'], ['GET', '/api/block/:heightOrHash', 'Full block with transactions and Bitcoin headers'],
    ['GET', '/api/tx/:hash', 'Transaction with status, gas, logs and decoded events'], ['GET', '/api/account/:address', 'Balances, credits, roles, history, next nonce'], ['POST', '/api/tx', 'Submit a signed raw Ethereum transaction: { raw }'], ['GET', '/api/contracts', 'System contract addresses'],
    ['GET', '/api/batches · /api/batch/:id', 'Carbon credit batches, holders, retirements'], ['GET', '/api/listings', 'Open marketplace listings'], ['GET', '/api/retirements · /api/retirement/:id', 'Retirement certificates'],
    ['GET', '/api/miners · /api/generators · /api/auditors', 'Proof of Green participants'],
    ['GET', '/api/gardens · /api/garden/:id', 'Legacy Gardens with batches, stats, site plan and field records'], ['GET', '/api/tree/:id · /api/dedication/:id', 'Tree record (plantings, inspections, replacements) and subscribership certificate'], ['GET', '/api/dedications?holder=&garden=', 'Dedications held by a member account'], ['GET', '/api/btc?limit=', 'Bitcoin headers seen by the light client'], ['GET', '/api/search?q=', 'Resolve a block, tx, address, batch, retirement or miner'],
    ['WS', '/ws', 'Live feed of blocks, transactions and Bitcoin headers'],
  ].map(([m, p, d]) => `<tr><td><span class="pill grey">${m}</span></td><td class="mono">${p}</td><td>${d}</td></tr>`))}</div>
  <div class="card section"><h2>Fedrok actions</h2><p class="small" style="margin-top:0">The wallet and SDK name each contract call as a Fedrok action; the explorer decodes mined transactions back into these names. All transactions pay gas in FDK (utility). Payments between parties use ${esc(SYM())}.</p>
    <div class="rr">${Object.entries(TX_LABEL).map(([k, v]) => `<div class="slot"><b>${k}</b>${v}</div>`).join('')}</div></div>
  <div class="card section"><h2>Peers</h2>${table(['Node', 'Height', 'Direction'], s.peers.map((p) => `<tr><td>${esc(p.name)}<div class="small muted mono">${esc(p.url || '')}</div></td><td>${p.height}</td><td>${p.inbound ? 'inbound' : 'outbound'}</td></tr>`), 'No peers connected.')}</div>`;
}

function bindDevelopers() {
  document.getElementById('add-metamask')?.addEventListener('click', async () => {
    if (!window.ethereum) return toast('No browser wallet found. Install MetaMask or another EVM wallet.', 'err');
    try {
      await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x' + Number(STATUS.chainId).toString(16), chainName: `Fedrok ${STATUS.network}`, nativeCurrency: { name: 'FDK', symbol: 'FDK', decimals: 18 }, rpcUrls: [location.origin + '/rpc'] }] });
      toast('Fedrok network added to your wallet.', 'ok');
    } catch (e) {
      toast(esc(e.message || String(e)), 'err');
    }
  });
}

// ---------------------------------------------------------- legacy garden
// Personal Legacy Garden: public registry and map, tree pages with a QR tag,
// subscribership certificates, member dashboard and steward console.
const GBP = (pence) => '£' + (Number(pence) / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 });
const PILOT_TARGET = 100, PILOT_STRETCH = 150;
const G_SPECIES = [
  ['Odum', 'Milicia excelsa'], ['African mahogany', 'Khaya ivorensis'], ['Wawa', 'Triplochiton scleroxylon'],
  ['Emire', 'Terminalia ivorensis'], ['Ofram', 'Terminalia superba'], ['African walnut', 'Lovoa trichilioides'],
  ['Afromosia', 'Pericopsis elata'], ['Kusia', 'Nauclea diderrichii'], ['Dahoma', 'Piptadeniastrum africanum'],
  ['Edinam', 'Entandrophragma angolense'], ['Sapele', 'Entandrophragma cylindricum'], ['Bakankor', 'Tieghemella heckelii'],
  ['Prekese', 'Tetrapleura tetraptera'], ['Dawadawa', 'Parkia biglobosa'],
];
const G_PACKAGES = { standard: 'Standard tree', family: 'Family tree', memorial: 'Memorial tree', legacy: 'Legacy tree', corporate: 'Corporate grove tree' };
const today = () => new Date().toISOString().slice(0, 10);
const dname = (d) => (d.publicName ? esc(d.dedicatedTo) : '<span class="muted">Private dedication</span>');
const dnamePlain = (d) => (d.publicName ? d.dedicatedTo : 'Private dedication');
const batchPill = (st) => `<span class="pill ${st === 'planted' ? 'green' : st === 'released' ? 'grad' : st === 'carried over' ? 'warn' : 'grey'}">${esc(st)}</span>`;
const healthPill = (h, status) => (status === 'dead' || h === 'dead' ? '<span class="pill warn">died</span>' : h === 'healthy' ? '<span class="pill green"><span class="d"></span>healthy</span>' : `<span class="pill grad">${esc(h)}</span>`);
const fp = (h) => (h ? `<span class="mono small" title="${h}">${h.slice(0, 10)}…</span>` : '<span class="muted small">none</span>');
const osm = (g) => `https://www.openstreetmap.org/?mlat=${g.lat}&mlon=${g.lon}#map=19/${g.lat}/${g.lon}`;
const treeUrl = (id) => `${location.href.split('#')[0]}#tree-${id}`;
const isGardenRole = (roles) => roles.includes('garden-operator') || roles.includes('garden-steward');

async function fileFingerprint(input, fallback) {
  const f = input?.files?.[0];
  if (f) return sha256Hex(new Uint8Array(await f.arrayBuffer()));
  return sha256Hex(`no-photo:${fallback}:${Date.now()}`);
}

// Site plan: 5 one-acre compartments, 10 x 9 planting positions at 6 m spacing.
function siteMap(g, trees, highlight) {
  const cw = 60, gap = 12, rows = 9, cols = 10, sp = 6;
  const W = g.compartments.length * (cw + gap) - gap, H = rows * sp;
  const byPos = new Map(trees.map((t) => [`${t.compartment}-${t.number}`, t]));
  let out = '';
  g.compartments.forEach((c, ci) => {
    const x0 = ci * (cw + gap);
    out += `<rect x="${x0 - 1}" y="-1" width="${cw + 2}" height="${H + 2}" fill="none" stroke="var(--line)" stroke-width="0.4"/>`;
    out += `<text x="${x0 + cw / 2}" y="${H + 7}" text-anchor="middle" font-size="4.2" fill="var(--ink-soft)">Compartment ${c}</text>`;
    for (let k = 1; k <= rows * cols; k++) {
      const r = Math.floor((k - 1) / cols), col = (k - 1) % cols;
      const cx = x0 + col * sp + sp / 2, cy = H - (r * sp + sp / 2);
      const t = byPos.get(`${c}-${k}`);
      if (!t) { out += `<circle cx="${cx}" cy="${cy}" r="0.7" fill="var(--line)"/>`; continue; }
      const fill = t.status === 'dead' ? 'var(--cinnabar)' : t.health === 'healthy' ? 'var(--green)' : 'var(--sandy)';
      const ring = t.plantings > 1 ? `<circle cx="${cx}" cy="${cy}" r="2.5" fill="none" stroke="var(--cinnabar)" stroke-width="0.6"/>` : '';
      const hi = highlight === t.id ? `<circle cx="${cx}" cy="${cy}" r="3.6" fill="none" stroke="var(--ink)" stroke-width="0.8"/>` : '';
      out += `<a href="#/tree/${t.id}"><title>${esc(t.id)} · ${esc(t.publicName ? t.dedicatedTo : 'Private dedication')} · ${esc(t.species)}</title>${ring}${hi}<circle cx="${cx}" cy="${cy}" r="1.8" fill="${fill}"/></a>`;
    }
  });
  return `<svg class="gmap" viewBox="-3 -3 ${W + 6} ${H + 13}" role="img" aria-label="Site plan of the Garden">${out}</svg>
  <div class="legend small muted"><span><i style="background:var(--green)"></i>Planted, healthy</span><span><i style="background:var(--sandy)"></i>Needs attention</span><span><i class="ring"></i>Replaced tree</span><span><i style="background:var(--line)"></i>Open position</span></div>`;
}

function treeIllustration(heightCm, dead) {
  const h = Math.min(heightCm || 30, 300);
  const drawn = Math.min(160, 50 + h * 0.45); // stylised: small trees stay visible
  const top = 190 - drawn;
  const crown = drawn * 0.36;
  const col = dead ? '#b9a48c' : 'var(--green)';
  return `<svg viewBox="0 0 200 210" class="tree-illus" role="img" aria-label="Illustration of the tree at ${heightCm || '—'} cm">
    <rect x="0" y="190" width="200" height="20" fill="var(--green-soft)"/>
    <line x1="122" y1="190" x2="122" y2="${Math.max(top + 10, 120)}" stroke="#b9a48c" stroke-width="2"/>
    <line x1="100" y1="190" x2="100" y2="${top + crown * 0.6}" stroke="#7a5a3a" stroke-width="${Math.max(3, h / 30)}"/>
    <circle cx="100" cy="${top + crown * 0.55}" r="${crown}" fill="${col}" opacity="0.92"/>
    <circle cx="${100 - crown * 0.6}" cy="${top + crown * 0.95}" r="${crown * 0.62}" fill="${col}" opacity="0.8"/>
    <circle cx="${100 + crown * 0.6}" cy="${top + crown * 0.95}" r="${crown * 0.62}" fill="${col}" opacity="0.8"/>
    <text x="100" y="204" text-anchor="middle" font-size="9" fill="var(--ink-soft)">${heightCm ? `${heightCm} cm at last inspection` : 'newly planted'}</text>
  </svg>`;
}

function growthChart(t) {
  const cur = t.plantings[t.plantings.length - 1];
  const pts = [{ d: 0, h: null }, ...t.monitoring.filter((m) => m.planting === cur.n && m.health !== 'dead').map((m) => ({ d: (Date.parse(m.date) - Date.parse(cur.plantedOn)) / 86_400_000, h: m.heightCm }))].filter((p) => p.h !== null);
  if (pts.length < 2) return '<div class="empty">Growth chart appears after two inspections.</div>';
  const W = 260, H = 150, pl = 46, pb = 24;
  const maxD = Math.max(...pts.map((p) => p.d), 30), maxH = Math.ceil(Math.max(...pts.map((p) => p.h)) / 50) * 50;
  const x = (d) => pl + (d / maxD) * (W - pl - 10), y = (h) => H - pb - (h / maxH) * (H - pb - 10);
  const line = pts.map((p) => `${x(p.d).toFixed(1)},${y(p.h).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Height over time">
    <line x1="${pl}" y1="${H - pb}" x2="${W - 10}" y2="${H - pb}" stroke="var(--line)"/>
    <line x1="${pl}" y1="${y(maxH)}" x2="${W - 10}" y2="${y(maxH)}" stroke="var(--line)" stroke-dasharray="2 3"/>
    <text x="${pl - 6}" y="${y(maxH) + 3}" text-anchor="end" font-size="11" fill="var(--ink-soft)">${maxH} cm</text>
    <text x="${pl - 6}" y="${H - pb + 3}" text-anchor="end" font-size="11" fill="var(--ink-soft)">0 cm</text>
    <polyline points="${line}" fill="none" stroke="var(--green)" stroke-width="2"/>
    ${pts.map((p) => `<circle cx="${x(p.d)}" cy="${y(p.h)}" r="3" fill="var(--green)"><title>Day ${Math.round(p.d)}: ${p.h} cm</title></circle>`).join('')}
    <text x="${W - 10}" y="${H - 6}" text-anchor="end" font-size="11" fill="var(--ink-soft)">${Math.round(maxD)} days since planting</text>
  </svg>`;
}

async function viewGarden(id) {
  const gardens = await api.get('/api/gardens');
  if (!gardens.length) return `${head('Personal Legacy Garden', 'No Garden registered yet')}<div class="note plain">${LOCAL?.seed?.running ? 'Demo data is still being set up. This page fills in automatically in a few seconds.' : 'Governance registers a Garden with <code>garden_register</code>. Run <code>npm run demo</code> to create the Bibiani pilot.'}</div>`;
  const g = await api.get('/api/garden/' + (id || gardens[0].id));
  const st = g.stats;
  const open = g.open;
  const w = Wallet.active();
  const acct = w ? await api.account(w.address) : null;
  const steward = acct && isGardenRole(acct.roles);
  const pct = (n, of) => Math.min(100, Math.round((n / of) * 100));
  return `${head('Personal Legacy Garden', esc(g.name), `${esc(g.location)}, ${esc(g.country)} · operated by ${esc(g.operatorName || short(g.operator))}`, `<div class="actions">${steward ? `<a class="btn sm" href="#/steward">${icon('shield')} Steward console</a>` : ''}<a class="btn ghost sm" href="#/member">${icon('heart')} My trees</a></div>`)}
  <div class="note plain" style="margin-bottom:18px">Every dedicated tree is recorded on Fedrok: payment reference, planting date, GPS, photographs (as fingerprints), inspections and replacements. Subscribers hold a <b>non-transferable dedication</b> giving naming, dedication, access and stewardship-recognition rights. The trees and the land stay with the Garden. Subscribers pay in GBP and never need FDK: the Garden pays the network fees.</div>
  <div class="grid g4">
    ${kpi('Subscriptions', st.subscriptions, `pilot target ${PILOT_TARGET} · stretch ${PILOT_STRETCH}`, 'green')}
    ${kpi('Trees planted', st.planted, `${st.speciesCount} indigenous species · ${st.gpsPct ?? 0}% with GPS`)}
    ${kpi('Survival', st.survivalPct === null ? '—' : `${st.survivalPct}<small>%</small>`, `${st.replaced} replaced under guarantee`, 'green')}
    ${kpi('Next planting batch', `${open.dedications.length}<small>/ ${open.size}</small>`, `${esc(open.window)}`)}
  </div>
  <div class="card section" style="margin-top:18px"><h2>Pilot progress <span class="aside">${st.subscriptions} of ${PILOT_TARGET} paid trees (stretch ${PILOT_STRETCH})</span></h2>
    <div class="bar target"><span style="width:${pct(st.subscriptions, PILOT_STRETCH)}%"></span><b style="left:${pct(PILOT_TARGET, PILOT_STRETCH)}%" title="Pilot target"></b></div>
    <div class="small muted" style="position:relative;height:20px;margin-top:6px"><span style="position:absolute;left:0">0</span><span style="position:absolute;left:${pct(PILOT_TARGET, PILOT_STRETCH)}%;transform:translateX(-50%)">Target ${PILOT_TARGET}</span><span style="position:absolute;right:0">Stretch ${PILOT_STRETCH}</span></div>
  </div>
  <div class="card section"><h2>Site plan <span class="aside">${g.capacity} positions · click a tree to open its record</span></h2>${siteMap(g, g.trees)}</div>
  <div class="grid g2 section">
    <div class="card"><h2>Planting batches <span class="aside">planting starts when ${g.batchSize} trees are paid</span></h2>
      ${table(['Batch', 'Window', '#Paid', 'Status'], g.batches.map((b) => `<tr><td>${b.id}${b.carriedFrom ? `<div class="small muted">carried over from ${b.carriedFrom}</div>` : ''}${b.carriedTo ? `<div class="small muted">moved to ${b.carriedTo}</div>` : ''}</td><td>${esc(b.window)}</td><td class="num">${b.dedications.length} / ${b.size}<div class="bar mini"><span style="width:${pct(b.dedications.length, b.size)}%"></span></div></td><td>${batchPill(b.status)}</td></tr>`))}
      <p class="small muted">If a batch has not reached ${g.batchSize} paid trees when its planting window closes, its payments carry over to the next window.</p>
    </div>
    <div class="card"><h2>Recent field records</h2>
      ${table(['Date', 'Tree', 'Record'], g.activity.slice(0, 8).map((a) => `<tr><td class="muted nowrap">${esc(a.date)}</td><td class="nowrap"><a href="#/tree/${a.treeId}">${a.treeId}</a></td><td>${a.kind === 'died' ? '<span class="pill warn">died</span>' : a.kind === 'replaced' ? '<span class="pill grad">replaced</span>' : a.kind === 'planted' ? '<span class="pill green">planted</span>' : '<span class="pill grey">inspected</span>'} <span class="small muted">${esc(a.note || '')}</span></td></tr>`), 'No field records yet.')}
    </div>
  </div>
  <div class="grid g2 section">
    <div class="card"><h2>Species mix</h2>
      ${table(['Species', '#Trees'], Object.entries(st.species).sort((a, b) => b[1] - a[1]).map(([sp, n]) => `<tr><td>${esc(sp)} <span class="small muted"><i>${esc(G_SPECIES.find((x) => x[0] === sp)?.[1] || '')}</i></span></td><td class="num">${n}</td></tr>`), 'No trees planted yet.')}
    </div>
    <div class="card"><h2>Garden terms on-chain</h2><div class="kv">
      <div>Garden code</div><div><b>${g.id}</b></div>
      <div>Capacity</div><div>${g.capacity} dedicated trees in ${g.compartments.length} compartments (${g.compartments.join(', ')})</div>
      <div>Subscription</div><div>${GBP(g.priceGBP)} per tree and plaque${BigInt(g.stablePrice) > 0n ? ` · or ${S(g.stablePrice)} ${esc(SYM())} on-chain` : ''}</div>
      <div>Maintenance</div><div>${GBP(g.maintenanceGBP)} per tree per year</div>
      <div>Replacement</div><div>Free within ${g.replacementMonths} months of planting</div>
      <div>Stewardship</div><div>${g.lifespanYears} years (natural lifespan)</div>
      <div>Agreement</div><div>${fp(g.agreementHash)} <span class="small muted">fingerprint of the subscribership agreement</span></div>
      <div>Stewards</div><div>${g.stewards.filter((s) => s.active).map((s) => `${esc(s.name)} ${addrLink(s.address)}`).join('<br>') || '—'}</div>
      <div>Registered</div><div>${date(g.registeredAt)} · ${txLink(g.registerTx)}</div>
    </div></div>
  </div>`;
}

async function viewTree(id) {
  const t = await api.get('/api/tree/' + id);
  const d = t.dedication;
  const cur = t.plantings[t.plantings.length - 1];
  const last = [...t.monitoring].reverse().find((m) => m.planting === cur.n);
  const url = treeUrl(t.id);
  return `<div class="actions no-print" style="margin-bottom:16px"><a class="btn ghost sm" href="#/garden">← ${esc(t.garden.name)}</a></div>
  ${head('Dedicated tree · ' + t.id, dname(d), `${d.descriptor ? esc(d.descriptor) + ' · ' : ''}${esc(t.species)} <i>(${esc(t.scientific)})</i>`)}
  <div class="grid g3">
    <div class="card" style="text-align:center">${treeIllustration(last?.heightCm, t.status === 'dead')}${d.inscription ? `<p class="lede" style="margin:10px 0 0">“${esc(d.inscription)}”</p>` : ''}<p class="small muted">Illustration. Photographs are kept in the Garden archive; their fingerprints are on-chain below.</p><h3 style="text-align:left;margin-top:18px">Growth</h3>${growthChart(t)}</div>
    <div class="card"><h2>Tree record</h2><div class="kv">
      <div>Tree ID</div><div><b>${t.id}</b></div>
      <div>Status</div><div>${healthPill(last?.health || 'healthy', t.status)}</div>
      <div>Species</div><div>${esc(t.species)}<div class="small muted"><i>${esc(t.scientific)}</i></div></div>
      <div>Compartment</div><div>${t.compartment}, position ${t.number}</div>
      <div>Planted</div><div>${esc(cur.plantedOn)}${cur.n > 1 ? ` <span class="pill grad">replacement ${cur.n - 1}</span>` : ''}</div>
      <div>GPS</div><div><a href="${osm(cur.gps)}" target="_blank" rel="noopener">${cur.gps.lat}, ${cur.gps.lon}</a></div>
      <div>Seed source</div><div>${esc(cur.seedSource)}</div>
      <div>Dedication</div><div><a href="#/dedication/${d.id}">${d.id}</a> · ${esc(d.packageName)}</div>
      <div>Stewardship</div><div>${t.garden.lifespanYears} years · replacement free within ${t.garden.replacementMonths} months</div>
    </div></div>
    <div class="card qr-card"><h2>Tag QR code</h2>${qrSvg(url, { px: 168 })}<p class="small muted">Printed on the tree's tag. Scanning it opens this public record.</p><p class="small mono muted" style="word-break:break-all">${esc(url)}</p></div>
  </div>
  <div class="section">
    <div class="card"><h2>Planting and replacement history</h2>
      ${table(['#', 'Planted', 'GPS', 'Outcome', 'Proof'], t.plantings.map((p) => `<tr><td>${p.n}</td><td>${esc(p.plantedOn)}</td><td class="small mono">${p.gps.lat}, ${p.gps.lon}</td><td>${p.diedOn ? `<span class="pill warn">died ${esc(p.diedOn)}</span><div class="small muted">${esc(p.cause)}</div>` : '<span class="pill green">growing</span>'}${p.n > 1 ? `<div class="small muted">${esc(p.coveredBy)}</div>` : ''}</td><td>${txLink(p.tx)}<div>${fp(p.photoHash)}</div></td></tr>`))}
    </div>
  </div>
  <div class="card section"><h2>Inspections</h2>
    ${table(['Date', '#Height', '#Stem', 'Crown', 'Health', 'Photo', 'Note', 'Proof'], [...t.monitoring].reverse().map((m) => `<tr><td>${esc(m.date)}${m.planting > 1 ? '<div class="small muted">replacement</div>' : ''}</td><td class="num">${m.heightCm} cm</td><td class="num">${m.stemMm} mm</td><td>${esc(m.crown)}</td><td>${healthPill(m.health)}</td><td>${fp(m.photoHash)}</td><td class="small">${esc(m.cause || m.note || '')}</td><td>${txLink(m.tx)}</td></tr>`), 'No inspections yet.')}
  </div>
  <p class="small muted">Verify at any Fedrok node: <span class="mono">GET /api/tree/${t.id}</span>. Personal details of the subscriber are not stored on-chain.</p>`;
}

async function viewDedication(id) {
  const d = await api.get('/api/dedication/' + id);
  const t = d.tree;
  return `<div class="actions no-print" style="margin-bottom:16px"><a class="btn ghost sm" href="#/member">← My trees</a>${t ? `<a class="btn ghost sm" href="#/tree/${t.id}">Tree record</a>` : ''}${LOCAL ? '' : `<button class="btn sm" onclick="window.print()">${icon('print')} Print or save as PDF</button>`}</div>
  <div class="cert">
    <img class="logo" src="${LOGO_POSITIVE}" alt="Fedrok">
    <div class="eyebrow" style="margin-top:34px">Subscribership certificate · ${esc(d.packageName)}</div>
    <h1>${d.publicName ? esc(d.dedicatedTo) : 'A private dedication'}</h1>
    ${d.publicName && d.descriptor ? `<p class="lede" style="margin-top:4px">${esc(d.descriptor)}</p>` : ''}
    <p class="lede" style="margin-top:8px">${t ? 'is honoured by a dedicated indigenous tree' : 'will be honoured by a dedicated indigenous tree'} in the ${esc(d.garden.name)}, ${esc(d.garden.location)}, ${esc(d.garden.country)}.</p>
    <div class="big">${t ? t.id : 'To be planted'}</div>
    <div class="muted">${t ? `${esc(t.species)} · <i>${esc(t.scientific)}</i> · planted ${esc(t.plantedOn)}` : `In planting batch ${d.batch.id}: ${d.batch.paid} of ${d.batch.size} paid · ${esc(d.batch.window)}${d.carryOvers ? ` · carried over ${d.carryOvers === 1 ? 'once' : d.carryOvers + ' times'}` : ''}`}</div>
    ${d.inscription ? `<p style="margin-top:14px">“${esc(d.inscription)}”</p>` : ''}
    <div class="grid g2">
      <div class="kv">
        <div>Certificate</div><div><b>${d.id}</b></div>
        <div>Package</div><div>${esc(d.packageName)} (${esc(d.purpose)})</div>
        <div>Payment</div><div>${d.payment.currency === 'GBP' ? GBP(d.payment.amount) : `${S(d.payment.amount)} ${esc(d.payment.currency)}`} by ${esc(d.payment.method)}${d.payment.paidOn ? ` on ${esc(d.payment.paidOn)}` : ''}<div class="small muted mono">${esc(d.payment.ref.length > 30 ? short(d.payment.ref, 10) : d.payment.ref)}</div></div>
        <div>Maintenance</div><div>${d.maintenance.active ? `<span class="pill green">${esc(d.maintenance.label)}</span>` : `<span class="pill warn">${esc(d.maintenance.label)}</span>`} <span class="small muted">${GBP(d.garden.maintenanceGBP)} a year</span></div>
      </div>
      <div class="kv">
        ${t ? `<div>Location</div><div>Compartment ${t.compartment}, position ${t.number}<div class="small mono">${t.gps.lat}, ${t.gps.lon}</div></div>` : ''}
        <div>Replacement</div><div>Free if the tree dies within ${d.garden.replacementMonths} months; the dedication carries to the replacement</div>
        <div>Holder</div><div>${addrLink(d.holder)} <span class="small muted">member account</span></div>
        <div>On-chain proof</div><div><a class="mono" href="#/tx/${d.tx}">${short(d.tx, 10)}</a> · block ${d.height}</div>
      </div>
    </div>
    <p class="small muted" style="margin-top:30px">This certificate confers naming, dedication, access and stewardship-recognition rights only. The tree and the land remain under the protected ownership and long-term stewardship of the Garden for the tree's natural life of ${d.garden.lifespanYears} years. The dedication cannot be traded. Verify it at any Fedrok node: <span class="mono">GET /api/dedication/${d.id}</span>.</p>
  </div>`;
}

async function viewMember() {
  const w = Wallet.active();
  const pick = LOCAL ? 'Pick a <b>Garden member</b> identity on the <a href="#/wallet">Wallet</a> page to see a subscriber’s dashboard.' : 'Connect the wallet linked to your Garden membership.';
  if (!w) return `${head('Personal Legacy Garden', 'My trees')}<div class="note plain">${pick}</div>`;
  const acct = await api.account(w.address);
  const ds = acct.dedications || [];
  if (!ds.length) return `${head('Personal Legacy Garden', 'My trees', `Signed in as ${addrLink(w.address, w.name)}`)}<div class="note plain">This account holds no tree dedications. ${pick}</div>`;
  const planted = ds.filter((d) => d.tree).length;
  const due = ds.filter((d) => !d.maintenance.active).length;
  return `${head('Personal Legacy Garden', 'My trees', `Signed in as ${addrLink(w.address, w.name)} · member dashboard`)}
  <div class="grid g4">
    ${kpi('Dedicated trees', ds.length, `${esc(ds[0].garden.name)}`, 'green')}
    ${kpi('Planted', planted, `${ds.length - planted} waiting for their planting batch`)}
    ${kpi('Maintenance', due ? `${due} due` : 'Up to date', `${GBP(ds[0].garden.maintenanceGBP)} per tree per year`, due ? '' : 'green')}
    ${kpi('FDK needed', '0', 'the Garden pays network fees for you')}
  </div>
  <div class="grid g2 section">${ds.map((d) => { const t = d.tree; return `<div class="card ded-card">
    <h2>${dname(d)} <span class="aside">${esc(d.packageName)}</span></h2>
    ${d.publicName && d.descriptor ? `<p class="lede" style="margin:-4px 0 10px">${esc(d.descriptor)}</p>` : ''}
    <div class="kv">
      <div>Tree</div><div>${t ? `<a href="#/tree/${t.id}"><b>${t.id}</b></a>` : `<span class="pill grey">awaiting planting</span>`}</div>
      ${t ? `<div>Species</div><div>${esc(t.species)} <span class="small muted"><i>${esc(t.scientific)}</i></span></div>
      <div>Planted</div><div>${esc(t.plantedOn)}${t.plantings > 1 ? ' <span class="pill grad">replaced under guarantee</span>' : ''}</div>
      <div>Location</div><div>Compartment ${t.compartment} · <a href="${osm(t.gps)}" target="_blank" rel="noopener">${t.gps.lat}, ${t.gps.lon}</a></div>
      <div>Health</div><div>${healthPill(t.health, t.status)}${t.heightCm ? ` <span class="small muted">${t.heightCm} cm at last inspection</span>` : ''}</div>`
      : `<div>Planting batch</div><div>${d.batch.id} · ${d.batch.paid} of ${d.batch.size} paid<div class="bar mini"><span style="width:${Math.round((d.batch.paid / d.batch.size) * 100)}%"></span></div><div class="small muted">${esc(d.batch.window)}${d.carryOvers ? ` · carried over from an earlier window` : ''}</div></div>`}
      <div>Maintenance</div><div>${d.maintenance.active ? `<span class="pill green">${esc(d.maintenance.label)}</span>` : `<span class="pill warn">${esc(d.maintenance.label)}</span>`}</div>
      <div>Payment</div><div>${d.payment.currency === 'GBP' ? GBP(d.payment.amount) : `${S(d.payment.amount)} ${esc(d.payment.currency)}`} · ${esc(d.payment.method)}</div>
    </div>
    <div class="actions" style="margin-top:14px"><a class="btn sm" href="#/dedication/${d.id}">Certificate</a>${t ? `<a class="btn ghost sm" href="#/tree/${t.id}">Photos and inspections</a>` : ''}</div>
  </div>`; }).join('')}</div>
  <p class="small muted">Your contact details and any private dedication names are held by the Garden, not on the blockchain. Only fingerprints of those records are on-chain.</p>`;
}

async function viewSteward() {
  const w = Wallet.active();
  const intro = LOCAL ? 'Pick the <b>Garden operator</b> or <b>Garden field steward</b> identity on the <a href="#/wallet">Wallet</a> page.' : 'Connect the Garden operator or a steward wallet.';
  if (!w) return `${head('Personal Legacy Garden', 'Steward console')}<div class="note plain">${intro}</div>`;
  const [acct, gardens] = await Promise.all([api.account(w.address), api.get('/api/gardens')]);
  if (!isGardenRole(acct.roles) || !gardens.length) return `${head('Personal Legacy Garden', 'Steward console')}<div class="note plain">This wallet is not the operator or a steward of a Garden. ${intro}</div>`;
  const g = gardens.find((x) => x.operator === w.address || x.stewards.some((s) => s.address === w.address && s.active));
  const [full, deds] = await Promise.all([api.get('/api/garden/' + g.id), api.get('/api/dedications?garden=' + g.id)]);
  const isOp = g.operator === w.address;
  const ready = deds.filter((d) => !d.tree && d.batch.status === 'released');
  const alive = full.trees.filter((t) => t.status === 'alive');
  const dead = full.trees.filter((t) => t.status === 'dead');
  const used = new Set(full.trees.map((t) => t.id.replace(/^\w+-\d{4}-/, '')));
  const year = today().slice(0, 4);
  let next = 'A-001';
  outer: for (const c of g.compartments) for (let k = 1; k <= 90; k++) { const code = `${c}-${String(k).padStart(3, '0')}`; if (!used.has(code)) { next = code; break outer; } }
  const opts = (arr, f) => arr.map(f).join('') || '<option value="">None</option>';
  return `${head('Personal Legacy Garden', 'Steward console', `${esc(g.name)} · signed in as ${addrLink(w.address, w.name)} (${isOp ? 'operator' : 'steward'}) · every record is signed by you and the network fee is paid in FDK by the Garden`)}
  <div class="grid g2">
    <div class="card"><h2>Record a paid subscription</h2>
      <form class="stack" id="g-ded">
        <label>Member account address <span class="hint">the account that will hold the dedication</span><input name="holder" placeholder="0x…" required></label>
        <div class="row"><label>Package<select name="package">${Object.entries(G_PACKAGES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label><label>Purpose<select name="purpose">${['memorial', 'family', 'friendship', 'self', 'institutional', 'pet'].map((p) => `<option>${p}</option>`).join('')}</select></label></div>
        <div class="row"><label>Name on the tree<input name="dedicatedTo" required></label><label>Descriptor<input name="descriptor" placeholder="e.g. Loving Mother"></label></div>
        <label>Short dedication<input name="inscription" maxlength="200"></label>
        <label class="check"><input type="checkbox" name="publicName" checked> Subscriber consents to showing the name publicly <span class="hint">unticked: only a salted fingerprint of the name goes on-chain</span></label>
        <div class="row"><label>Payment reference<input name="ref" placeholder="PLG-2026-0072" required></label><label>Method<select name="method"><option>card</option><option>bank transfer</option></select></label></div>
        <div class="row"><label>Amount (GBP)<input name="amount" value="${Number(g.priceGBP) / 100}" inputmode="decimal" required></label><label>Paid on<input name="paidOn" type="date" value="${today()}" required></label></div>
        <div class="actions"><button class="btn">Record subscription</button><span class="small muted">Joins batch ${full.open.id} (${full.open.dedications.length}/${full.open.size})</span></div>
      </form>
    </div>
    <div class="card"><h2>Plant a tree</h2>
      <form class="stack" id="g-plant">
        <label>Dedication <span class="hint">from a released batch</span><select name="dedicationId">${opts(ready, (d) => `<option value="${d.id}">${d.id} · ${esc(dnamePlain(d))} (${esc(d.preferredSpecies || 'any species')})</option>`)}</select></label>
        <div class="row"><label>Tree ID<input name="treeId" value="${g.id}-${year}-${next}" required></label><label>Species<select name="species">${G_SPECIES.map(([c, s], i) => `<option value="${i}">${c} (${s})</option>`).join('')}</select></label></div>
        <div class="row"><label>Latitude<input name="lat" value="${g.centre.lat}" required></label><label>Longitude<input name="lon" value="${g.centre.lon}" required></label></div>
        <div class="row"><label>Planted on<input name="plantedOn" type="date" value="${today()}" required></label><label>Seed source<input name="seedSource" value="CSIR-FORIG nursery, Kumasi" required></label></div>
        <label>Geotagged planting photo <span class="hint">stays on this device: only its fingerprint goes on-chain</span><input name="photo" type="file" accept="image/*"></label>
        <div class="actions"><button class="btn" ${ready.length ? '' : 'disabled'}>Record planting</button>${ready.length ? '' : '<span class="small muted">No released batch is waiting. Planting starts when a batch reaches ' + g.batchSize + ' paid trees.</span>'}</div>
      </form>
    </div>
    <div class="card"><h2>Record an inspection</h2>
      <form class="stack" id="g-mon">
        <label>Tree<select name="treeId">${opts(alive, (t) => `<option value="${t.id}">${t.id} · ${esc(t.publicName ? t.dedicatedTo : 'Private')} · ${esc(t.species)}</option>`)}</select></label>
        <div class="row"><label>Date<input name="date" type="date" value="${today()}" required></label><label>Height (cm)<input name="heightCm" inputmode="numeric" required></label></div>
        <div class="row"><label>Stem diameter (mm)<input name="stemMm" inputmode="numeric" required></label><label>Crown<select name="crown"><option>good</option><option>fair</option><option>poor</option></select></label></div>
        <div class="row"><label>Health<select name="health"><option>healthy</option><option>stressed</option><option>diseased</option><option value="dead">dead (record a death)</option></select></label><label>Cause of death <span class="hint">only if dead</span><input name="cause"></label></div>
        <label>Note<input name="note"></label>
        <label>Inspection photo<input name="photo" type="file" accept="image/*"></label>
        <div class="actions"><button class="btn" ${alive.length ? '' : 'disabled'}>Record inspection</button></div>
      </form>
    </div>
    <div class="card"><h2>Replace a tree that died</h2>
      <form class="stack" id="g-rep">
        <label>Tree recorded as dead<select name="treeId">${opts(dead, (t) => `<option value="${t.id}">${t.id} · ${esc(t.species)}</option>`)}</select></label>
        <div class="row"><label>Latitude<input name="lat" value="${g.centre.lat}" required></label><label>Longitude<input name="lon" value="${g.centre.lon}" required></label></div>
        <div class="row"><label>Planted on<input name="plantedOn" type="date" value="${today()}" required></label><label>Seed source<input name="seedSource" value="Nursery replacement stock" required></label></div>
        <label>Covered by <span class="hint">only needed after the ${g.replacementMonths}-month guarantee</span><input name="coveredBy" placeholder="e.g. Legacy package maintenance fund"></label>
        <label>Planting photo<input name="photo" type="file" accept="image/*"></label>
        <div class="actions"><button class="btn" ${dead.length ? '' : 'disabled'}>Record replacement</button></div>
      </form>
    </div>
    <div class="card"><h2>Annual maintenance</h2>
      <form class="stack" id="g-renew">
        <label>Dedication<select name="dedicationId">${opts(deds, (d) => `<option value="${d.id}">${d.id} · ${esc(dnamePlain(d))} · ${esc(d.maintenance.label)}</option>`)}</select></label>
        <div class="row"><label>Year<input name="year" value="${Number(year) + 1}" inputmode="numeric" required></label><label>Payment reference<input name="ref" placeholder="PLG-MNT-…" required></label></div>
        <div class="actions"><button class="btn ghost">Record ${GBP(g.maintenanceGBP)} renewal</button></div>
      </form>
    </div>
    <div class="card"><h2>Close the planting window</h2>
      <p class="small" style="margin-top:0">Batch ${full.open.id} has <b>${full.open.dedications.length} of ${full.open.size}</b> paid trees for <b>${esc(full.open.window)}</b>. Closing the window carries these payments over to the next window.</p>
      <form class="stack" id="g-close"><label>Next planting window<input name="nextWindow" placeholder="e.g. Major rainy season 2027 (Apr–Jul)" required></label><div class="actions"><button class="btn ghost">Close window and carry over</button></div></form>
      ${isOp ? `<hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
      <form class="stack" id="g-stew"><h3>Accredit a steward</h3><div class="row"><label>Steward address<input name="steward" placeholder="0x…" required></label><label>Name and role<input name="name" placeholder="Field attendant" required></label></div><div class="actions"><button class="btn ghost">Accredit steward</button></div></form>` : ''}
    </div>
  </div>`;
}

function bindSteward() {
  const on = (id, fn) => document.getElementById(id)?.addEventListener('submit', async (e) => { e.preventDefault(); try { await fn(formData(e.target), e.target); } catch (err) { toast(esc(err.message), 'err'); } });
  const gardenId = async () => {
    const w = Wallet.active();
    const gs = await api.get('/api/gardens');
    return (gs.find((x) => x.operator === w.address || x.stewards.some((s) => s.address === w.address)) || gs[0]).id;
  };
  on('g-ded', async (d) => {
    const pub = d.publicName === 'on';
    const salt = generatePrivateKey();
    const names = pub ? { publicName: true, dedicatedTo: d.dedicatedTo, descriptor: d.descriptor, inscription: d.inscription } : { publicName: false, nameHash: sha256Hex(`${salt}:${d.dedicatedTo}`) };
    await submit('dedication_create', { gardenId: await gardenId(), holder: d.holder.trim().toLowerCase(), package: d.package, purpose: d.purpose, ...names, payment: { ref: d.ref.trim(), method: d.method, currency: 'GBP', amount: String(Math.round(Number(d.amount) * 100)), paidOn: d.paidOn } }, 'Record subscription');
    if (!pub) toast('Keep the salt with the private customer record: ' + `<span class="mono">${salt.slice(0, 18)}…</span>`, '', 12000);
  });
  on('g-plant', async (d, f) => {
    const [sp, sci] = G_SPECIES[Number(d.species)];
    await submit('tree_plant', { dedicationId: d.dedicationId, treeId: d.treeId.trim().toUpperCase(), species: sp, scientific: sci, gps: { lat: d.lat.trim(), lon: d.lon.trim() }, plantedOn: d.plantedOn, seedSource: d.seedSource, photoHash: await fileFingerprint(f.photo, d.treeId) }, `Plant ${d.treeId}`);
  });
  on('g-mon', async (d, f) => {
    const p = { treeId: d.treeId, date: d.date, heightCm: Number(d.heightCm), stemMm: Number(d.stemMm), crown: d.crown, health: d.health, note: d.note };
    if (d.health === 'dead') p.cause = d.cause;
    if (f.photo.files.length) p.photoHash = await fileFingerprint(f.photo, d.treeId);
    await submit('tree_monitor', p, `Inspection of ${d.treeId}`);
  });
  on('g-rep', async (d, f) => submit('tree_replace', { treeId: d.treeId, plantedOn: d.plantedOn, gps: { lat: d.lat.trim(), lon: d.lon.trim() }, seedSource: d.seedSource, photoHash: await fileFingerprint(f.photo, d.treeId), ...(d.coveredBy ? { coveredBy: d.coveredBy } : {}) }, `Replace ${d.treeId}`));
  on('g-renew', async (d) => submit('maintenance_renew', { dedicationId: d.dedicationId, year: Number(d.year), paymentRef: d.ref.trim() }, `Maintenance ${d.year}`));
  on('g-close', async (d) => submit('planting_window_close', { gardenId: await gardenId(), nextWindow: d.nextWindow }, 'Close planting window'));
  on('g-stew', async (d) => submit('garden_steward', { gardenId: await gardenId(), steward: d.steward.trim().toLowerCase(), name: d.name }, 'Accredit steward'));
}

// ----------------------------------------------------------------- router
const ROUTES = [
  [/^\/$/, viewOverview],
  [/^\/explorer$/, viewExplorer],
  [/^\/block\/(.+)$/, viewBlock],
  [/^\/tx\/(.+)$/, viewTx],
  [/^\/address\/(.+)$/, viewAddress],
  [/^\/wallet$/, viewWallet, bindWallet],
  [/^\/market$/, viewMarket, bindMarket],
  [/^\/registry$/, viewRegistry],
  [/^\/batch\/(.+)$/, viewBatch],
  [/^\/retirement\/(.+)$/, viewRetirement],
  [/^\/mining$/, viewMining, bindMining],
  [/^\/miner\/(.+)$/, viewMiner, bindMiner],
  [/^\/console$/, viewConsole, bindConsole],
  [/^\/garden$/, viewGarden],
  [/^\/garden\/(.+)$/, viewGarden],
  [/^\/tree\/(.+)$/, viewTree],
  [/^\/dedication\/(.+)$/, viewDedication],
  [/^\/member$/, viewMember],
  [/^\/steward$/, viewSteward, bindSteward],
  [/^\/developers$/, viewDevelopers, bindDevelopers],
];
const LIVE = ['/', '/explorer', '/mining', '/garden'];

function renderNav(path) {
  document.getElementById('nav').innerHTML = NAV.map(([href, label, ic]) => {
    const on = href === '/' ? path === '/' : path.startsWith(href) || (href === '/explorer' && /^\/(block|tx|address)\//.test(path)) || (href === '/registry' && /^\/(batch|retirement)\//.test(path)) || (href === '/mining' && path.startsWith('/miner/')) || (href === '/garden' && /^\/(tree|dedication|steward)/.test(path));
    return `<a href="${toHash(href)}" class="${on ? 'active' : ''}">${icon(ic)}<span>${label}</span></a>`;
  }).join('');
}

function renderFoot(live) {
  const s = STATUS;
  const w = Wallet.active();
  document.getElementById('side-foot').innerHTML = s
    ? `<div><span class="dot ${live ? 'live' : ''}"></span>${esc(s.node)} · #${Number(s.height).toLocaleString('en-GB')}</div><div style="margin-top:6px">${w ? `Wallet: <a style="color:#fff" href="#/wallet">${esc(w.name)}</a>` : '<a style="color:#fff" href="#/wallet">Connect a wallet</a>'}</div>`
    : '<span class="dot"></span>Connecting…';
}

let rendering = false;
let rerender = false;
async function render() {
  if (rendering) { rerender = true; return; }
  rendering = true;
  rerender = false;
  const path = hashToPath(location.hash);
  const changed = path !== currentRoute;
  currentRoute = path;
  document.body.classList.remove('nav-open');
  renderNav(path);
  try {
    STATUS = await api.status();
    renderFoot(true);
    const route = ROUTES.find(([re]) => re.test(path));
    if (!route) throw new Error('page not found');
    const m = path.match(route[0]);
    const html = await route[1](m[1] || '');
    const scroll = window.scrollY;
    app.innerHTML = `<div class="page">${html}</div>`;
    if (!changed) window.scrollTo(0, scroll);
    else window.scrollTo(0, 0);
    route[2]?.(m[1] || '');
    document.querySelectorAll('a[href^="#/"]').forEach((a) => a.setAttribute('href', toHash(a.getAttribute('href').slice(1))));
    document.getElementById('reset-net')?.addEventListener('click', () => LOCAL?.reset());
    document.getElementById('search')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = new FormData(e.target).get('q');
      try {
        const r = await api.get('/api/search?q=' + encodeURIComponent(q));
        go(`/${r.kind}/${r.id}`);
      } catch {
        toast(`Nothing found for “${esc(q)}”.`, 'err');
      }
    });
  } catch (e) {
    app.innerHTML = `<div class="page">${head('Error', 'Something went wrong')}<div class="note">${esc(e.message)}</div></div>`;
    renderFoot(false);
  } finally {
    rendering = false;
    if (rerender) render();
  }
}

function onLive(msg) {
  if (msg.type === 'seed') {
    if (currentRoute === '/' && !document.activeElement?.matches?.('input,select,textarea')) {
      clearTimeout(liveTimer);
      liveTimer = setTimeout(render, 300);
    }
    return;
  }
  if (msg.type === 'block') {
    if (STATUS) STATUS.height = msg.block.height;
    renderFoot(true);
    const busy = document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
    if (LIVE.includes(currentRoute) && !busy) {
      clearTimeout(liveTimer);
      liveTimer = setTimeout(render, 150);
    }
  }
}

function connectLive() {
  if (LOCAL) return LOCAL.subscribe(onLive);
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (ev) => onLive(JSON.parse(ev.data));
  ws.onclose = () => { renderFoot(false); setTimeout(connectLive, 2000); };
}

document.getElementById('menu').addEventListener('click', () => document.body.classList.toggle('nav-open'));
window.addEventListener('hashchange', render);
render();
connectLive();
