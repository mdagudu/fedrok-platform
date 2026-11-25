// Fedrok Taxi Integrity web app. Runs the whole pilot network in the browser:
// three validator nodes, the EU record store and eight in-car units.
import { FleetNetwork } from '../src/core/network.js';
import { buildDemo, STRANGER_HAND } from '../src/core/scenario.js';
import { alerts, driverSummary, workingLog, maltaDay, TZ, H, DAY, MAX_HOURS_24 } from '../src/core/compliance.js';
import { GARAGES, PLACES, MALTA_CENTRE, offsetM, distanceM } from '../src/core/geo.js';
import { hashObject } from '../src/core/crypto.js';
import * as L from 'leaflet';

const STORE_KEY = 'fedrok-taxi-pilot-v1';
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
let net;

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (h, n = 10) => (h ? `${h.slice(0, n)}…${h.slice(-6)}` : '');
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const fmtDate = (ts) => new Date(ts).toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const fmtDT = (ts) => `${fmtDate(ts)}, ${fmtTime(ts)}`;
const ago = (ts) => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const hrs = (x) => `${x.toFixed(1)} h`;
const plate = (id) => net.vehicle(id)?.plate || id;
const dname = (ref) => net.driver(ref)?.name || 'Unknown account';
const drivers = () => [...net.ledger.drivers.keys()].map((r) => net.driver(r)).sort((a, b) => a.name.localeCompare(b.name));
const vehicles = () => [...net.ledger.vehicles.values()];

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 5200);
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(net.export())); } catch { /* storage full or blocked: the demo still works in memory */ }
}

