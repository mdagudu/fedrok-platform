// Fedrok Registry web app: environmental project registry (register or
// propose a project, project pages with the Sprout assistant, lock & submit,
// retire), explorer, wallet, Legacy Garden, governance console and docs.
// Vanilla ES modules. Every action is an ordinary EIP-1559 Ethereum
// transaction to a Fedrok system contract, signed in the browser.
import { FedrokClient } from '/core/client.js';
import { generatePrivateKey, addressFromPrivate, isAddress, sha256Hex } from '/core/crypto.js';
import { DETAIL_FIELDS, CORE_FIELDS, missingFields, completeness } from '/core/project-fields.js';
import { createSprout } from './sprout.js';
import { qrSvg } from './qr.js';
import { formatFdk, formatStable, fdk, stable } from '/core/units.js';

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
  plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="5" y="11" width="14" height="10"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  folder: '<path d="M3 6h7l2 2h9v11H3z"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.1 4.1 0 0 1 12 7.4a4.1 4.1 0 0 1 7.5 2.4C19.5 15.4 12 20 12 20z"/>',
};
const icon = (n, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${I[n]}</svg>`;

const NAV = [
  ['/', 'Overview', 'home'],
  ['/new', 'Register a project', 'plus'],
  ['/projects', 'Project registry', 'folder'],
  ['/explorer', 'Explorer', 'cube'],
  ['/wallet', 'My account', 'wallet'],
  ['/garden', 'Legacy Garden', 'tree'],
  ['/member', 'My trees', 'heart'],
  ['/console', 'Console', 'shield'],
  ['/developers', 'Developers', 'code'],
];

// ---------------------------------------------------------------- helpers
// Routes use plain hash names (#explorer, #block-12, #batch-CCB-000001) so links
// survive hosts that only pass simple fragments. Legacy #/path links still work.
const toHash = (path) => '#' + path.replace(/^\//, '').replace(/\//, '-');
function hashToPath(h) {
  const raw = decodeURIComponent((h || '').replace(/^#/, '')).split('?')[0];
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
  profile_set: 'Profile updated', project_create: 'Project created', project_update: 'Project edited', project_lock: 'Locked & submitted', project_retire: 'Project retired',
  gov_add_project_type: 'Project type added', gov_add_validator: 'Validator added', gov_remove_validator: 'Validator removed', gov_set_param: 'Parameter change', gov_set_stable_issuer: 'Stablecoin issuer set',
  garden_register: 'Garden registered', garden_steward: 'Garden steward', dedication_create: 'Tree dedication', planting_window_close: 'Planting window closed',
  tree_plant: 'Tree planted', tree_monitor: 'Tree inspection', tree_replace: 'Tree replaced', maintenance_renew: 'Maintenance renewal',
  stable_approve: 'Stablecoin approval', evm_call: 'Contract call', contract_deploy: 'Contract deployment',
};
const txPill = (t) => `<span class="pill ${t === 'project_lock' ? 'grad' : t.startsWith('stable') ? 'grad' : t.startsWith('project') || t.startsWith('tree') || t.startsWith('garden') || t === 'dedication_create' || t === 'planting_window_close' || t === 'maintenance_renew' ? 'green' : 'grey'}">${esc(TX_LABEL[t] || t)}</span>`;
const STATUS_LABEL = { draft: 'Draft', locked: 'Locked & submitted', retired: 'Retired' };
const statusPill = (st) => `<span class="pill ${st === 'locked' ? 'green' : st === 'retired' ? 'grey' : 'grad'}">${st === 'locked' ? icon('lock', 'pill-ic') : '<span class="d"></span>'}${STATUS_LABEL[st] || esc(st)}</span>`;
const kindPill = (k) => `<span class="pill ${k === 'proposed' ? 'warn' : 'grey'}">${k === 'proposed' ? 'Proposal' : 'Registered project'}</span>`;
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
const WKEY = 'fedrok.registry.accounts.v2';
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
  add(name, privKey, meta = {}) {
    const w = this.list();
    const address = addressFromPrivate(privKey);
    const item = w.items.find((i) => i.address === address);
    if (item) Object.assign(item, meta);
    else w.items.push({ name, privKey, address, ...meta });
    w.active = address;
    this.save(w);
    return address;
  },
  active() {
    const w = this.list();
    return w.items.find((i) => i.address === w.active) || null;
  },
  signOut() {
    const w = this.list();
    w.active = null;
    this.save(w);
  },
  byEmail(email) {
    return this.list().items.find((i) => i.email && i.email === email) || null;
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
    toast('Sign in first.', 'err');
    askSignIn();
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
/** Readable owner: the on-chain profile (organisation, else name), else a short address. */
const ownerText = (prof, addr) => (prof ? esc(prof.organisation || prof.name) : short(addr, 6));
const ownerFull = (prof, addr) => (prof ? `<b>${esc(prof.name)}</b>${prof.organisation ? `<div class="small">${esc(prof.organisation)}</div>` : ''}<div class="small">${addrLink(addr)}</div>` : addrLink(addr));
const projectCard = (p) => `<a class="pcard" href="#/project/${p.id}">
  <div class="pcard-top">${kindPill(p.kind)} ${statusPill(p.status)}</div>
  <h3>${esc(p.name)}</h3>
  <div class="small muted">${esc(p.projectType)}${p.country ? ` · ${esc(p.country)}` : ''}</div>
  <div class="small pcard-owner">by ${ownerText(p.ownerProfile, p.owner)}</div>
  ${p.summary ? `<p class="small">${esc(p.summary.length > 170 ? p.summary.slice(0, 167) + '…' : p.summary)}</p>` : '<p class="small muted">No summary yet.</p>'}
  <div class="pcard-foot small muted"><span class="mono">${p.id}</span><span>${p.status === 'locked' ? `locked ${day(p.lockedAt)}` : p.status === 'retired' ? `retired ${day(p.retiredAt)}` : `updated ${ago(p.updatedAt)}`}</span></div>
</a>`;

async function viewOverview() {
  const [blocks, projects] = await Promise.all([api.get('/api/blocks?limit=8'), api.get('/api/projects')]);
  const s = STATUS;
  const ps = s.projectStats;
  const seed = LOCAL?.seed;
  const banner = LOCAL
    ? `<div class="note no-print" style="margin-bottom:18px"><b>Hosted demo.</b> This page runs a complete Fedrok registry network in your browser: three authority validators, the EVM with the registry contracts, and the same API code as a server node. Your data stays in this browser. ${seed.running ? `<br><b>Setting up demo data…</b> ${esc(seed.lines.filter((l) => l.startsWith('✓') || l.startsWith('▸')).slice(-1)[0] || 'starting')}` : ''}<div class="actions" style="margin-top:10px"><a class="btn sm" href="#/new">Register a project</a>${Wallet.active() ? '' : '<a class="btn ghost sm" href="#/wallet">Sign in</a>'}<button class="btn ghost sm" id="reset-net">Reset network</button></div></div>`
    : '';
  return `${banner}
  <section class="hero">
    <div class="ring"></div><div class="disc"></div>
    <div class="eyebrow" style="color:var(--sandy)">Fedrok project registry · chain ${esc(s.chainId)} · ${esc(s.network)}</div>
    <h1>The digital ledger for environmental data.</h1>
    <p>Register the environmental projects you run, or propose the ones you want to see happen. Every detail is recorded on the Fedrok blockchain, and once you lock and submit a project its record can never be changed again.</p>
    <div class="actions" style="position:relative;margin-top:22px"><a class="btn accent" href="#/new">${icon('plus')} Register or propose a project</a><a class="btn ghost on-dark" href="#/projects">Browse the registry</a></div>
  </section>
  <div class="grid g4">
    ${kpi('Projects on the ledger', ps.total, `${ps.registered} registered · ${ps.proposed} proposed`, 'green')}
    ${kpi('Locked & submitted', ps.locked, 'permanently read-only records')}
    ${kpi('Drafts in progress', ps.draft, `${ps.retired} retired`)}
    ${kpi('Block height', Number(s.height).toLocaleString('en-GB'), `${s.consensus.validators.length} authority validators · every ${(s.params.blockTimeMs / 1000).toFixed(0)} s`, 'green')}
  </div>
  <div class="grid g2 section">
    <div class="card"><h2>Recently active projects <a class="aside" href="#/projects">View all</a></h2>
      <div class="pgrid one">${projects.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4).map(projectCard).join('') || '<div class="empty">No projects yet. Be the first to register one.</div>'}</div>
    </div>
    <div class="card"><h2>Latest blocks <a class="aside" href="#/explorer">Explorer</a></h2>
      <div class="feed">${blocks.map((b) => `<div class="feed-item"><div class="blockbadge g">${b.height}</div><div><div><span class="small muted">sealed by</span> ${addrLink(b.validator, b.validatorName || short(b.validator))}</div><div class="small muted">${b.txCount} tx · ${Number(b.gasUsed || 0).toLocaleString('en-GB')} gas</div></div><div class="small muted">${ago(b.timestamp)}</div></div>`).join('') || '<div class="empty">Waiting for the first block…</div>'}</div>
    </div>
  </div>
  <div class="grid g3 section">
    <div class="card feature">${icon('plus', 'icon-outline')}<div><h3>Register or propose</h3><p>Start from a list of ${s.projectTypes.length} environmental project types, from reforestation and mangroves to clean cookstoves and solar.</p></div></div>
    <div class="card feature">${icon('spark', 'icon-outline')}<div><h3>Sprout builds your page</h3><p>Sprout, Fedrok's AI project guide, interviews you about the project and writes every answer to your project page. Talk to Sprout any time to make changes.</p></div></div>
    <div class="card feature">${icon('lock', 'icon-outline')}<div><h3>Lock & submit</h3><p>When the record is complete, lock it. The registry contract then refuses every change, from anyone, including Sprout. You can still retire the project.</p></div></div>
  </div>
  <a class="card feature section" href="#/garden" style="display:flex;margin-top:18px;text-decoration:none">${icon('tree', 'icon-outline')}<div><h3>Personal Legacy Garden · Bibiani pilot</h3><p>Dedicated memorial trees recorded on Fedrok: every subscription, planting, GPS position, inspection and replacement, with a QR tag on each tree. Open the Garden →</p></div></a>`;
}

// -------------------------------------------------------------- explorer
async function viewExplorer() {
  const [blocks, txs] = await Promise.all([api.get('/api/blocks?limit=25'), api.get('/api/txs')]);
  return `${head('Explorer', 'Blocks and transactions', 'Search by block number, block or transaction hash, address, project (PRJ-…), tree (BITG-2026-A-001) or dedication (DED-…).', `<form class="search" id="search"><input name="q" placeholder="Search the Fedrok chain" aria-label="Search"><button class="btn">Search</button></form>`)}
  <div class="grid g2">
    <div class="card"><h2>Blocks</h2>${table(['Block', 'Validator', '#Tx', '#Age'], blocks.map((b) => `<tr><td>${blockLink(b.height)}</td><td>${addrLink(b.validator, b.validatorName || short(b.validator))}</td><td class="num">${b.txCount}</td><td class="num muted">${ago(b.timestamp)}</td></tr>`))}</div>
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
    <div>Consensus</div><div><span class="pill green"><span class="d"></span>Proof of Authority</span> slot leader ${esc(STATUS.consensus.validators.find((v) => v.address === h.validator)?.name || '')}</div>
    <div>Sealed by</div><div>${addrLink(h.validator, h.validator)}</div>
    <div>Gas used</div><div>${Number(h.gasUsed || 0).toLocaleString('en-GB')} · base fee ${F(h.baseFeePerGas || 0, 9)} FDK/gas</div>
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
    case 'ProfileSet': return `Profile of ${addrLink(ev.account)} set to ${esc(ev.name)}${ev.organisation ? ' · ' + esc(ev.organisation) : ''}`;
    case 'Transfer': return `${ev.asset === 'FDK' ? F(ev.amount, 4) + ' FDK' : S(ev.amount) + ' ' + sym} from ${addrLink(ev.from)} to ${addrLink(ev.to)}`;
    case 'StableMinted': return `${S(ev.amount)} ${sym} minted to ${addrLink(ev.to)} · reserve: ${esc(ev.reserveRef)}`;
    case 'StableRedeemed': return `${S(ev.amount)} ${sym} redeemed`;
    case 'ProjectCreated': return `<a href="#/project/${ev.projectId}">${ev.projectId}</a> ${ev.kind === 'proposed' ? 'proposed' : 'registered'}: “${esc(ev.name)}” (${esc(ev.projectType)}) by ${addrLink(ev.owner)}`;
    case 'ProjectUpdated': return `<a href="#/project/${ev.projectId}">${ev.projectId}</a> revision ${ev.revision}${ev.changed?.length ? `: ${ev.changed.map(fieldLabel).map(esc).join(', ')}` : ''}`;
    case 'ProjectLocked': return `<a href="#/project/${ev.projectId}">${ev.projectId}</a> locked and submitted · fingerprint <span class="mono small">${short(ev.contentHash, 10)}</span>`;
    case 'ProjectRetired': return `<a href="#/project/${ev.projectId}">${ev.projectId}</a> retired: ${esc(ev.reason)}`;
    case 'ProjectTypeAdded': return `Project type “${esc(ev.projectType)}” added`;
    case 'ValidatorAdded': return `${addrLink(ev.validator)} added as validator (${esc(ev.name)})`;
    case 'ValidatorRemoved': return `${addrLink(ev.validator)} removed from the validator set`;
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
    ${kpi('FDK (utility)', F(a.fdk, 4), 'network fees', 'green')}
    ${kpi(esc(SYM()), S(a.stable), 'settlement stablecoin')}
    ${kpi('Projects', a.projects.length, `${a.projects.filter((p) => p.status === 'locked').length} locked & submitted`, 'green')}
    ${kpi('Roles', a.roles.length ? a.roles.map((r) => `<span class="pill green" style="margin:2px">${r}</span>`).join('') : '<span class="muted small">none</span>', `nonce ${a.nonce}`)}
  </div>
  <div class="grid g2 section">
    <div class="card"><h2>Projects</h2>${table(['Project', 'Type', 'Status'], a.projects.map((p) => `<tr><td><a href="#/project/${p.id}">${esc(p.name)}</a><div class="small muted mono">${p.id}</div></td><td class="small">${esc(p.projectType)}</td><td>${statusPill(p.status)}</td></tr>`), 'No projects.')}</div>
    ${a.dedications?.length ? `<div class="card"><h2>Tree dedications</h2>${table(['Dedication', 'Name', 'Tree'], a.dedications.map((d) => `<tr><td><a href="#/dedication/${d.id}">${d.id}</a></td><td>${dname(d)}</td><td>${d.tree ? `<a href="#/tree/${d.tree.id}">${d.tree.id}</a>` : '<span class="muted small">awaiting planting</span>'}</td></tr>`))}</div>` : ''}
    <div class="card"><h2>Activity</h2>${table(['Tx', 'Type', '#Block'], a.history.filter(Boolean).slice(0, 25).map((h) => `<tr><td>${txLink(h.tx.hash)}</td><td>${txPill(h.tx.type)}</td><td class="num">${h.height ? blockLink(h.height) : 'pending'}</td></tr>`), 'No activity yet.')}</div>
  </div>`;
}

// --------------------------------------------------------------- account
// Sign in like on the live platform: with email (Fedrok creates an account
// key for you in this browser), or with a browser wallet such as MetaMask
// (one signature message derives your Fedrok key; no funds move). The
// account's name and organisation are an on-chain profile, shown on its
// project pages.
const NEXT_KEY = 'fedrok.registry.next';
function askSignIn() {
  try { sessionStorage.setItem(NEXT_KEY, location.hash); } catch {}
  go('/wallet');
}
const signInNote = (why) => `<div class="note">${why} <button class="btn sm" type="button" data-signin>Sign in</button></div>`;

function busy(text) {
  const el = document.createElement('div');
  el.className = 'modal-back';
  el.innerHTML = `<div class="modal card busy" role="status" aria-live="polite"><span class="spinner"></span><div><b>Setting up your account</b><div class="small muted" data-step>${esc(text)}</div></div></div>`;
  document.body.appendChild(el);
  return { step: (t) => { el.querySelector('[data-step]').textContent = t; }, close: () => el.remove() };
}

async function finishSignIn(privKey, profile, meta = {}) {
  const address = Wallet.add(profile.name, privKey, meta);
  const b = busy('Creating your Fedrok account…');
  try {
    let acct = await api.account(address);
    if (STATUS.faucet && BigInt(acct.fdk) < fdk('0.05')) {
      b.step('Adding a little FDK for network fees…');
      await api.post('/api/faucet', { address });
      for (let i = 0; i < 40 && BigInt(acct.fdk) < fdk('0.05'); i++) {
        await new Promise((r) => setTimeout(r, 750));
        acct = await api.account(address);
      }
    }
    const org = String(profile.organisation || '').trim();
    if (!acct.profile || acct.profile.name !== profile.name || acct.profile.organisation !== org) {
      b.step('Saving your profile to the ledger…');
      await sendTx('profile_set', { name: profile.name, organisation: org });
    }
    toast(`Welcome, ${esc(profile.name)}. You are signed in.`, 'ok');
  } catch (e) {
    toast(`You are signed in, but setup did not finish: ${esc(e.message)}`, 'err', 9000);
  } finally {
    b.close();
  }
  let next = null;
  try { next = sessionStorage.getItem(NEXT_KEY); sessionStorage.removeItem(NEXT_KEY); } catch {}
  if (next && next !== location.hash) location.hash = next;
  else render();
}

const utf8Hex = (t) => '0x' + [...new TextEncoder().encode(t)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function signInWithBrowserWallet() {
  const eth = window.ethereum;
  if (!eth) return toast('No browser wallet found. Install MetaMask, or continue with email.', 'err');
  try {
    const [account] = await eth.request({ method: 'eth_requestAccounts' });
    const msg = `Sign in to Fedrok Registry\n\nThis signature creates your Fedrok registry key on ${STATUS.network}. It does not move any funds and costs no gas.\n\nWallet: ${account.toLowerCase()}`;
    const sig = await eth.request({ method: 'personal_sign', params: [utf8Hex(msg), account] });
    const key = '0x' + sha256Hex(String(sig).toLowerCase());
    const address = addressFromPrivate(key);
    const acct = await api.account(address);
    if (acct.profile) return finishSignIn(key, acct.profile, { via: 'wallet', linked: account.toLowerCase() });
    modal(`<h2>Your profile</h2><p class="small">Wallet ${short(account.toLowerCase(), 6)} is connected. Add the name people will see on your project pages.</p>
      <label>Your name<input name="name" minlength="2" maxlength="80" required autocomplete="name"></label>
      <label>Organisation <span class="hint">optional</span><input name="organisation" maxlength="120" autocomplete="organization"></label>
      <div class="actions"><button class="btn" type="submit" data-label="Continue">Continue</button><button class="btn ghost" data-close>Cancel</button></div>`,
    (d) => { finishSignIn(key, { name: d.name.trim(), organisation: d.organisation.trim() }, { via: 'wallet', linked: account.toLowerCase() }); });
  } catch (e) {
    toast(`Wallet sign-in cancelled: ${esc(e.message || e)}`, 'err');
  }
}

async function viewWallet() {
  const w = Wallet.list();
  const active = Wallet.active();
  if (!active) {
    const hasWallet = typeof window.ethereum !== 'undefined';
    const known = w.items.filter((i) => i.via === 'email' || i.via === 'wallet');
    return `${head('My account', 'Sign in to Fedrok', 'Your projects belong to your Fedrok account. Only you can edit, lock & submit or retire them.')}
    ${known.length ? `<div class="card" style="margin-bottom:18px"><h2>Welcome back</h2><div class="actions">${known.map((i) => `<button class="btn ghost" data-select="${i.address}">Continue as ${esc(i.name)}${i.email ? ` <span class="small muted">(${esc(i.email)})</span>` : ''}</button>`).join('')}</div></div>` : ''}
    <div class="grid g2 signin">
      <div class="card"><h2>Continue with email</h2>
        <form class="stack" id="signin-email">
          <label>Your name<input name="name" minlength="2" maxlength="80" required autocomplete="name" placeholder="e.g. Amara Osei"></label>
          <label>Organisation <span class="hint">optional · shown on your project pages</span><input name="organisation" maxlength="120" autocomplete="organization" placeholder="e.g. Green Valley Trust"></label>
          <label>Email<input name="email" type="email" required autocomplete="email" placeholder="you@example.org"></label>
          <div class="actions"><button class="btn">Continue</button></div>
        </form>
        <p class="small muted" style="margin-bottom:0">No crypto wallet needed: Fedrok creates a secure account key for you in this browser and signs your records with it.${LOCAL ? ' In this demo no email is sent.' : ''}</p>
      </div>
      <div class="card"><h2>Use a crypto wallet</h2>
        <p class="small" style="margin-top:0">Sign in with MetaMask or another browser wallet. You approve one signature message, which creates your Fedrok registry key. No funds move and it costs no gas. The same wallet gives you the same account on any device.</p>
        <div class="actions"><button class="btn ${hasWallet ? '' : 'ghost'}" id="signin-wallet" type="button">${icon('wallet')} ${hasWallet ? 'Connect wallet' : 'Connect MetaMask'}</button></div>
        ${hasWallet ? '' : '<p class="small muted">No browser wallet was found in this browser. Install MetaMask, or continue with email.</p>'}
        <details style="margin-top:18px"><summary class="small">I have a Fedrok account key</summary>
          <form class="stack" id="import" style="margin-top:12px"><label>Your name<input name="name" minlength="2" maxlength="80" required></label><label>Account key<input name="key" placeholder="0x… (64 hex characters)" required autocomplete="off"></label><div class="actions"><button class="btn ghost">Sign in with key</button></div></form>
        </details>
      </div>
    </div>`;
  }
  const acct = await api.account(active.address);
  const prof = acct.profile;
  const via = active.via === 'email' ? `Signed in with ${esc(active.email)}` : active.via === 'wallet' ? `Signed in with wallet ${short(active.linked, 6)}` : 'Signed in with an account key';
  return `${head('My account', esc(prof?.name || active.name), `${prof?.organisation ? esc(prof.organisation) + ' · ' : ''}${via}`, '<div class="actions"><button class="btn ghost sm" id="signout" type="button">Sign out</button></div>')}
  <div class="grid g2">
    <div class="card"><h2>My projects <a class="aside" href="#/new">Register a project</a></h2>${table(['Project', 'Status'], acct.projects.map((p) => `<tr><td><a href="#/project/${p.id}">${esc(p.name)}</a><div class="small muted">${esc(p.projectType)} · <span class="mono">${p.id}</span></div></td><td>${statusPill(p.status)}</td></tr>`), 'You have no projects yet. <a href="#/new">Register or propose one</a>.')}</div>
    <div class="card"><h2>Profile</h2>
      <form class="stack" id="profile">
        <label>Your name<input name="name" minlength="2" maxlength="80" required value="${esc(prof?.name || active.name)}"></label>
        <label>Organisation <span class="hint">optional</span><input name="organisation" maxlength="120" value="${esc(prof?.organisation || '')}"></label>
        <div class="actions"><button class="btn">Save profile</button></div>
      </form>
      <p class="small muted" style="margin-bottom:0">Your name and organisation are public: they are recorded on the ledger and shown on your project pages.${prof ? '' : ' <b>Not saved yet.</b>'}</p>
    </div>
  </div>
  <details class="card section"><summary><h2 style="display:inline">Account details</h2> <span class="small muted">address, network fee balance, tokens and keys</span></summary>
    <div class="grid g4" style="margin-top:16px">
      ${kpi('Account address', `<span class="mono" style="font-size:14px">${short(active.address, 8)}</span>`, acct.roles.join(', ') || 'no roles')}
      ${kpi('Network fee credit', F(acct.fdk, 4) + ' FDK', 'each record costs a tiny fee', 'green')}
      ${kpi(esc(SYM()), S(acct.stable), 'settlement stablecoin')}
      ${kpi('Records written', acct.nonce, 'transactions from this account')}
    </div>
    <div class="actions" style="margin-top:16px">
      <a class="btn ghost sm" href="#/address/${active.address}">View on explorer</a>
      <button class="btn ghost sm" id="copy-addr" type="button">Copy address</button>
      ${STATUS.faucet ? '<button class="btn ghost sm" id="faucet" type="button">Top up network fees (devnet)</button>' : ''}
    </div>
    <div class="grid g2 section">
      <div class="card"><h2>Send</h2>
        <form class="stack" id="send">
          <label>Recipient address<input name="to" placeholder="0x…" required></label>
          <div class="row">
            <label>Asset<select name="asset"><option value="STABLE">${esc(SYM())} (payment)</option><option value="FDK">FDK (utility)</option></select></label>
            <label>Amount<input name="amount" inputmode="decimal" placeholder="0.00" required></label>
          </div>
          <div class="actions"><button class="btn ghost">Sign and send</button></div>
        </form>
      </div>
      <div class="card"><h2>Recent activity</h2>${table(['Tx', 'Type', '#Status'], [...acct.pending.map((p) => `<tr><td>${txLink(p.hash)}</td><td>${txPill(p.type)}</td><td class="num"><span class="pill grad">pending</span></td></tr>`), ...acct.history.filter(Boolean).slice(0, 10).map((h) => `<tr><td>${txLink(h.tx.hash)}</td><td>${txPill(h.tx.type)}</td><td class="num">${blockLink(h.height)}</td></tr>`)], 'No activity yet.')}</div>
    </div>
    ${w.items.length > 1 ? `<div class="card section"><h2>Other accounts in this browser</h2>${table(['Name', 'Address', ''], w.items.filter((i) => i.address !== active.address).map((i) => `<tr><td>${esc(i.name)}${i.email ? `<div class="small muted">${esc(i.email)}</div>` : ''}</td><td>${addrLink(i.address)}</td><td class="num"><button class="btn ghost sm" data-select="${i.address}">Switch</button> <button class="btn ghost sm" data-remove="${i.address}">Forget</button></td></tr>`))}</div>` : ''}
  </details>`;
}

function bindWallet() {
  const on = (id, fn) => document.getElementById(id)?.addEventListener('submit', (e) => { e.preventDefault(); fn(formData(e.target), e.target); });
  on('signin-email', (d) => {
    const email = d.email.trim().toLowerCase();
    const known = Wallet.byEmail(email);
    finishSignIn(known ? known.privKey : generatePrivateKey(), { name: d.name.trim(), organisation: d.organisation.trim() }, { via: 'email', email });
  });
  document.getElementById('signin-wallet')?.addEventListener('click', signInWithBrowserWallet);
  on('import', (d) => {
    const k = d.key.trim().startsWith('0x') ? d.key.trim() : '0x' + d.key.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) return toast('An account key is 64 hex characters.', 'err');
    finishSignIn(k.toLowerCase(), { name: d.name.trim(), organisation: '' }, { via: 'key' });
  });
  on('profile', async (d, form) => {
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await sendTx('profile_set', { name: d.name.trim(), organisation: d.organisation.trim() });
      toast('Profile saved to the ledger.', 'ok');
      render();
    } catch (e) { toast(`Could not save: ${esc(e.message)}`, 'err', 9000); btn.disabled = false; }
  });
  on('send', (d) => {
    const amount = d.asset === 'FDK' ? fdk(d.amount) : stable(d.amount);
    if (!isAddress(d.to.trim().toLowerCase())) return toast('Recipient must be a 0x address.', 'err');
    submit('transfer', { to: d.to.trim().toLowerCase(), asset: d.asset, amount: amount.toString() }, `Send ${d.amount} ${d.asset === 'FDK' ? 'FDK' : SYM()}`);
  });
  document.getElementById('signout')?.addEventListener('click', () => { Wallet.signOut(); toast('Signed out.'); render(); });
  document.getElementById('faucet')?.addEventListener('click', async () => {
    try {
      await api.post('/api/faucet', { address: Wallet.active().address });
      toast('Top-up submitted. Your balance updates in the next block.', 'ok');
      setTimeout(render, 3500);
    } catch (e) { toast(esc(e.message), 'err'); }
  });
  document.getElementById('copy-addr')?.addEventListener('click', () => { Promise.resolve(navigator.clipboard?.writeText(Wallet.active().address)).then(() => toast('Address copied.'), () => toast('Copy failed. Address: ' + esc(Wallet.active().address))); });
  document.querySelectorAll('[data-select]').forEach((b) => b.addEventListener('click', () => { Wallet.select(b.dataset.select); render(); }));
  document.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => { Wallet.remove(b.dataset.remove); render(); }));
}

// Role-only parts of the demo (governance console, Garden team pages) offer
// a one-click operator sign-in on that page, so they stay usable.
const demoRole = (name, label) => (LOCAL ? ` <button class="btn sm ghost" type="button" data-demo-role="${esc(name)}">${label}</button>` : '');
document.addEventListener('click', (e) => {
  const signin = e.target.closest?.('[data-signin]');
  if (signin) { e.preventDefault(); askSignIn(); return; }
  const b = e.target.closest?.('[data-demo-role]');
  if (!b || !LOCAL) return;
  const d = LOCAL.demoIdentities.find((x) => x.name === b.dataset.demoRole);
  if (!d) return;
  Wallet.add(d.name, d.key, { via: 'demo' });
  toast(`Signed in as ${esc(d.name)} (demo operator).`, 'ok');
  render();
});

// ------------------------------------------------------- project registry
const sprout = createSprout({ api, sendTx, render: () => render(), toast, esc, status: () => STATUS, LOCAL });
// Register your project / Propose a project, the registry, and project pages
// with the Sprout assistant. Lock & submit and retirement are enforced by the
// ProjectRegistry contract: the page only offers what the contract allows.
const fieldLabel = (k) => CORE_FIELDS.concat(DETAIL_FIELDS).find((f) => f.key === k)?.label || k;
let CURRENT_PROJECT = null;

/** Sign and submit an action, wait for it, and throw with the node's reason on failure. */
async function sendTx(type, payload) {
  const w = Wallet.active();
  if (!w) throw new Error('sign in first');
  const { hash } = await api.send(w.privKey, type, payload);
  return api.wait(hash, 45_000);
}

function modal(html, onSubmit) {
  const el = document.createElement('div');
  el.className = 'modal-back';
  el.innerHTML = `<form class="modal card" role="dialog" aria-modal="true">${html}</form>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); close(); }));
  el.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    if (btn) { btn.disabled = true; btn.textContent = 'Signing…'; }
    const ok = await onSubmit(formData(e.target));
    if (ok !== false) close();
    else if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label; }
  });
  el.querySelector('input,textarea,select')?.focus();
}

async function viewNewProject() {
  const s = STATUS;
  const w = Wallet.active();
  const acct = w ? await api.account(w.address) : null;
  const lowFdk = acct && BigInt(acct.fdk) < fdk('0.05');
  return `${head('Register a project', 'Register your project or propose a project', 'Put an environmental project on the Fedrok ledger. Choose what kind of project it is to begin with; Sprout, your AI project guide, then takes you to the new project page and helps you fill in the details.')}
  ${!w ? signInNote('Sign in first: the project will belong to your account, and only you can edit, lock & submit or retire it.') : lowFdk ? `<div class="note">Your account has almost no FDK for network fees. ${s.faucet ? '<button class="btn sm accent" id="np-faucet" type="button">Top up network fees</button>' : 'Ask for FDK first.'}</div>` : ''}
  <form class="card newp" id="newp">
    <h2>1. What would you like to do?</h2>
    <div class="choice">
      <label class="opt"><input type="radio" name="kind" value="registered" checked><span>${icon('folder', 'icon-outline')}<b>Register your project</b><small>A project you run, own or represent, planned or already under way.</small></span></label>
      <label class="opt"><input type="radio" name="kind" value="proposed"><span>${icon('spark', 'icon-outline')}<b>Propose a project</b><small>An idea for an environmental project you would like to see happen.</small></span></label>
    </div>
    <h2 style="margin-top:26px">2. Choose an environmental project type</h2>
    <label>Project type<select name="projectType" required><option value="" disabled selected>Select an environmental project type to begin…</option>${s.projectTypes.map((t) => `<option>${esc(t)}</option>`).join('')}</select></label>
    <h2 style="margin-top:26px">3. The basics</h2>
    <div class="stack">
      <label>Project name<input name="name" minlength="3" maxlength="120" placeholder="e.g. Riverside Mangrove Restoration" required></label>
      <label>One-line summary <span class="hint">optional: Sprout will ask you about it</span><textarea name="summary" maxlength="1000" rows="2" placeholder="What the project does, for whom, and where"></textarea></label>
      <div class="row"><label>Location<input name="location" maxlength="160" placeholder="Region, district or site name"></label><label>Country<input name="country" maxlength="80" placeholder="e.g. Kenya"></label></div>
    </div>
    <div class="actions" style="margin-top:20px"><button class="btn" ${w ? '' : 'disabled'}>${icon('plus')} Create project page</button><span class="small muted">Creates a draft on-chain. You can change everything until you lock & submit it.</span></div>
  </form>`;
}