const ICONS = {
  overview: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  car: '<path d="M5 17h14M6 17v2M18 17v2M4 13l2-6h12l2 6v4H4z"/><circle cx="8" cy="14.5" r="1"/><circle cx="16" cy="14.5" r="1"/>',
  map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
  drivers: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.8 3 2.5 3.5 5.2"/>',
  alerts: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.5"/>',
  ledger: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><path d="M10 6.5h4M17.5 10v4"/>',
  verify: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  how: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17v.5"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[k]}</svg>`;
const NAV = [
  ['', 'Overview', 'overview'], ['car', 'In-car unit', 'car'], ['map', 'Fleet map', 'map'], ['drivers', 'Drivers & hours', 'drivers'],
  ['alerts', 'Compliance alerts', 'alerts'], ['ledger', 'Ledger', 'ledger'], ['verify', 'Verify & audit', 'verify'], ['how', 'How it works', 'how'],
];

function renderNav(active) {
  $('#nav').innerHTML = NAV.map(([p, label, ic]) => `<a href="#/${p}" class="${active === p ? 'active' : ''}">${icon(ic)}${label}</a>`).join('');
  const h = net.ledger.head;
  $('#side-foot').innerHTML = `<span class="dot live"></span>Block #${h.header.height} · ${net.ledger.validators.length} validators<br><span style="opacity:.75">Sealed ${ago(h.header.ts)}</span>`;
}

// ---------------------------------------------------------------- maps
const COLORS = { on: '#056032', parked: '#404042', flag: '#f0492c', garage: '#056032' };
function makeMap(el, { zoom = 11, center = MALTA_CENTRE } = {}) {
  if (!L?.map) { el.innerHTML = '<div class="map-fallback">The map could not load (offline?). All locations are still listed below.</div>'; return null; }
  const m = L.map(el, { scrollWheelZoom: false, attributionControl: true, fadeAnimation: false }).setView(center, zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(m);
  setTimeout(() => m.invalidateSize(), 50);
  return m;
}
function garageLayer(m, garages) {
  for (const g of garages) {
    L.circle([g.lat, g.lon], { radius: Math.max(g.radiusM, 60), color: COLORS.garage, weight: 1.5, dashArray: '4 4', fillOpacity: 0.08 })
      .addTo(m).bindPopup(`<b>${esc(g.name)}</b><br>Approved garage · geofence ${g.radiusM} m`);
  }
}

/** Where each car is now: on shift (sign-in point) or parked (last sign-out point). */
function fleetPositions() {
  return vehicles().map((v) => {
    const open = net.ledger.openShifts.get(v.vehicleId);
    if (open) {
      const rec = net.store.get(net.ledger.getTx(open.signinTx).tx.body.recordHash)?.record;
      return { v, state: 'on', driverRef: open.driverRef, ts: open.start, loc: rec?.location };
    }
    const last = [...net.ledger.shifts].reverse().find((s) => s.vehicleId === v.vehicleId);
    if (!last) return { v, state: 'parked', loc: null };
    const tx = net.ledger.getTx(last.signoutTx).tx;
    const rec = net.store.get(tx.body.recordHash)?.record;
    return { v, state: tx.body.flags.length ? 'flag' : 'parked', driverRef: last.driverRef, ts: last.end, loc: rec?.location, parked: rec?.parked, flags: tx.body.flags };
  });
}
function fleetMarkers(m, list) {
  const pts = [];
  for (const p of list) {
    if (!p.loc) continue;
    pts.push([p.loc.lat, p.loc.lon]);
    const what = p.state === 'on' ? `On shift · ${esc(dname(p.driverRef))} since ${fmtTime(p.ts)}` : `Parked ${fmtDT(p.ts)} by ${esc(dname(p.driverRef))}`;
    const flag = p.flags?.length ? `<br><span style="color:#a32c17">${p.flags.map(flagLabel).join(', ')}</span>` : '';
    L.circleMarker([p.loc.lat, p.loc.lon], { radius: 8, color: '#fff', weight: 2, fillColor: COLORS[p.state], fillOpacity: 1 })
      .addTo(m).bindPopup(`<b>${esc(p.v.plate)}</b><br>${what}${flag}<br><a href="#/car?v=${p.v.vehicleId}">Open in-car unit</a>`);
  }
  return pts;
}

const FLAG_LABELS = {
  'parked-outside-garage': 'Parked outside approved garage',
  'location-unauthenticated': 'Location not authenticated (no OSNMA)',
  'location-network-mismatch': 'Network places car elsewhere',
};
const flagLabel = (f) => FLAG_LABELS[f] || f.replace(/^denied:/, 'Refused: ').replace('rule:', '');
const TX_LABELS = {
  'vehicle.register': 'Car registered', 'driver.enrol': 'Driver enrolled', 'driver.suspend': 'Driver suspended',
  'shift.signin': 'Palm sign-in', 'shift.signout': 'Palm sign-out', 'access.denied': 'Sign-in refused', 'record.erase': 'Record erased (GDPR)',
};
function txSummary(tx) {
  const b = tx.body;
  switch (tx.type) {
    case 'shift.signin': return `${esc(dname(b.driverRef))} signed in to ${esc(plate(b.vehicleId))}`;
    case 'shift.signout': return `${esc(dname(b.driverRef))} signed out of ${esc(plate(b.vehicleId))}`;
    case 'access.denied': return `Palm did not match ${esc(dname(b.claimedDriverRef))} in ${esc(plate(b.vehicleId))}`;
    case 'vehicle.register': return `${esc(b.plate)} · ${esc(b.model)} · ${esc(b.garage.name)}`;
    case 'driver.enrol': return `${esc(dname(b.driverRef))} · palm template committed`;
    case 'record.erase': return `Record ${short(b.recordHash, 8)} deleted from EU store`;
    default: return tx.type;
  }
}
function txPill(tx) {
  const bad = tx.type === 'access.denied' || tx.body.flags?.length;
  const cls = tx.type === 'record.erase' ? 'grey' : bad ? 'warn' : tx.type.startsWith('shift') ? 'green' : 'grey';
  return `<span class="pill ${cls}">${TX_LABELS[tx.type]}</span>`;
}
function recentTxs(n = 12, filter = () => true) {
  const out = [];
  for (let i = net.ledger.blocks.length - 1; i > 0 && out.length < n; i--) {
    const b = net.ledger.blocks[i];
    for (const tx of [...b.txs].reverse()) if (filter(tx) && out.length < n) out.push({ tx, height: b.header.height });
  }
  return out;
}
const feed = (items) => items.length ? `<div class="feed">${items.map(({ tx, height }) => `
  <div class="feed-item"><a class="blockbadge${tx.type === 'access.denied' || tx.body.flags?.length ? ' g' : ''}" href="#/block/${height}">#${height}</a>
  <div><div>${txSummary(tx)}</div><div class="small muted">${fmtDT(tx.ts)} · <a href="#/tx/${tx.id}">${short(tx.id, 8)}</a></div></div>
  <div>${txPill(tx)}</div></div>`).join('')}</div>` : '<div class="empty">Nothing yet</div>';

function alertList(list, limit = 99) {
  if (!list.length) return '<div class="empty">No open alerts</div>';
  return list.slice(0, limit).map((a) => {
    const link = a.recordHash ? `#/verify?h=${a.recordHash}` : a.txId ? `#/tx/${a.txId}` : a.driverRef ? `#/driver/${a.driverRef}` : '#/alerts';
    return `<div class="alert-item"><span class="sev ${a.sev}"></span><div><a href="${link}">${esc(a.title)}</a><p>${esc(a.detail)}${a.ts ? ` · ${fmtDT(a.ts)}` : ''}</p></div></div>`;
  }).join('');
}

// ---------------------------------------------------------------- pages
function pageOverview() {
  const now = Date.now();
  const al = alerts(net, now);
  const today = maltaDay(now);
  const eventsToday = recentTxs(500, (t) => t.type.startsWith('shift') || t.type === 'access.denied').filter(({ tx }) => maltaDay(tx.ts) === today).length;
  const on = net.ledger.openShifts.size;
  app.innerHTML = `<div class="page">
    <div class="hero"><div class="ring"></div><div class="disc"></div>
      <div class="eyebrow" style="color:var(--sandy)">Fedrok Taxi · Malta pilot</div>
      <h1>Proving who drove, and where</h1>
      <p>Every shift starts and ends with a palm-vein scan in the car. The car seals the driver match and its Galileo-authenticated position, and the record's hash is anchored on a permissioned ledger shared with Transport Malta.</p>
      <div class="mode">${icon('verify')}<span>Live demo network · 3 validators · runs in your browser · <a href="#/car">try a sign-in</a></span></div>
    </div>
    <div class="grid g4">
      <div class="kpi green"><div class="label">Cars on shift</div><div class="value">${on}<small>/ ${net.ledger.vehicles.size}</small></div><div class="sub">${net.ledger.vehicles.size - on} parked</div></div>
      <div class="kpi green"><div class="label">Enrolled drivers</div><div class="value">${net.ledger.drivers.size}</div><div class="sub">Palm templates stay in the cars</div></div>
      <div class="kpi"><div class="label">Events sealed today</div><div class="value">${eventsToday}</div><div class="sub">Sign-ins, sign-outs, refusals</div></div>
      <div class="kpi"><div class="label">Open alerts</div><div class="value">${al.filter((a) => a.sev === 'high').length}<small>high · ${al.length} total</small></div><div class="sub"><a href="#/alerts">Review alerts</a></div></div>
    </div>
    <div class="grid g2 section">
      <div class="card"><h2>Fleet now <span class="aside"><a href="#/map">Full map</a></span></h2><div class="map sm" id="ov-map"></div>
        <div class="legend small"><span><i style="background:${COLORS.on}"></i>On shift</span><span><i style="background:${COLORS.parked}"></i>Parked in garage</span><span><i style="background:${COLORS.flag}"></i>Flagged</span><span><i class="ring" style="border-color:${COLORS.garage};border-style:dashed"></i>Approved garage</span></div></div>
      <div class="card"><h2>Alerts <span class="aside">Rules since 29 July 2026</span></h2>${alertList(al, 6)}</div>
    </div>
    <div class="grid g2 section">
      <div class="card"><h2>Latest ledger events <span class="aside"><a href="#/ledger">All blocks</a></span></h2>${feed(recentTxs(8, (t) => t.type !== 'vehicle.register' && t.type !== 'driver.enrol'))}</div>
      <div class="card"><h2>Validators</h2>${validatorsHtml()}
        <p class="small muted" style="margin:14px 0 0">A block is final when 2 of the 3 organisations sign it. The proposer rotates each block. Only hashes and pseudonymous references are on the ledger.</p></div>
    </div></div>`;
  const m = makeMap($('#ov-map'), { zoom: 10 });
  if (m) { garageLayer(m, vehicles().map((v) => v.garage)); fleetMarkers(m, fleetPositions()); }
}

function validatorsHtml() {
  const head = net.ledger.head;
  return net.ledger.validators.map((v) => {
    const proposed = net.ledger.blocks.filter((b) => b.header.proposer === v.id).length;
    return `<div class="validator"><span class="d"></span><div><b>${esc(v.name)}</b><div class="small muted">${esc(v.org)} · key ${short(v.pub, 8)}</div></div><div class="small muted">${proposed} proposed${head.sigs[v.id] ? ' · signed head' : ''}</div></div>`;
  }).join('');
}

// ---------------- in-car unit
const carState = { vehicleId: 'V01', mode: null, driverRef: null, hand: 'owner', gnss: 'osnma', park: 'garage', point: null, last: null };

function palmSvg(cls = '') {
  return `<svg class="palm ${cls}" viewBox="0 0 150 180" aria-hidden="true">
    <defs><linearGradient id="beamg" x1="0" x2="1"><stop offset="0" stop-color="#faa95b" stop-opacity="0"/><stop offset=".5" stop-color="#faa95b"/><stop offset="1" stop-color="#f0492c" stop-opacity="0"/></linearGradient></defs>
    <g fill="#24352b" stroke="#3b5446" stroke-width="1.2">
      <rect x="22" y="78" width="96" height="92" rx="30"/>
      <rect x="26" y="34" width="18" height="62" rx="9"/><rect x="48" y="14" width="18" height="76" rx="9"/>
      <rect x="70" y="10" width="18" height="80" rx="9"/><rect x="92" y="22" width="17" height="70" rx="8.5"/>
      <rect x="112" y="92" width="16" height="50" rx="8" transform="rotate(-30 120 117)"/>
    </g>
    <g class="vein"><path d="M70 165 C66 140 60 125 56 100 C54 88 56 70 57 50"/><path d="M70 165 C76 138 80 120 79 96 C79 80 79 60 79 30"/>
      <path d="M62 128 C50 120 42 110 36 96 C34 86 35 70 35 55"/><path d="M76 120 C90 112 98 104 100 92 C101 80 100 60 100 45"/>
      <path d="M58 145 C45 140 36 132 30 120"/><path d="M80 140 C95 136 108 128 116 118"/><path d="M56 100 C66 104 72 104 79 96"/></g>
    <rect class="beam" x="12" y="0" width="126" height="4" fill="url(#beamg)"/>
  </svg>`;
}

function pageCar(params) {
  if (params.get('v')) carState.vehicleId = params.get('v');
  const v = net.vehicle(carState.vehicleId) || vehicles()[0];
  carState.vehicleId = v.vehicleId;
  const open = net.ledger.openShifts.get(v.vehicleId);
  const ds = drivers();
  if (!carState.driverRef || !net.driver(carState.driverRef)) {
    const free = ds.find((d) => !net.ledger.driverOpen.has(d.ref));
    carState.driverRef = (free || ds[0]).ref;
  }
  const list = fleetPositions().map((p) => `<a href="#/car?v=${p.v.vehicleId}" class="${p.v.vehicleId === v.vehicleId ? 'active' : ''}"><span><b>${esc(p.v.plate)}</b><br><span class="small muted">${esc(p.v.model)}</span></span>
    ${p.state === 'on' ? `<span class="pill green"><span class="d"></span>${esc(dname(p.driverRef).split(' ')[0])}</span>` : '<span class="pill grey">Parked</span>'}</a>`).join('');
  const handOpts = (selfLabel) => `<option value="owner">${selfLabel}</option>${ds.map((d) => `<option value="${d.ref}">${esc(d.name)}</option>`).join('')}<option value="stranger">Someone not enrolled</option>`;
  const gnss = `<label>Satellite fix<select id="gnss"><option value="osnma" ${carState.gnss === 'osnma' ? 'selected' : ''}>Galileo OSNMA (genuine)</option><option value="spoof" ${carState.gnss === 'spoof' ? 'selected' : ''}>GPS-spoofing app running</option></select></label>`;
  const form = open
    ? `<div class="status on">● Signed in · ${esc(dname(open.driverRef))}</div>
       <p class="muted small" style="margin:6px 0 14px">Since ${fmtDT(open.start)} (${hrs((Date.now() - open.start) / H)}). To end the shift the same palm must be scanned, and the car records where it is parked.</p>
       <div class="row"><label>Whose hand is on the reader<select id="hand">${handOpts(`${esc(dname(open.driverRef))} (signed-in driver)`)}</select></label>${gnss}</div>
       <label style="margin-top:14px">Where the car is parked for the day</label>
       <div class="picker" id="park">
         <button type="button" data-p="garage" class="${carState.park === 'garage' ? 'on' : ''}">${esc(v.garage.name)} (approved)</button>
         <button type="button" data-p="street" class="${carState.park === 'street' ? 'on' : ''}">On a street nearby</button>
         <button type="button" data-p="map" class="${carState.park === 'map' ? 'on' : ''}">Pick on the map</button>
       </div>
       <div class="map sm" id="park-map" style="margin-top:12px;height:240px"></div>
       <div class="actions" style="margin-top:16px"><button class="btn accent" id="go">${icon('verify')}Scan palm and sign out</button></div>`
    : `<div class="status locked">● Locked · present palm to start a shift</div>
       <p class="muted small" style="margin:6px 0 14px">The driver picks their account on the screen and places their palm on the reader. The match is made in the car against the template stored there.</p>
       <div class="row"><label>Driver account<select id="acct">${ds.map((d) => `<option value="${d.ref}" ${d.ref === carState.driverRef ? 'selected' : ''}>${esc(d.name)}${net.ledger.driverOpen.has(d.ref) ? ` (in ${esc(plate(net.ledger.driverOpen.get(d.ref)))})` : ''}</option>`).join('')}</select></label>
       <label>Whose hand is on the reader<select id="hand">${handOpts('The account holder')}</select></label></div>
       <div class="row" style="margin-top:14px">${gnss}<div></div></div>
       <div class="actions" style="margin-top:16px"><button class="btn accent" id="go">${icon('verify')}Scan palm and sign in</button></div>`;
  app.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">In-car unit</div><h1>${esc(v.plate)}</h1><p class="lede">${esc(v.model)} · unit ${esc(v.unitId)} · approved garage ${esc(v.garage.name)}</p></div></div>
    <div class="grid" style="grid-template-columns:minmax(0,260px) minmax(0,1fr);gap:18px;align-items:start" id="car-grid">
      <div class="carlist">${list}</div>
      <div class="grid" style="gap:18px;align-items:start">
        <div class="unit"><h2>Driver console</h2>
          <div class="screen"><div class="palm-wrap"><div id="palm">${palmSvg()}</div><div>${form}</div></div></div>
          <p class="small muted" style="margin:12px 0 0">The scan is simulated: each person has their own vein pattern, and a different hand will not match.</p>
        </div>
        <div class="card"><h2>What gets recorded</h2><div id="result">${carState.last && carState.last.vehicleId === v.vehicleId ? resultHtml(carState.last) : idleSteps(open)}</div></div>
      </div>
    </div></div>`;
  if (window.matchMedia('(max-width: 1100px)').matches) $('#car-grid').style.gridTemplateColumns = 'minmax(0,1fr)';
  $('#gnss').onchange = (e) => (carState.gnss = e.target.value);
  if (!open) $('#acct').onchange = (e) => (carState.driverRef = e.target.value);
  if (open) setupParkMap(v);
  $('#go').onclick = () => doScan(v, open);
}

function setupParkMap(v) {
  const el = $('#park-map');
  const m = makeMap(el, { center: [v.garage.lat, v.garage.lon], zoom: 15 });
  let marker;
  const set = (p) => {
    carState.point = p;
    if (!m) return;
    if (marker) marker.setLatLng([p.lat, p.lon]); else marker = L.circleMarker([p.lat, p.lon], { radius: 9, color: '#fff', weight: 2, fillColor: '#f0492c', fillOpacity: 1 }).addTo(m);
    const d = distanceM(p, v.garage);
    marker.bindPopup(`${d <= v.garage.radiusM ? 'Inside' : `${d} m outside`} the approved garage`).openPopup();
  };
  if (m) garageLayer(m, [v.garage]);
  const pick = (mode) => {
    carState.park = mode;
    document.querySelectorAll('#park button').forEach((b) => b.classList.toggle('on', b.dataset.p === mode));
    if (mode === 'garage') set(offsetM(v.garage, 8, -6));
    if (mode === 'street') {
      const near = Object.values(PLACES).sort((a, b) => distanceM(a, v.garage) - distanceM(b, v.garage))[0];
      const p = distanceM(near, v.garage) < 3000 ? offsetM(near, 20, 15) : offsetM(v.garage, 420, 380);
      set(p);
      if (m) m.setView([p.lat, p.lon], 14);
    }
    if (mode === 'map' && m) toast('Click the map where the car is parked');
  };
  document.querySelectorAll('#park button').forEach((b) => (b.onclick = () => pick(b.dataset.p)));
  if (m) m.on('click', (e) => { carState.park = 'map'; document.querySelectorAll('#park button').forEach((b) => b.classList.toggle('on', b.dataset.p === 'map')); set({ lat: +e.latlng.lat.toFixed(6), lon: +e.latlng.lng.toFixed(6) }); });
  pick(carState.park === 'map' ? 'garage' : carState.park);
}

function idleSteps(open) {
  const steps = [
    ['Identify', 'Palm-vein scan matched in the car against the enrolled template. Only the result and score leave the reader.'],
    ['Locate', 'Galileo OSNMA fix, cross-checked with the mobile network and vehicle speed.'],
    ['Seal', "The car's secure chip signs driver, position and event together."],
    ['Anchor', 'The record goes to the EU record store; its SHA-256 hash goes on the ledger in a block signed by 2 of 3 validators.'],
    ['Verify', 'Anyone with access recomputes the hash. A match means no edits.'],
  ];
  return `<p class="small muted" style="margin:0 0 6px">${open ? 'Signing out' : 'Signing in'} runs these five steps:</p><div class="steps">${steps.map(([t, d], i) => `<div class="step wait"><span class="n">${i + 1}</span><div><b>${t}</b><p>${d}</p></div></div>`).join('')}</div>`;
}

function handSeedFor(sel, defaultRef) {
  if (sel === 'owner') return net.hands.get(defaultRef);
  if (sel === 'stranger') return STRANGER_HAND;
  return net.hands.get(sel);
}

function doScan(v, open) {
  const handSel = $('#hand').value;
  const palmEl = $('#palm .palm');
  $('#go').disabled = true;
  palmEl.classList.add('scanning');
  setTimeout(() => {
    let r;
    try {
      if (open) {
        r = net.signOut({ vehicleId: v.vehicleId, handSeed: handSeedFor(handSel, open.driverRef), point: carState.point || v.garage, spoof: carState.gnss === 'spoof', ts: Date.now() });
      } else {
        const ref = $('#acct').value;
        r = net.signIn({ vehicleId: v.vehicleId, driverRef: ref, handSeed: handSeedFor(handSel, ref), point: offsetM(v.garage, 5, 5), spoof: carState.gnss === 'spoof', ts: Date.now() });
      }
    } catch (e) {
      toast(esc(e.message), 'err');
      $('#go').disabled = false;
      palmEl.classList.remove('scanning');
      return;
    }
    save();
    carState.last = { ...r, vehicleId: v.vehicleId };
    if (r.ok) toast(`${r.record.kind === 'signin' ? 'Signed in' : 'Signed out'} · sealed in block <a href="#/block/${r.block.header.height}">#${r.block.header.height}</a>`, 'ok');
    else toast('Palm did not match. Refusal recorded on the ledger.', 'err');
    carState.park = 'garage';
    route();
    const p = $('#palm .palm');
    if (p) p.classList.add(r.ok ? 'done' : 'fail');
  }, 1300);
}

function resultHtml(r) {
  const rec = r.record;
  const palm = rec.palm;
  const loc = rec.location;
  const okPalm = palm.result === 'match';
  const locOk = loc.osnmaAuthenticated && loc.networkCheckM <= 500;
  const kind = { signin: 'Sign-in', signout: 'Sign-out', 'signin-denied': 'Refused sign-in', 'signout-denied': 'Refused sign-out' }[rec.kind];
  const parked = rec.parked ? `<p>${rec.parked.inApprovedGarage ? `Parked inside ${esc(rec.parked.garage)} (${rec.parked.distanceM} m from centre).` : `<b style="color:#a32c17">Parked ${(rec.parked.distanceM / 1000).toFixed(2)} km from ${esc(rec.parked.garage)}.</b> Flagged for the operator.`}</p>` : '';
  return `<div class="verdict ${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓' : '✕'} ${kind} · ${fmtTime(rec.ts)}</div>
  <div class="steps">
    <div class="step ${okPalm ? '' : 'bad'}"><span class="n">1</span><div><b>Identify</b><p>${okPalm ? 'Palm matched' : 'Palm did not match'} the template for <b>${esc(dname(rec.driverRef || rec.claimedDriverRef))}</b>: score ${palm.score.toFixed(3)} (threshold ${palm.threshold}). Template ref <span class="hash">${short(palm.templateRef, 12)}</span>. The live scan was discarded.</p></div></div>
    <div class="step ${locOk ? '' : 'bad'}"><span class="n">2</span><div><b>Locate</b><p>${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)} · ${esc(loc.source)} · network cross-check ${loc.networkCheckM} m ${locOk ? 'agrees' : '<b style="color:#a32c17">disagrees: likely spoofed</b>'}.</p>${parked}</div></div>
    <div class="step"><span class="n">3</span><div><b>Seal</b><p>Signed by ${esc(rec.unitId)}'s chip. Record hash <span class="hash">${short(r.hash, 14)}</span></p></div></div>
    <div class="step"><span class="n">4</span><div><b>Anchor</b><p>Transaction <a href="#/tx/${r.tx.id}">${short(r.tx.id, 8)}</a> in block <a href="#/block/${r.block.header.height}">#${r.block.header.height}</a>, signed by ${Object.keys(r.block.sigs).length} of 3 validators.</p></div></div>
    <div class="step"><span class="n">5</span><div><b>Verify</b><p><a href="#/verify?h=${r.hash}">Recompute the hash</a> against the ledger.</p></div></div>
  </div>`;
}