function bindNewProject() {
  document.getElementById('np-faucet')?.addEventListener('click', async () => {
    try { await api.post('/api/faucet', { address: Wallet.active().address }); toast('Faucet transfer submitted.', 'ok'); setTimeout(render, 3500); } catch (e) { toast(esc(e.message), 'err'); }
  });
  document.getElementById('newp')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Creating on-chain…';
    try {
      const r = await sendTx('project_create', { kind: d.kind, projectType: d.projectType, name: d.name.trim(), summary: d.summary.trim(), location: d.location.trim(), country: d.country.trim() });
      const id = r.events.find((x) => x.event === 'ProjectCreated').projectId;
      toast(`${id} created in block ${blockLink(r.height)}`, 'ok');
      sprout.welcome(id);
      go('/project/' + id);
    } catch (err) {
      toast('Could not create the project: ' + esc(err.message), 'err', 9000);
      btn.disabled = false;
      btn.innerHTML = `${icon('plus')} Create project page`;
    }
  });
}

async function viewProjects() {
  const all = await api.get('/api/projects');
  const f = Object.fromEntries(new URLSearchParams((location.hash.split('?')[1] || '')));
  const list = all.filter((p) => (!f.type || p.projectType === f.type) && (!f.status || p.status === f.status) && (!f.kind || p.kind === f.kind));
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === (cur || '') ? 'selected' : ''}>${esc(label)}</option>`;
  return `${head('Registry', 'Environmental project registry', 'Every registered and proposed project on the Fedrok ledger. Drafts are still being written by their owners; locked & submitted records can no longer be changed by anyone.', '<a class="btn" href="#/new">' + icon('plus') + ' Register or propose a project</a>')}
  <form class="filters card" id="pfilter">
    <label>Project type<select name="type">${opt('', 'All types', f.type)}${STATUS.projectTypes.map((t) => opt(t, t, f.type)).join('')}</select></label>
    <label>Status<select name="status">${opt('', 'Any status', f.status)}${opt('draft', 'Draft', f.status)}${opt('locked', 'Locked & submitted', f.status)}${opt('retired', 'Retired', f.status)}</select></label>
    <label>Kind<select name="kind">${opt('', 'Registered and proposed', f.kind)}${opt('registered', 'Registered projects', f.kind)}${opt('proposed', 'Proposals', f.kind)}</select></label>
    <div class="small muted" style="align-self:end;padding-bottom:10px">${list.length} of ${all.length} projects</div>
  </form>
  <div class="pgrid section">${list.map(projectCard).join('') || '<div class="empty">No projects match these filters.</div>'}</div>`;
}

function bindProjects() {
  document.getElementById('pfilter')?.addEventListener('change', (e) => {
    const q = new URLSearchParams(Object.entries(formData(e.currentTarget)).filter(([, v]) => v)).toString();
    location.hash = '#projects' + (q ? '?' + q : '');
  });
}

const fieldValue = (v) => (Array.isArray(v) ? `<ul class="plist">${v.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : /^https?:\/\//.test(String(v)) ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>` : esc(v).replace(/\n/g, '<br>'));

async function viewProject(id) {
  const p = await api.get('/api/project/' + id);
  CURRENT_PROJECT = p;
  const w = Wallet.active();
  const owner = w && w.address === p.owner;
  const draft = p.status === 'draft';
  const missing = missingFields(p);
  const pct = completeness(p);
  const filled = DETAIL_FIELDS.filter((f) => !missing.includes(f.key));
  const empty = DETAIL_FIELDS.filter((f) => missing.includes(f.key));
  const lockNote = p.status === 'locked'
    ? `<div class="note lockd">${icon('lock', 'icon-outline')}<div><b>Locked & submitted on ${day(p.lockedAt)}.</b> This record is permanently read-only. The registry contract rejects every change, from anyone, including the owner and Sprout. ${owner ? 'You can still retire the project.' : ''}<div class="small mono" style="margin-top:6px">Content fingerprint ${esc(p.lockedHash)}</div></div></div>`
    : p.status === 'retired'
      ? `<div class="note plain">${icon('lock', 'icon-outline')} <b>Retired on ${day(p.retiredAt)}</b>${p.retiredAfterLock ? ' after it was locked & submitted' : ''}: ${esc(p.retireReason)}. The record stays on the ledger, unchanged.</div>`
      : owner ? `<div class="note plain"><b>Draft.</b> You can keep changing this project, with Sprout or by hand, until you lock & submit it. ${p.pending.length ? `<br><span class="pill grad">${p.pending.length} change(s) waiting for the next block</span>` : ''}</div>` : '';
  return `${head(`${p.kind === 'proposed' ? 'Proposed project' : 'Registered project'} · ${p.id}`, esc(p.name), `${esc(p.projectType)}${p.location || p.country ? ' · ' + esc([p.location, p.country].filter(Boolean).join(', ')) : ''}<br><span class="small">by ${ownerText(p.ownerProfile, p.owner)}${p.ownerProfile?.organisation ? ` · ${esc(p.ownerProfile.name)}` : ''}</span>`, `<div class="actions">${statusPill(p.status)}${owner && draft ? `<button class="btn accent sm" id="open-sprout" type="button">${icon('spark')} Talk to Sprout</button>` : `<button class="btn ghost sm" id="open-sprout" type="button">${icon('spark')} Ask Sprout</button>`}</div>`)}
  ${lockNote}
  <div class="pgrid2">
    <div class="stack-col">
      <div class="card"><h2>Overview ${draft ? `<span class="aside">${pct}% complete</span>` : ''}</h2>
        ${draft ? `<div class="bar"><span style="width:${pct}%"></span></div>` : ''}
        <p class="lead-text">${p.summary ? esc(p.summary) : '<span class="muted">No summary yet.</span>'}</p>
        <div class="kv">
          <div>Project type</div><div>${esc(p.projectType)}</div>
          <div>Kind</div><div>${kindPill(p.kind)}</div>
          <div>Location</div><div>${esc(p.location) || '<span class="muted">—</span>'}</div>
          <div>Country</div><div>${esc(p.country) || '<span class="muted">—</span>'}</div>
        </div>
      </div>
      <div class="card"><h2>Project details</h2>
        ${filled.length ? `<div class="kv details">${filled.map((f) => `<div>${esc(f.label)}</div><div>${fieldValue(p.details[f.key])}</div>`).join('')}</div>` : `<div class="empty">${draft ? 'No details yet. ' + (owner ? 'Talk to Sprout to fill them in.' : '') : 'No details were recorded.'}</div>`}
        ${draft && empty.length ? `<div class="small muted" style="margin-top:14px">Still to add: ${empty.map((f) => esc(f.label)).join(' · ')}</div>` : ''}
      </div>
      ${owner && draft ? `<details class="card" id="manual"><summary><h2 style="display:inline">Edit by hand</h2> <span class="small muted">Sprout can do this for you, but you can also edit every field yourself.</span></summary>
        <form class="stack" id="pedit" style="margin-top:16px">
          <label>Project name<input name="name" value="${esc(p.name)}" minlength="3" maxlength="120" required></label>
          <label>Summary<textarea name="summary" rows="3" maxlength="1000">${esc(p.summary)}</textarea></label>
          <div class="row"><label>Location<input name="location" value="${esc(p.location)}" maxlength="160"></label><label>Country<input name="country" value="${esc(p.country)}" maxlength="80"></label></div>
          ${DETAIL_FIELDS.map((f) => { const v = p.details[f.key]; const val = Array.isArray(v) ? v.join('\n') : v || ''; return `<label>${esc(f.label)} <span class="hint">${esc(f.hint)}${f.list ? ' One per line.' : ''}</span>${f.long || f.list ? `<textarea name="d_${f.key}" rows="${f.list ? 3 : 2}">${esc(val)}</textarea>` : `<input name="d_${f.key}" value="${esc(val)}">`}</label>`; }).join('')}
          <div class="actions"><button class="btn">Save changes on-chain</button></div>
        </form></details>` : ''}
    </div>
    <div class="stack-col">
      <div class="card"><h2>Ledger record</h2>
        <div class="kv">
          <div>Owner</div><div>${ownerFull(p.ownerProfile, p.owner)}${owner ? ' <span class="pill green">you</span>' : ''}</div>
          <div>Created</div><div>${date(p.createdAt)}</div>
          <div>Revision</div><div>${p.revision} edit(s) · updated ${ago(p.updatedAt)}</div>
          <div>Fingerprint</div><div class="mono small" title="${esc(p.contentHash)}">${short(p.contentHash, 12)}</div>
        </div>
        ${owner && p.status !== 'retired' ? `<div class="actions" style="margin-top:18px">
          ${draft ? `<button class="btn" id="lock-btn" type="button">${icon('lock')} Lock & submit</button>` : ''}
          <button class="btn ghost" id="retire-btn" type="button">Retire project</button>
        </div>
        ${draft ? '<p class="small muted" style="margin-bottom:0">Lock & submit makes the record permanently read-only for everyone, Sprout included. Only retirement stays possible.</p>' : ''}` : ''}
        ${!w ? `<p class="small muted">Owner? <a href="#/wallet" data-signin>Sign in</a> to edit this project.</p>` : ''}
      </div>
      <div class="card"><h2>History</h2>
        <div class="feed">${p.history.slice().reverse().map((h) => `<div class="feed-item"><div class="blockbadge ${h.action === 'locked' ? 'g' : ''}">${h.action === 'updated' ? 'r' + h.revision : h.action[0].toUpperCase()}</div><div><div><b>${esc(h.action === 'created' ? 'Created' : h.action === 'updated' ? `Revision ${h.revision}` : h.action === 'locked' ? 'Locked & submitted' : 'Retired')}</b> ${txLink(h.tx)}</div><div class="small muted">${h.changed?.length ? esc(h.changed.map(fieldLabel).join(', ')) : h.reason ? esc(h.reason) : h.contentHash ? 'fingerprint ' + short(h.contentHash, 8) : ''}</div></div><div class="small muted">${ago(h.at)}</div></div>`).join('')}</div>
      </div>
    </div>
  </div>`;
}

function contentOf(p) {
  return { name: p.name, summary: p.summary, location: p.location, country: p.country, details: { ...p.details } };
}

function bindProject() {
  const p = CURRENT_PROJECT;
  document.getElementById('open-sprout')?.addEventListener('click', () => sprout.open());
  document.getElementById('pedit')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const d = formData(e.target);
    const details = {};
    for (const f of DETAIL_FIELDS) {
      const v = (d['d_' + f.key] || '').trim();
      if (!v) continue;
      details[f.key] = f.list ? v.split('\n').map((x) => x.trim()).filter(Boolean) : v;
    }
    submit('project_update', { projectId: p.id, name: d.name.trim(), summary: d.summary.trim(), location: d.location.trim(), country: d.country.trim(), details }, `Save ${p.id}`);
  });
  document.getElementById('lock-btn')?.addEventListener('click', () => {
    const m = missingFields(p);
    modal(`<h2>Lock & submit ${esc(p.id)}?</h2>
      <p>Locking freezes <b>${esc(p.name)}</b> on the Fedrok ledger for good. After this, the registry contract rejects every change, from you, from governance and from Sprout. You will still be able to <b>retire</b> the project.</p>
      ${m.length ? `<div class="note">These fields are still empty: ${m.map((k) => esc(fieldLabel(k))).join(', ')}. You can lock anyway, but they can never be added later.</div>` : ''}
      <p class="small">You are locking exactly the version shown on the page, fingerprint <span class="mono">${esc(short(p.contentHash, 14))}</span>. If it changes before your transaction is mined, the lock is refused.</p>
      <label class="check"><input type="checkbox" name="ack" required> I understand this cannot be undone</label>
      <div class="actions" style="margin-top:16px"><button class="btn" type="submit" data-label="Lock & submit">${icon('lock')} Lock & submit</button><button class="btn ghost" data-close>Cancel</button></div>`, async () => {
      try {
        const r = await sendTx('project_lock', { projectId: p.id, contentHash: p.contentHash });
        toast(`${esc(p.id)} locked and submitted in block ${blockLink(r.height)}`, 'ok');
        sprout.notify(`The project was locked & submitted. It is now permanently read-only, so I can no longer change it.`);
        render();
      } catch (e) {
        toast('Lock failed: ' + esc(e.message), 'err', 9000);
        return false;
      }
    });
  });
  document.getElementById('retire-btn')?.addEventListener('click', () => {
    modal(`<h2>Retire ${esc(p.id)}?</h2>
      <p>Retiring marks <b>${esc(p.name)}</b> as no longer active. Its record stays on the ledger exactly as it is${p.status === 'locked' ? ', locked' : ''}. Retirement cannot be undone, and a retired project cannot be edited.</p>
      <label>Reason <span class="hint">shown publicly on the project page</span><textarea name="reason" maxlength="300" rows="3" required placeholder="e.g. Project completed in 2031; land returned to the community"></textarea></label>
      <div class="actions" style="margin-top:16px"><button class="btn" type="submit" data-label="Retire project">Retire project</button><button class="btn ghost" data-close>Cancel</button></div>`, async (d) => {
      try {
        const r = await sendTx('project_retire', { projectId: p.id, reason: d.reason.trim() });
        toast(`${esc(p.id)} retired in block ${blockLink(r.height)}`, 'ok');
        sprout.notify('The project was retired. Its record stays on the ledger unchanged.');
        render();
      } catch (e) {
        toast('Retirement failed: ' + esc(e.message), 'err', 9000);
        return false;
      }
    });
  });
}