// ---------------- fleet map
function pageMap() {
  const list = fleetPositions();
  app.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">Location integrity</div><h1>Fleet map</h1><p class="lede">Where every cab is now: on shift at its sign-in point, or parked where it was signed out. Approved garages are shown with their geofence.</p></div></div>
    <div class="card"><div class="map" id="fleet-map" style="height:520px"></div>
      <div class="legend small"><span><i style="background:${COLORS.on}"></i>On shift</span><span><i style="background:${COLORS.parked}"></i>Parked in garage</span><span><i style="background:${COLORS.flag}"></i>Flagged</span></div></div>
    <div class="card section"><h2>Cars</h2><div class="table-wrap"><table><thead><tr><th>Car</th><th>Status</th><th>Driver</th><th>Position</th><th>Approved garage</th><th>Checks</th></tr></thead><tbody>
    ${list.map((p) => `<tr><td><a href="#/car?v=${p.v.vehicleId}">${esc(p.v.plate)}</a><div class="small muted">${esc(p.v.model)}</div></td>
      <td>${p.state === 'on' ? `<span class="pill green">On shift</span><div class="small muted">since ${fmtTime(p.ts)}</div>` : `<span class="pill grey">Parked</span><div class="small muted">${p.ts ? fmtDT(p.ts) : ''}</div>`}</td>
      <td>${p.driverRef ? `<a href="#/driver/${p.driverRef}">${esc(dname(p.driverRef))}</a>` : ''}</td>
      <td class="addr">${p.loc ? `${p.loc.lat.toFixed(5)}, ${p.loc.lon.toFixed(5)}` : '<span class="muted">record erased</span>'}</td>
      <td>${esc(p.v.garage.name)}</td>
      <td>${p.flags?.length ? p.flags.map((f) => `<span class="pill warn">${esc(flagLabel(f))}</span>`).join(' ') : '<span class="pill green">OK</span>'}</td></tr>`).join('')}
    </tbody></table></div></div></div>`;
  const m = makeMap($('#fleet-map'), { zoom: 11 });
  if (m) {
    garageLayer(m, Object.values(GARAGES));
    const pts = fleetMarkers(m, list);
    if (pts.length) m.fitBounds(pts, { padding: [40, 40], maxZoom: 13 });
  }
}

// ---------------- drivers
function pageDrivers() {
  const now = Date.now();
  const rows = drivers().map((d) => ({ d, s: driverSummary(net, d.ref, now) }));
  app.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">Operating integrity</div><h1>Drivers & hours</h1><p class="lede">Hours come from palm sign-ins and sign-outs on the ledger, so they are counted per person across every car. The limit is ${MAX_HOURS_24} hours in any 24, with a rest day each week.</p></div></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Driver</th><th>Status</th><th class="num">Last 24 h</th><th class="num">Worst 24 h (7 d)</th><th class="num">Last 7 d</th><th>Last 7 days</th><th>Rest day</th><th>Licence</th></tr></thead><tbody>
    ${rows.map(({ d, s }) => `<tr><td><a href="#/driver/${d.ref}">${esc(d.name)}</a><div class="small muted">${esc(d.employeeNo)} · tag ${esc(d.tagNo)}</div></td>
      <td>${s.onShift ? `<span class="pill green"><span class="d"></span>${esc(plate(s.onShift))}</span>` : '<span class="pill grey">Off</span>'}</td>
      <td class="num">${hrs(s.last24h)}</td>
      <td class="num">${s.worst24h > MAX_HOURS_24 ? `<span class="pill warn">${hrs(s.worst24h)}</span>` : hrs(s.worst24h)}</td>
      <td class="num">${hrs(s.last7d)}</td>
      <td><div class="days" title="Green = drove that day">${s.days.map((x) => `<i class="${x.worked ? 'w' : ''}" title="${x.day}"></i>`).join('')}</div></td>
      <td>${s.restDayOk ? '<span class="pill green">Yes</span>' : '<span class="pill warn">None</span>'}</td>
      <td>${s.licenceDays < 0 ? '<span class="pill warn">Expired</span>' : s.licenceDays <= 30 ? `<span class="pill warn">${s.licenceDays} d left</span>` : `<span class="small">${esc(d.licenceExpiry)}</span>`}</td></tr>`).join('')}
    </tbody></table></div></div></div>`;
}

function gantt(s, now) {
  const W = 720, rowH = 22, days = 8, left = 92;
  const start0 = Date.parse(maltaDayStartIso(now - (days - 1) * DAY));
  const rows = [];
  for (let i = 0; i < days; i++) rows.push(start0 + i * DAY);
  const x = (t) => left + ((t % DAY + DAY) % DAY) / DAY * (W - left - 8);
  let svg = `<svg class="gantt" viewBox="0 0 ${W} ${days * rowH + 26}" role="img" aria-label="Shifts over the last 8 days">`;
  for (let hh = 0; hh <= 24; hh += 6) svg += `<text x="${left + hh / 24 * (W - left - 8)}" y="12" font-size="10" fill="#6b6b6e" text-anchor="${hh === 24 ? 'end' : hh === 0 ? 'start' : 'middle'}">${String(hh).padStart(2, '0')}:00</text>`;
  rows.forEach((d0, i) => {
    const y = 20 + i * rowH;
    svg += `<text x="0" y="${y + 14}" font-size="11" fill="#404042">${fmtDate(d0 + H * 12)}</text><rect x="${left}" y="${y + 3}" width="${W - left - 8}" height="${rowH - 6}" fill="#f6f1ea"/>`;
    for (const sh of s.shifts) {
      const a = Math.max(sh.start, d0), b = Math.min(sh.end, d0 + DAY);
      if (b <= a) continue;
      const xa = left + (a - d0) / DAY * (W - left - 8), xb = left + (b - d0) / DAY * (W - left - 8);
      const bad = sh.flags.length || (sh.end - sh.start) > MAX_HOURS_24 * H;
      svg += `<rect x="${xa}" y="${y + 3}" width="${Math.max(2, xb - xa)}" height="${rowH - 6}" fill="${bad ? '#f0492c' : sh.open ? '#3fae74' : '#056032'}"><title>${esc(plate(sh.vehicleId))} ${fmtTime(sh.start)}–${sh.open ? 'now' : fmtTime(sh.end)}</title></rect>`;
    }
  });
  void x;
  return svg + '</svg>';
}
function maltaDayStartIso(ts) {
  // midnight Malta time for the day containing ts
  const ymd = maltaDay(ts);
  const guess = Date.parse(ymd + 'T00:00:00Z');
  const off = new Date(guess).toLocaleString('en-US', { timeZone: TZ, hour12: false, hour: '2-digit' });
  return new Date(guess - Number(off) % 24 * H).toISOString();
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function pageDriver(ref) {
  const d = net.driver(ref);
  if (!d) { app.innerHTML = '<div class="page"><p>Unknown driver.</p></div>'; return; }
  const now = Date.now();
  const s = driverSummary(net, ref, now);
  const log = workingLog(net, ref, now);
  const denied = net.ledger.denied.filter(({ tx }) => tx.body.claimedDriverRef === ref);
  app.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">Driver</div><h1>${esc(d.name)}</h1><p class="lede">${esc(d.employeeNo)} · licence ${esc(d.licenceNo)} (to ${esc(d.licenceExpiry)}) · driver tag ${esc(d.tagNo)} (to ${esc(d.tagExpiry)})</p></div>
      <div class="actions"><button class="btn ghost" id="csv">Working & rest log (CSV)</button><button class="btn ghost" id="json">Log with proofs (JSON)</button></div></div>
    <div class="grid g4">
      <div class="kpi green"><div class="label">Status</div><div class="value">${s.onShift ? esc(plate(s.onShift)) : 'Off'}</div><div class="sub">${s.onShift ? 'On shift now' : 'Not signed in'}</div></div>
      <div class="kpi ${s.worst24h > MAX_HOURS_24 ? '' : 'green'}"><div class="label">Worst 24 h (7 days)</div><div class="value">${hrs(s.worst24h)}</div><div class="sub">Limit ${MAX_HOURS_24} h</div></div>
      <div class="kpi green"><div class="label">Last 7 days</div><div class="value">${hrs(s.last7d)}</div><div class="sub">${s.shifts.length} shifts on record</div></div>
      <div class="kpi ${s.restDayOk ? 'green' : ''}"><div class="label">Weekly rest day</div><div class="value">${s.restDayOk ? 'Taken' : 'Missing'}</div><div class="sub">${s.days.filter((x) => !x.worked).length} rest days in last 7</div></div>
    </div>
    <div class="card section"><h2>Shifts, last 8 days <span class="aside">Malta time</span></h2>${gantt(s, now)}</div>
    <div class="grid g2 section">
      <div class="card"><h2>Palm-vein enrolment</h2><div class="kv">
        <div>Pseudonymous ref</div><div class="hash">${d.ref}</div>
        <div>Template commitment</div><div class="hash">${d.templateCommit}</div>
        <div>Template stored</div><div>In the secure store of ${net.units.size} cars. Never sent to the ledger or the record store.</div>
        <div>Enrolled</div><div>${fmtDT(d.enrolledAt)}</div></div></div>
      <div class="card"><h2>Refused attempts on this account</h2>${denied.length ? feed(denied.map(({ tx, height }) => ({ tx, height }))) : '<div class="empty">None</div>'}</div>
    </div>
    <div class="card section"><h2>Working log <span class="aside">Each row links to its ledger proof</span></h2><div class="table-wrap"><table><thead><tr><th>Car</th><th>Sign-in</th><th>Sign-out</th><th class="num">Hours</th><th>Parked</th><th>Proof</th></tr></thead><tbody>
    ${log.slice().reverse().map((r) => `<tr><td>${esc(r.vehicle)}</td><td>${fmtDT(Date.parse(r.signIn))}</td><td>${r.signOut ? fmtDT(Date.parse(r.signOut)) : '<span class="pill green">On shift</span>'}</td><td class="num">${r.hours.toFixed(2)}</td>
      <td>${r.inApprovedGarage === null ? '' : r.inApprovedGarage ? '<span class="pill green">Garage</span>' : '<span class="pill warn">Outside garage</span>'}${r.flags.includes('location-') ? ' <span class="pill warn">Unverified fix</span>' : ''}</td>
      <td class="small"><a href="#/verify?h=${r.signInRecordHash}">in #${r.signInBlock}</a>${r.signOutRecordHash ? ` · <a href="#/verify?h=${r.signOutRecordHash}">out #${r.signOutBlock}</a>` : ''}</td></tr>`).join('')}
    </tbody></table></div></div></div>`;
  const slug = d.name.toLowerCase().replace(/[^a-z]+/g, '-');
  $('#csv').onclick = () => {
    const cols = Object.keys(log[0] || { signIn: '' });
    const csv = [cols.join(','), ...log.map((r) => cols.map((c) => JSON.stringify(r[c] ?? '')).join(','))].join('\n');
    download(`working-log-${slug}.csv`, csv, 'text/csv');
  };
  $('#json').onclick = () => download(`working-log-${slug}.json`, JSON.stringify({ chain: net.genesis.chainId, head: net.ledger.head.hash, generated: new Date().toISOString(), driver: { name: d.name, employeeNo: d.employeeNo, ref: d.ref }, shifts: log }, null, 2), 'application/json');
}

// ---------------- alerts
function pageAlerts() {
  const al = alerts(net, Date.now());
  const groups = [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']];
  app.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">Transport Malta rules · since 29 July 2026</div><h1>Compliance alerts</h1><p class="lede">Raised automatically from the ledger: borrowed accounts, hours over ${MAX_HOURS_24} in 24, missing rest days, cars parked outside their approved garage, locations that could not be authenticated, and licences or tags running out.</p></div></div>
    <div class="grid g3">${groups.map(([k, l]) => `<div class="kpi ${k === 'high' ? '' : 'green'}"><div class="label">${l}</div><div class="value">${al.filter((a) => a.sev === k).length}</div></div>`).join('')}</div>
    <div class="card section">${alertList(al)}</div></div>`;
}

// ---------------- ledger
function pageLedger() {
  const blocks = net.ledger.blocks.slice(1).reverse().slice(0, 60);
  app.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">Permissioned ledger</div><h1>Ledger</h1><p class="lede">Chain <span class="addr">${esc(net.genesis.chainId)}</span>. Each block lists its transactions' Merkle root and the hash of the block before it, and needs signatures from 2 of 3 validators.</p></div>
      <div class="actions"><button class="btn ghost" id="audit">${icon('verify')}Audit the whole chain</button></div></div>
    <div class="grid g4">
      <div class="kpi green"><div class="label">Height</div><div class="value">${net.ledger.height}</div></div>
      <div class="kpi green"><div class="label">Transactions</div><div class="value">${net.ledger.txIndex.size}</div></div>
      <div class="kpi green"><div class="label">Records anchored</div><div class="value">${net.ledger.anchors.size}</div></div>
      <div class="kpi"><div class="label">Records erased (GDPR)</div><div class="value">${net.ledger.erased.size}</div></div>
    </div>
    <div class="grid section" style="grid-template-columns:minmax(0,2fr) minmax(0,1fr)" id="lg">
      <div class="card"><h2>Latest blocks</h2><div class="table-wrap"><table><thead><tr><th>Block</th><th>Time</th><th>Proposer</th><th>Contents</th><th>Signatures</th><th>Hash</th></tr></thead><tbody>
      ${blocks.map((b) => `<tr><td><a href="#/block/${b.header.height}">#${b.header.height}</a></td><td class="nowrap">${fmtDT(b.header.ts)}</td><td>${esc(net.ledger.validators.find((v) => v.id === b.header.proposer)?.name)}</td>
        <td>${b.txs.map(txPill).join(' ')}</td><td>${Object.keys(b.sigs).length}/3</td><td class="addr">${short(b.hash, 8)}</td></tr>`).join('')}
      </tbody></table></div></div>
      <div class="card"><h2>Validators</h2>${validatorsHtml()}<div class="kv" style="margin-top:16px"><div>Genesis</div><div>${fmtDT(net.genesis.ts)}</div><div>Fleet operator key</div><div class="hash">${short(net.genesis.operator.pub, 12)}</div><div>Head hash</div><div class="hash">${net.ledger.head.hash}</div></div></div>
    </div></div>`;
  if (window.matchMedia('(max-width: 1100px)').matches) $('#lg').style.gridTemplateColumns = 'minmax(0,1fr)';
  $('#audit').onclick = () => {
    const t0 = performance.now();
    try {
      const r = net.ledger.audit();
      toast(`Chain verified: ${r.height} blocks, every hash link, Merkle root and validator signature re-checked in ${Math.round(performance.now() - t0)} ms.`, 'ok');
    } catch (e) { toast('Audit failed: ' + esc(e.message), 'err'); }
  };
}

function pageBlock(h) {
  const b = net.ledger.blockAt(Number(h));
  if (!b) { app.innerHTML = '<div class="page"><p>No such block.</p></div>'; return; }
  const H_ = b.header;
  app.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">Block</div><h1>#${H_.height}</h1></div><div class="actions">${H_.height > 1 ? `<a class="btn ghost sm" href="#/block/${H_.height - 1}">← Previous</a>` : ''}${H_.height < net.ledger.height ? `<a class="btn ghost sm" href="#/block/${H_.height + 1}">Next →</a>` : ''}</div></div>
    <div class="grid g2" style="align-items:start">
      <div class="card"><h2>Header</h2><div class="kv">
        <div>Block hash</div><div class="hash">${b.hash}</div><div>Previous</div><div class="hash">${H_.height > 0 ? `<a href="#/block/${H_.height - 1}">${H_.prev}</a>` : H_.prev}</div>
        <div>Time</div><div>${fmtDT(H_.ts)}</div><div>Transactions root</div><div class="hash">${H_.txRoot}</div>
        <div>Proposer</div><div>${esc(net.ledger.validators.find((v) => v.id === H_.proposer)?.name || H_.proposer)}</div><div>Chain</div><div class="addr">${esc(H_.chain)}</div></div></div>
      <div class="card"><h2>Validator signatures</h2>${net.ledger.validators.map((v) => `<div class="validator"><span class="d" style="${b.sigs[v.id] ? '' : 'background:#c9c3ba'}"></span><div><b>${esc(v.name)}</b><div class="hash">${b.sigs[v.id] ? short(b.sigs[v.id], 16) : 'not signed (offline)'}</div></div><div>${b.sigs[v.id] ? '<span class="pill green">Valid</span>' : ''}</div></div>`).join('')}</div>
    </div>
    <div class="card section"><h2>Transactions</h2>${feed(b.txs.map((tx) => ({ tx, height: H_.height })))}</div></div>`;
}

function pageTx(id) {
  const t = net.ledger.getTx(id);
  if (!t) { app.innerHTML = '<div class="page"><p>No such transaction.</p></div>'; return; }
  const { tx, height } = t;
  const signer = tx.from === net.genesis.operator.pub ? 'Fleet operator (Fedrok Taxi Malta)' : `In-car unit of ${plate(net.ledger.unitToVehicle.get(tx.from))}`;
  const rh = tx.body.recordHash && tx.type !== 'record.erase' ? tx.body.recordHash : null;
  app.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">Transaction · ${TX_LABELS[tx.type]}</div><h1 style="font-size:20px">${txSummary(tx)}</h1></div>${rh ? `<a class="btn" href="#/verify?h=${rh}">${icon('verify')}Verify the record</a>` : ''}</div>
    <div class="grid g2" style="align-items:start">
      <div class="card"><h2>Details</h2><div class="kv">
        <div>Transaction id</div><div class="hash">${tx.id}</div><div>Block</div><div><a href="#/block/${height}">#${height}</a></div>
        <div>Time</div><div>${fmtDT(tx.ts)}</div><div>Signed by</div><div>${esc(signer)}<div class="hash">${tx.from}</div></div>
        <div>Signature</div><div class="hash">${short(tx.sig, 20)} <span class="pill green">Valid</span></div>
        ${tx.body.flags?.length ? `<div>Flags</div><div>${tx.body.flags.map((f) => `<span class="pill warn">${esc(flagLabel(f))}</span>`).join(' ')}</div>` : ''}</div></div>
      <div class="card"><h2>On-chain body <span class="aside">This is everything on the ledger</span></h2><pre class="code">${esc(JSON.stringify(tx.body, null, 2))}</pre>
        <p class="small muted" style="margin:12px 0 0">No names, no palm data and no coordinates: just pseudonymous references and the hash of the full record held in the EU record store.</p></div>
    </div></div>`;
}

// ---------------- verify
function pageVerify(params) {
  const hash = params.get('h') || recentTxs(1, (t) => t.type === 'shift.signout')[0]?.tx.body.recordHash;
  const recent = recentTxs(30, (t) => t.body.recordHash && t.type !== 'record.erase');
  const entry = hash ? net.store.get(hash) : null;
  const anchored = hash ? net.ledger.anchors.get(hash) : null;
  app.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">Verify</div><h1>Verify & audit a record</h1><p class="lede">Anyone with access recomputes the SHA-256 hash of the record in the EU store and compares it with the hash anchored on the ledger. A match means no edits since the car sealed it. Try changing a coordinate below.</p></div></div>
    <div class="card"><div class="row"><label>Record<select id="pick">${recent.map(({ tx, height }) => `<option value="${tx.body.recordHash}" ${tx.body.recordHash === hash ? 'selected' : ''}>#${height} · ${TX_LABELS[tx.type]} · ${esc(plate(tx.body.vehicleId))} · ${fmtDT(tx.ts)}</option>`).join('')}${hash && !recent.some(({ tx }) => tx.body.recordHash === hash) ? `<option value="${hash}" selected>${short(hash)}</option>` : ''}</select></label>
      <label>Or paste a record hash<input id="paste" placeholder="64 hex characters" value=""></label></div></div>
    ${!hash ? '' : !anchored ? '<div class="card section"><div class="verdict bad">✕ No ledger anchor for this hash</div></div>' : `
    <div class="grid g2 section" style="align-items:start">
      <div class="card"><h2>Record in the EU store <span class="aside">${entry?.erased ? 'Erased' : 'Editable for the demo'}</span></h2>
        ${entry?.erased ? `<div class="verdict grey">Erased on ${fmtDT(entry.erasedAt)}</div><p class="small muted">The personal record was deleted from the EU store at the data subject's request. The ledger still holds its hash and the erasure note, so the history stays intact without personal data.</p>`
        : `<textarea class="code" id="rec" spellcheck="false">${esc(JSON.stringify(entry.record, null, 2))}</textarea>
        <div class="actions" style="margin-top:12px"><button class="btn" id="check">${icon('verify')}Recompute hash</button><button class="btn ghost" id="reset">Restore original</button><button class="btn ghost" id="erase">Erase personal data (GDPR)</button></div>`}
      </div>
      <div class="card"><h2>Result</h2><div id="vres"></div></div>
    </div>`}</div>`;
  $('#pick').onchange = (e) => (location.hash = `#/verify?h=${e.target.value}`);
  $('#paste').onchange = (e) => { const v = e.target.value.trim().toLowerCase(); if (/^[0-9a-f]{64}$/.test(v)) location.hash = `#/verify?h=${v}`; else toast('A record hash is 64 hex characters', 'err'); };
  if (!hash || !anchored) return;
  const show = (rec) => {
    const r = net.verifyRecord(hash, rec);
    $('#vres').innerHTML = `<div class="verdict ${r.ok ? 'ok' : r.erased ? 'grey' : 'bad'}">${r.ok ? '✓' : r.erased ? '○' : '✕'} ${esc(r.reason)}</div>
      <div class="kv" style="margin-top:14px">
        <div>Hash on the ledger</div><div class="hash">${hash}</div>
        ${r.recomputed ? `<div>Recomputed now</div><div class="hash" style="color:${r.recomputed === hash ? 'var(--green)' : '#a32c17'}">${r.recomputed}</div>` : ''}
        ${r.recomputed ? `<div>Car chip seal</div><div>${r.sealOk && r.unitOk ? '<span class="pill green">Valid · signed by the fitted unit</span>' : '<span class="pill warn">Invalid</span>'}</div>` : ''}
        <div>Anchored in</div><div><a href="#/block/${r.height}">Block #${r.height}</a> · <a href="#/tx/${r.tx.id}">${short(r.tx.id, 8)}</a></div>
        <div>Block signatures</div><div>${Object.keys(net.ledger.blockAt(r.height).sigs).length} of 3 validators</div>
        ${net.ledger.erased.has(hash) ? '<div>Erasure</div><div>Recorded on the ledger</div>' : ''}</div>`;
  };
  if (entry?.erased) { show(undefined); return; }
  show(entry.record);
  $('#check').onclick = () => {
    let rec;
    try { rec = JSON.parse($('#rec').value); } catch { toast('That is not valid JSON', 'err'); return; }
    show(rec);
  };
  $('#reset').onclick = () => { $('#rec').value = JSON.stringify(entry.record, null, 2); show(entry.record); };
  let armed = false;
  $('#erase').onclick = (e) => {
    if (!armed) { armed = true; e.target.textContent = 'Click again to erase'; e.target.classList.add('accent'); return; }
    net.eraseRecord(hash, Date.now());
    save();
    toast('Personal record deleted from the EU store. Its hash stays on the ledger.', 'ok');
    route();
  };
  void hashObject;
}

// ---------------- how it works
function pageHow() {
  app.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">Palm vein + blockchain for taxi integrity · Malta</div><h1>How it works</h1><p class="lede">Transport Malta now expects operators to prove who drove, for how long, and where each cab waited and parked. This pilot records three things for every shift: the palm-vein sign-in, the palm-vein sign-out, and where the car is parked at sign-out.</p></div></div>
    <div class="grid g2">
      <div class="card"><h2>Five steps</h2><div class="steps">
        ${[['Identify', 'Palm-vein scan at shift start and end, matched in the car.'], ['Locate', 'Galileo OSNMA satellite fix, cross-checked with network and speed.'], ['Seal', 'A secure chip signs driver, position and shift events together.'], ['Anchor', 'Record kept in an EU database; its hash goes on a permissioned ledger.'], ['Verify', 'Anyone with access recomputes the hash; a match means no edits.']]
          .map(([t, d], i) => `<div class="step"><span class="n">${i + 1}</span><div><b>${t}</b><p>${d}</p></div></div>`).join('')}</div></div>
      <div class="card"><h2>The rules since 29 July 2026</h2><div class="steps">
        ${[['One driver, one account', 'No lending a profile. A palm that does not match the account is refused and the attempt is recorded.'], ['12 hours in any 24', 'Plus a weekly rest day, counted per person across all cars and apps from ledger sign-ins and sign-outs.'], ['Records on demand', 'Working and rest logs export per driver, each line linked to its ledger proof.'], ['Garaging and parking', 'The sign-out position is checked against the approved garage geofence (€100 to €500 per breach).']]
          .map(([t, d]) => `<div class="step"><span class="n">✓</span><div><b>${t}</b><p>${d}</p></div></div>`).join('')}</div></div>
    </div>
    <div class="card section"><h2>Where each piece of data lives</h2><div class="grid g3">
      <div class="layer"><h3>In the car</h3><ul><li>Palm-vein templates (secure element)</li><li>The live scan, discarded right after matching</li><li>The chip's signing key</li></ul></div>
      <div class="layer"><h3>EU record store</h3><ul><li>Driver names, licence and tag numbers</li><li>Match result and score, never the image</li><li>Satellite fix and parked position</li><li>Deletable on request (GDPR)</li></ul></div>
      <div class="layer"><h3>Permissioned ledger</h3><ul><li>Record hashes and pseudonymous driver refs</li><li>Sign-in and sign-out times, flags</li><li>Palm template commitments (salted hashes)</li><li>Signed by Fedrok, Transport Malta and an auditor</li></ul></div>
    </div></div>
    <div class="grid g2 section">
      <div class="card"><h2>Privacy by design</h2><div class="steps">
        <div class="step"><span class="n">1</span><div><b>Palm data stays in the car</b><p>Only the match result is sent. A different hand produces a low score; the sample itself is never stored.</p></div></div>
        <div class="step"><span class="n">2</span><div><b>Only hashes on the ledger</b><p>Personal data stays in the EU store and can be deleted. The hash keeps the history provable.</p></div></div>
        <div class="step"><span class="n">3</span><div><b>DPIA and a GDPR Article 9 basis</b><p>Required before launch, with driver consultation.</p></div></div></div></div>
      <div class="card"><h2>Suggested pilot</h2><p>10 to 20 cars for 12 weeks. DPIA and driver consultation, fit readers and in-car units, enrol drivers, brief Transport Malta, review at weeks 6 and 12.</p>
        <div class="note plain small" style="margin-top:14px">This demo runs the whole network in your browser: three validator nodes, the EU store and eight in-car units, with simulated palm scans and satellite fixes. Your actions are kept in this browser only. <button class="btn ghost sm" id="reset" style="margin-left:6px">Reset demo data</button></div></div>
    </div></div>`;
  $('#reset').onclick = () => {
    try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
    app.innerHTML = '<div class="page"><p class="muted">Rebuilding the pilot network…</p></div>';
    setTimeout(() => { net = buildDemo(); save(); toast('Demo reset to a fresh seven-day history', 'ok'); location.hash = '#/'; route(); }, 30);
  };
}

// ---------------------------------------------------------------- router
function route() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query);
  const [top, arg] = path.split('/');
  const active = { driver: 'drivers', block: 'ledger', tx: 'ledger' }[top] ?? top;
  renderNav(active || '');
  document.body.classList.remove('nav-open');
  const pages = { '': pageOverview, car: () => pageCar(params), map: pageMap, drivers: pageDrivers, driver: () => pageDriver(arg), alerts: pageAlerts, ledger: pageLedger, block: () => pageBlock(arg), tx: () => pageTx(arg), verify: () => pageVerify(params), how: pageHow };
  (pages[top] || pageOverview)();
  window.scrollTo(0, 0);
}

function boot() {
  let raw = null;
  try { raw = localStorage.getItem(STORE_KEY); } catch { /* ignore */ }
  if (raw) {
    try { net = FleetNetwork.import(JSON.parse(raw)); } catch (e) { console.warn('stored network failed validation, rebuilding', e); net = null; }
  }
  if (!net || Date.now() - net.ledger.head.header.ts > 3 * DAY) { net = buildDemo(); save(); }
  window.fedrokTaxi = net;
  $('#menu').onclick = () => document.body.classList.toggle('nav-open');
  window.addEventListener('hashchange', route);
  route();
  setInterval(() => { if (!document.hidden) renderNav(document.querySelector('.nav a.active')?.getAttribute('href')?.slice(2).split('?')[0] ?? ''); }, 30000);
}

setTimeout(boot, 20);