// --------------------------------------------------------------- console
async function viewConsole() {
  const active = Wallet.active();
  if (!active) return `${head('Console', 'Governance console')}<div class="note plain">Sign in with the governance or stablecoin-issuer account to use the console.${LOCAL ? demoRole('Fedrok AG governance', 'Demo: sign in as Fedrok governance') : ' On the devnet these keys are in <code>devnet/keys/</code>.'}</div>`;
  const acct = await api.account(active.address);
  const roles = acct.roles;
  const isGov = roles.includes('governance'), isIss = roles.includes('stablecoin-issuer');
  const s = STATUS;
  return `${head('Console', 'Governance console', `Signed in as ${addrLink(active.address, active.name)} · roles: ${roles.map((r) => `<span class="pill green">${r}</span>`).join(' ') || 'none'}`)}
  ${!isGov && !isIss ? '<div class="note">This wallet has no privileged role. Governance (Fedrok AG, later a DAO) manages the validator set, the list of project types and network parameters. Governance cannot edit anyone\'s project.</div>' : ''}
  <div class="grid g2">
  ${isGov ? `<div class="card"><h2>Validators <span class="aside">Proof of Authority</span></h2>
      ${table(['Validator', '#Blocks', ''], s.consensus.validators.map((v) => `<tr><td>${esc(v.name)}<div>${addrLink(v.address)}</div></td><td class="num">${v.blocks}</td><td class="num">${s.consensus.validators.length > 1 ? `<button class="btn ghost sm" data-rmval="${v.address}">Remove</button>` : ''}</td></tr>`))}
      <form class="stack" id="addval" style="margin-top:16px"><h3>Add a validator</h3><div class="row"><label>Validator address<input name="validator" placeholder="0x…" required></label><label>Name<input name="name" placeholder="Fedrok validator Basel" required></label></div><div class="actions"><button class="btn">Add validator</button></div></form>
    </div>
    <div class="card"><h2>Project types</h2>
      <div class="rr">${s.projectTypes.map((t) => `<div class="slot">${esc(t)}</div>`).join('')}</div>
      <form class="stack" id="addtype" style="margin-top:16px"><label>New project type<input name="projectType" maxlength="80" required></label><div class="actions"><button class="btn ghost">Add to the dropdown</button></div></form>
      <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
      <form class="stack" id="param"><h3>Change a network parameter</h3><div class="row"><label>Parameter<select name="key">${['blockTimeMs', 'maxTxPerBlock', 'minGasPrice'].map((k) => `<option>${k}</option>`).join('')}</select></label><label>Value<input name="value" required></label></div><div class="actions"><button class="btn ghost">Update parameter</button></div></form>
    </div>` : ''}
  ${isIss ? `<div class="card"><h2>Mint ${esc(SYM())} stablecoin</h2>
      <form class="stack" id="smint">
        <label>Recipient<input name="to" placeholder="0x…" required></label>
        <div class="row"><label>Amount (${esc(SYM())})<input name="amount" inputmode="decimal" required></label><label>Reserve attestation reference<input name="reserveRef" required></label></div>
        <div class="actions"><button class="btn">Mint</button></div>
      </form></div>` : ''}
  </div>`;
}

function bindConsole() {
  const on = (id, fn) => document.getElementById(id)?.addEventListener('submit', async (e) => { e.preventDefault(); try { await fn(formData(e.target)); } catch (err) { toast(esc(err.message), 'err'); } });
  on('smint', (d) => submit('stable_mint', { to: d.to.trim().toLowerCase(), amount: stable(d.amount).toString(), reserveRef: d.reserveRef }, `Mint ${d.amount} ${SYM()}`));
  on('addval', (d) => submit('gov_add_validator', { validator: d.validator.trim().toLowerCase(), name: d.name }, 'Add validator'));
  on('addtype', (d) => submit('gov_add_project_type', { projectType: d.projectType.trim() }, 'Add project type'));
  on('param', (d) => submit('gov_set_param', { key: d.key, value: String(d.value).trim() }, `Set ${d.key}`));
  document.querySelectorAll('[data-rmval]').forEach((b) => b.addEventListener('click', () => submit('gov_remove_validator', { validator: b.dataset.rmval }, 'Remove validator')));
}

// ------------------------------------------------------------ developers
async function viewDevelopers() {
  const s = STATUS;
  const origin = location.origin;
  const C = s.contracts || {};
  const CONTRACT_INFO = {
    FedrokGovernance: 'Roles (governance, stablecoin issuer), the Proof of Authority validator set and network parameters',
    FDKIssuer: 'Capped FDK reserve and burns',
    FUSD: 'Settlement stablecoin stand-in (ERC-20, 6 decimals)',
    ProjectRegistry: 'Environmental project registry: create, edit drafts, lock & submit (permanently read-only), retire',
    LegacyGarden: 'Personal Legacy Garden memorial tree registry',
  };
  return `${head('Developers', 'Build on Fedrok', 'Fedrok is EVM-compatible: transactions are standard signed Ethereum transactions, the registry is a set of Solidity contracts, and every node speaks Ethereum JSON-RPC at /rpc. MetaMask, ethers.js, viem, Foundry and Hardhat work unchanged. FDK is the native gas token.')}
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
      <p class="small">Fedrok read model: <code>fdk_status</code> <code>fdk_getAccount</code> <code>poa_getValidators</code> <code>registry_getProjects</code> <code>registry_getProject</code> <code>garden_getGarden</code> <code>garden_getTree</code> <code>garden_getDedication</code></p>
    </div>
    <div class="card"><h2>ethers.js</h2><pre class="code">import { JsonRpcProvider, Wallet, Contract } from 'ethers';

const provider = new JsonRpcProvider('${origin}/rpc');
const wallet = new Wallet(privKey, provider);
const registry = new Contract('${C.ProjectRegistry || '0x…'}', [
  'function project(uint64 id) view returns (tuple(uint64 id, uint8 kind, uint8 status, address owner, string projectType, string name, string summary, string location, string country, string details, uint32 revision, uint64 createdAt, uint64 updatedAt, uint64 lockedAt, uint64 retiredAt, bytes32 lockedHash, string retireReason))',
], wallet);
const p = await registry.project(1); // PRJ-000001
console.log(p.name, ['draft', 'locked', 'retired'][p.status]);</pre>
    <p class="small">Or use the bundled SDK, which encodes the same calls: <code>new FedrokClient(url).sendAndWait(privKey, 'project_create', { kind: 'registered', projectType: 'Solar energy', name: 'Village solar' })</code>.</p></div>
  </div>
  <div class="card section"><h2>REST endpoints</h2>${table(['Method', 'Path', 'Description'], [
    ['GET', '/api/status', 'Chain, consensus, supply and peer status'], ['GET', '/api/blocks?limit=&before=', 'Recent block summaries'], ['GET', '/api/block/:heightOrHash', 'Full block with transactions'],
    ['GET', '/api/tx/:hash', 'Transaction with status, gas, logs and decoded events'], ['GET', '/api/account/:address', 'Balances, projects, roles, history, next nonce'], ['POST', '/api/tx', 'Submit a signed raw Ethereum transaction: { raw }'], ['GET', '/api/contracts', 'System contract addresses'],
    ['GET', '/api/projects?type=&status=&kind=&owner=', 'Registered and proposed projects'], ['GET', '/api/project/:id', 'Full project record with details, history and content fingerprint'], ['GET', '/api/project-types', 'Environmental project types offered when creating a project'], ['GET', '/api/validators', 'Proof of Authority validator set'],
    ['POST', '/api/assistant/v1/messages', 'Claude API proxy for the Sprout assistant (only when the node has ANTHROPIC_API_KEY)'],
    ['GET', '/api/gardens · /api/garden/:id', 'Legacy Gardens with batches, stats, site plan and field records'], ['GET', '/api/tree/:id · /api/dedication/:id', 'Tree record (plantings, inspections, replacements) and subscribership certificate'], ['GET', '/api/dedications?holder=&garden=', 'Dedications held by a member account'], ['GET', '/api/search?q=', 'Resolve a block, tx, address, project, tree or dedication'],
    ['WS', '/ws', 'Live feed of blocks and transactions'],
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
  const pick = 'Sign in with the account linked to your Garden membership.' + demoRole('Garden member (Mensah family)', 'Demo: view as a Garden member');
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
  const intro = 'Sign in with the Garden operator or a steward account.' + demoRole('Garden operator', 'Demo: sign in as the Garden operator') + demoRole('Garden field steward', 'Demo: sign in as a field steward');
  if (!w) return `${head('Personal Legacy Garden', 'Steward console')}<div class="note plain">${intro}</div>`;
  const [acct, gardens] = await Promise.all([api.account(w.address), api.get('/api/gardens')]);
  if (!isGardenRole(acct.roles) || !gardens.length) return `${head('Personal Legacy Garden', 'Steward console')}<div class="note plain">This account is not the operator or a steward of a Garden. ${intro}</div>`;
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
  [/^\/new$/, viewNewProject, bindNewProject],
  [/^\/projects$/, viewProjects, bindProjects],
  [/^\/project\/(.+)$/, viewProject, bindProject],
  [/^\/explorer$/, viewExplorer],
  [/^\/block\/(.+)$/, viewBlock],
  [/^\/tx\/(.+)$/, viewTx],
  [/^\/address\/(.+)$/, viewAddress],
  [/^\/wallet$/, viewWallet, bindWallet],
  [/^\/console$/, viewConsole, bindConsole],
  [/^\/garden$/, viewGarden],
  [/^\/garden\/(.+)$/, viewGarden],
  [/^\/tree\/(.+)$/, viewTree],
  [/^\/dedication\/(.+)$/, viewDedication],
  [/^\/member$/, viewMember],
  [/^\/steward$/, viewSteward, bindSteward],
  [/^\/developers$/, viewDevelopers, bindDevelopers],
];
const LIVE = ['/', '/explorer', '/garden', '/projects'];

function renderNav(path) {
  document.getElementById('nav').innerHTML = NAV.map(([href, label, ic]) => {
    const on = href === '/' ? path === '/' : path.startsWith(href) || (href === '/explorer' && /^\/(block|tx|address)\//.test(path)) || (href === '/projects' && path.startsWith('/project/')) || (href === '/garden' && /^\/(tree|dedication|steward)/.test(path));
    return `<a href="${toHash(href)}" class="${on ? 'active' : ''}">${icon(ic)}<span>${label}</span></a>`;
  }).join('');
}

function renderFoot(live) {
  const s = STATUS;
  const w = Wallet.active();
  document.getElementById('side-foot').innerHTML = s
    ? `<div><span class="dot ${live ? 'live' : ''}"></span>${esc(s.node)} · #${Number(s.height).toLocaleString('en-GB')}</div><div style="margin-top:6px">${w ? `Signed in: <a style="color:#fff" href="#/wallet">${esc(w.name)}</a>` : '<a style="color:#fff" href="#/wallet" data-signin>Sign in</a>'}</div>`
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
    if (path.startsWith('/project/') && CURRENT_PROJECT) sprout.attach(CURRENT_PROJECT, Wallet.active());
    else sprout.detach();
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
    if ((LIVE.includes(currentRoute) || (currentRoute.startsWith('/project/') && CURRENT_PROJECT?.pending?.length)) && !busy) {
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
