// Personal Legacy Garden demo: the Bibiani pilot on the devnet.
//
//   governance approves the Garden -> operator accredits a field steward ->
//   paid subscriptions fill planting batch 1 (50 trees) -> it is released and
//   planted in compartment A -> monitoring at months 1, 3 and 6 -> two trees
//   die and are replaced free under the 24-month guarantee -> batch 2 does not
//   fill before the window closes and carries over, then fills and is planted
//   in compartment B -> batch 3 starts filling -> a self-service dedication is
//   paid in the settlement stablecoin. 120 subscriptions in total, so the pilot
//   is past its target of 100.
//
// Names below are fictional sample data.
import { addressFromPrivate, generatePrivateKey, sha256Hex, canonical } from './crypto.js';
import { fdk } from './units.js';

export const GARDEN_ID = 'BITG';
const CENTRE = { lat: 6.4635, lon: -2.3194 }; // Bibiani, Western North Region, Ghana

export const SPECIES = [
  ['Odum', 'Milicia excelsa'], ['African mahogany', 'Khaya ivorensis'], ['Wawa', 'Triplochiton scleroxylon'],
  ['Emire', 'Terminalia ivorensis'], ['Ofram', 'Terminalia superba'], ['African walnut', 'Lovoa trichilioides'],
  ['Afromosia', 'Pericopsis elata'], ['Kusia', 'Nauclea diderrichii'], ['Dahoma', 'Piptadeniastrum africanum'],
  ['Edinam', 'Entandrophragma angolense'], ['Sapele', 'Entandrophragma cylindricum'], ['Bakankor', 'Tieghemella heckelii'],
  ['Prekese', 'Tetrapleura tetraptera'], ['Dawadawa', 'Parkia biglobosa'],
];
const SEED = ['CSIR-FORIG nursery, Kumasi', 'National Tree Seed Centre', 'Verified mother tree, Bibiani forest reserve'];

// Position k (1-90) in compartment index ci: 10 columns x 9 rows at 6 m spacing,
// compartments 70 m apart west to east.
export function positionGps(ci, k, jitterM = 0) {
  const row = Math.floor((k - 1) / 10), col = (k - 1) % 10;
  const east = ci * 70 + col * 6 + 3 + jitterM - 160;
  const north = row * 6 + 3 + jitterM - 27;
  const lat = CENTRE.lat + north / 111_320;
  const lon = CENTRE.lon + east / (111_320 * Math.cos((CENTRE.lat * Math.PI) / 180));
  return { lat: lat.toFixed(6), lon: lon.toFixed(6) };
}

const photo = (...parts) => sha256Hex(canonical(parts));
const rnd = (i, salt) => {
  const h = sha256Hex(`${salt}:${i}`);
  return parseInt(h.slice(2, 10), 16) / 0xffffffff;
};
const addDays = (d, n) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

const FIRST = ['Ama', 'Kwame', 'Akosua', 'Yaw', 'Efua', 'Kofi', 'Abena', 'Kwabena', 'Adwoa', 'Kojo', 'Esi', 'Kwesi', 'Margaret', 'David', 'Helen', 'Peter', 'Ruth', 'Samuel', 'Joyce', 'George'];
const LAST = ['Asante', 'Boateng', 'Owusu-Ansah', 'Appiah', 'Darko', 'Agyeman', 'Frimpong', 'Opoku', 'Wright', 'Bennett', 'Osei', 'Amoah', 'Taylor', 'Quaye', 'Addo'];
const DESC = ['Loving Mother', 'Devoted Father', 'Teacher', 'Nurse', 'Engineer', 'Farmer', 'Grandmother', 'Musician', 'Carpenter', 'Pastor', 'Footballer', 'Seamstress', 'Headmaster', 'Trader', 'Poet'];
const PURPOSE = ['memorial', 'memorial', 'family', 'memorial', 'friendship', 'self', 'memorial', 'family'];
const PKG = { memorial: 'memorial', family: 'family', friendship: 'standard', self: 'standard', pet: 'memorial', institutional: 'corporate' };

/**
 * @param c   FedrokClient
 * @param K   keys: gov, faucet, gardenOp, steward, mensah, owusu, clarke, diaspora, buyer
 * @param log line logger
 */
export async function runGardenScenario(c, K, log = console.log) {
  const addr = (k) => addressFromPrivate(k);
  const step = (m) => log(`\n▸ ${m}`);
  const ok = (m) => log(`  ✓ ${m}`);
  const all = async (thunks) => {
    const sent = [];
    for (const t of thunks) sent.push(await t());
    return Promise.all(sent.map((s) => c.wait(s.hash, 120_000)));
  };
  const existing = await c.get('/api/gardens');
  if (existing.find((g) => g.id === GARDEN_ID)) {
    log('Legacy Garden already set up.');
    return;
  }

  step('Legacy Garden: funding the Garden operator and steward with FDK for network fees');
  await all([K.gardenOp, K.steward].map((k) => () => c.send(K.faucet, 'transfer', { to: addr(k), asset: 'FDK', amount: fdk('25').toString() })));
  ok('Operator and steward funded. Subscribers never need FDK.');

  step('Governance approves the Bibiani Pilot Indigenous Tree Garden');
  const window1 = 'Major rainy season 2026 (Apr–Jul)';
  await c.sendAndWait(K.gov, 'garden_register', {
    code: GARDEN_ID, name: 'Bibiani Pilot Indigenous Tree Garden', location: 'Bibiani, Western North Region', country: 'Ghana',
    operator: addr(K.gardenOp), operatorName: 'Personal Legacy Garden', capacity: 450, batchSize: 50, compartments: ['A', 'B', 'C', 'D', 'E'],
    centre: { lat: CENTRE.lat.toFixed(6), lon: CENTRE.lon.toFixed(6) }, priceGBP: '90000', maintenanceGBP: '2500', stablePrice: '1150000000',
    replacementMonths: 24, lifespanYears: 50, agreementHash: photo('subscribership-agreement', 'v1'), window: window1,
  });
  await c.sendAndWait(K.gardenOp, 'garden_steward', { gardenId: GARDEN_ID, steward: addr(K.steward), name: 'Field supervisor, Bibiani' });
  ok('BITG registered: 5 compartments, 450 trees, batches of 50. Field supervisor accredited as steward.');

  // ---- subscriptions
  const named = [
    { holder: addr(K.mensah), purpose: 'memorial', dedicatedTo: 'Grace Mensah', descriptor: 'Loving Mother', inscription: 'Her garden grows on. 1948–2025', species: 0 },
    { holder: addr(K.mensah), purpose: 'family', dedicatedTo: 'Kofi Mensah', descriptor: 'Teacher and Footballer', inscription: 'For the grandchildren', species: 1 },
    { holder: addr(K.mensah), purpose: 'family', package: 'legacy', dedicatedTo: 'The Mensah Family', descriptor: 'Rooted in Bibiani', inscription: 'Three generations, one tree', species: 6 },
    { holder: addr(K.owusu), purpose: 'memorial', dedicatedTo: 'Dr Yaw Owusu', descriptor: 'Physician', inscription: 'He healed, now he shelters', species: 3 },
    { holder: addr(K.clarke), purpose: 'pet', dedicatedTo: 'Biscuit', descriptor: 'Faithful Friend', inscription: 'Good dog, 2011–2025', species: 12 },
    { holder: addr(K.clarke), purpose: 'memorial', private: 'Private dedication held by the Clarke family', species: 9 },
    ...Array.from({ length: 5 }, (_, i) => ({ holder: addr(K.diaspora), purpose: 'institutional', package: 'corporate', dedicatedTo: `Ghana Heritage Circle UK`, descriptor: `Founding grove, tree ${i + 1} of 5`, species: (i * 3) % 14 })),
  ];
  const anon = (i) => {
    const purpose = PURPOSE[i % PURPOSE.length];
    const isPrivate = rnd(i, 'private') < 0.14;
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
    return { holder: addr(generatePrivateKey()), purpose, ...(isPrivate ? { private: `${name} (private)` } : { dedicatedTo: name, descriptor: DESC[(i * 5) % DESC.length] }), species: i % 14 };
  };
  let refN = 0;
  const dedTx = (d, paidOn) => () => c.send(K.gardenOp, 'dedication_create', {
    gardenId: GARDEN_ID, holder: d.holder, package: d.package || PKG[d.purpose], purpose: d.purpose,
    ...(d.private ? { publicName: false, nameHash: photo('name', d.private) } : { publicName: true, dedicatedTo: d.dedicatedTo, descriptor: d.descriptor, inscription: d.inscription || '' }),
    preferredSpecies: SPECIES[d.species][0], detailsHash: photo('customer-record', ++refN), agreementHash: photo('signed-agreement', refN),
    payment: { ref: `PLG-2026-${String(refN).padStart(4, '0')}`, method: refN % 4 === 0 ? 'bank transfer' : 'card', currency: 'GBP', amount: '90000', paidOn },
  });
  const batch1 = [...named, ...Array.from({ length: 50 - named.length }, (_, i) => anon(i))];

  step('Paid subscriptions (GBP by card or bank transfer) fill planting batch 1');
  const r1 = await all(batch1.map((d, i) => dedTx(d, addDays('2026-02-02', Math.floor(i * 1.6)))));
  const released = r1.flatMap((r) => r.events).find((e) => e.event === 'BatchReleased');
  ok(`50 dedications recorded with payment references; ${released.batchId} released for planting`);

  // ---- planting batch 1 in compartment A
  step('Stewards plant batch 1 in compartment A with GPS and a photo fingerprint');
  const ded1 = (await c.get(`/api/garden-batch/${released.batchId}`)).dedications;
  const plantDate = (i) => addDays('2026-05-11', Math.floor(i / 4));
  const plantings = await all(ded1.map((d, i) => () => {
    const [sp, sci] = SPECIES[batch1[i].species];
    const treeId = `${GARDEN_ID}-2026-A-${String(i + 1).padStart(3, '0')}`;
    return c.send(K.steward, 'tree_plant', { dedicationId: d.id, treeId, species: sp, scientific: sci, gps: positionGps(0, i + 1), plantedOn: plantDate(i), seedSource: SEED[i % 3], photoHash: photo(treeId, 'planting', 1) });
  }));
  ok(`${plantings.length} trees planted, ${released.batchId} complete`);

  // ---- monitoring
  step('Monitoring at months 1, 3 and 6 (height, stem, crown, health)');
  const trees = ded1.map((d, i) => ({ id: `${GARDEN_ID}-2026-A-${String(i + 1).padStart(3, '0')}`, planted: plantDate(i), i }));
  const OWUSU = trees[3].id; // dies of termite damage at month 3
  const DROUGHT = trees[27].id; // dies in a dry spell at month 1
  const mon = (t, days, h, stem, extra = {}) => () => c.send(K.steward, 'tree_monitor', {
    treeId: t.id, date: addDays(t.planted, days), heightCm: h, stemMm: stem, crown: 'good', health: 'healthy', photoHash: photo(t.id, 'monitor', days), ...extra,
  });
  const m1 = trees.map((t) => (t.id === DROUGHT
    ? mon(t, 30, 31, 4, { health: 'dead', cause: 'Drought stress during a dry spell; watering basin failed' })
    : mon(t, 30, 45 + Math.round(rnd(t.i, 'h1') * 25), 6 + Math.round(rnd(t.i, 's1') * 3), rnd(t.i, 'c1') < 0.12 ? { crown: 'fair', health: 'stressed', note: 'Leaf scorch, extra watering scheduled' } : {})));
  await all(m1);
  await c.sendAndWait(K.steward, 'tree_replace', { treeId: DROUGHT, plantedOn: '2026-07-02', gps: positionGps(0, 28, 0.4), seedSource: 'Nursery replacement stock', photoHash: photo(DROUGHT, 'planting', 2) });
  const m3 = trees.map((t) => (t.id === OWUSU
    ? mon(t, 91, 58, 8, { health: 'dead', cause: 'Termite damage at the root collar' })
    : t.id === DROUGHT ? null : mon(t, 91, 70 + Math.round(rnd(t.i, 'h3') * 40), 9 + Math.round(rnd(t.i, 's3') * 5)))).filter(Boolean);
  await all(m3);
  await c.sendAndWait(K.steward, 'tree_replace', { treeId: OWUSU, plantedOn: '2026-09-21', gps: positionGps(0, 4, 0.4), seedSource: 'Nursery replacement stock (hardened 3 weeks)', photoHash: photo(OWUSU, 'planting', 2) });
  const m6 = trees.filter((t) => addDays(t.planted, 183) <= new Date().toISOString().slice(0, 10) && t.id !== OWUSU && t.id !== DROUGHT).map((t) => mon(t, 183, 100 + Math.round(rnd(t.i, 'h6') * 55), 14 + Math.round(rnd(t.i, 's6') * 7)));
  await all(m6);
  const after = [[DROUGHT, '2026-08-02', 44, 6, 'Replacement established'], [DROUGHT, '2026-09-30', 63, 8, ''], [OWUSU, '2026-10-21', 48, 6, 'Replacement established, termite barrier applied'], [OWUSU, '2026-11-18', 61, 7, '']];
  await all(after.filter(([, d]) => d <= new Date().toISOString().slice(0, 10)).map(([id, date, h, st, note], k) => () => c.send(K.steward, 'tree_monitor', { treeId: id, date, heightCm: h, stemMm: st, crown: 'good', health: 'healthy', photoHash: photo(id, 'monitor', 'r', k), note })));
  ok(`${m1.length + m3.length + m6.length + after.length} inspections recorded; 2 trees died and were replaced free under the 24-month guarantee`);

  // ---- batch 2: carries over, then fills in the next window and is planted
  step('Batch 2 does not reach 50 before the planting window closes: payments carry over');
  const batch2 = Array.from({ length: 50 }, (_, i) => anon(100 + i));
  await all(batch2.slice(0, 12).map((d, i) => dedTx(d, addDays('2026-05-20', i * 5))));
  const closed = await c.sendAndWait(K.gardenOp, 'planting_window_close', { gardenId: GARDEN_ID, nextWindow: 'Minor rainy season 2026 (Sep–Nov)' });
  const ev = closed.events[0];
  ok(`${ev.from} closed with ${ev.carriedOver} of 50 paid; carried over to ${ev.to} for the next window`);
  const r2 = await all(batch2.slice(12).map((d, i) => dedTx(d, addDays('2026-07-06', i))));
  const released2 = r2.flatMap((r) => r.events).find((e) => e.event === 'BatchReleased');
  ok(`38 more subscriptions fill ${released2.batchId}: released for planting`);

  step('Stewards plant batch 2 in compartment B');
  const ded2 = (await c.get(`/api/garden-batch/${released2.batchId}`)).dedications;
  const plantDate2 = (i) => addDays('2026-09-21', Math.floor(i / 4));
  const trees2 = ded2.map((d, i) => ({ id: `${GARDEN_ID}-2026-B-${String(i + 1).padStart(3, '0')}`, planted: plantDate2(i), i: 100 + i, d }));
  await all(trees2.map((t, i) => () => {
    const [sp, sci] = SPECIES[(i * 5 + 2) % SPECIES.length];
    return c.send(K.steward, 'tree_plant', { dedicationId: t.d.id, treeId: t.id, species: sp, scientific: sci, gps: positionGps(1, i + 1), plantedOn: t.planted, seedSource: SEED[(i + 1) % 3], photoHash: photo(t.id, 'planting', 1) });
  }));
  const today = new Date().toISOString().slice(0, 10);
  const b2m1 = trees2.filter((t) => addDays(t.planted, 30) <= today).map((t) => mon(t, 30, 42 + Math.round(rnd(t.i, 'h1') * 25), 6 + Math.round(rnd(t.i, 's1') * 3)));
  await all(b2m1);
  ok(`${trees2.length} trees planted in compartment B; ${b2m1.length} month-1 inspections recorded`);

  await c.sendAndWait(K.gardenOp, 'planting_window_close', { gardenId: GARDEN_ID, nextWindow: 'Major rainy season 2027 (Apr–Jul)' });
  ok('Minor rainy season planting complete; next window: major rainy season 2027');

  step('New subscriptions start planting batch 3');
  const batch3 = Array.from({ length: 19 }, (_, i) => anon(200 + i));
  await all(batch3.map((d, i) => dedTx(d, addDays('2026-10-01', i * 2))));
  ok(`${batch3.length} paid subscriptions waiting for the next planting window`);

  step('Self-service dedication paid in the settlement stablecoin');
  const st = await c.status();
  const self = await c.sendAndWait(K.buyer, 'dedication_create', { gardenId: GARDEN_ID, package: 'standard', purpose: 'friendship', publicName: true, dedicatedTo: 'Zurich carbon desk', descriptor: 'Colleagues and friends', inscription: 'Planted together', preferredSpecies: 'Sapele' });
  ok(`${self.events[0].dedicationId} paid on-chain in ${st.stable.symbol}`);

  step('Annual maintenance');
  const mensah = await c.get(`/api/dedications?holder=${addr(K.mensah)}`);
  const legacy = mensah.find((d) => d.package === 'legacy');
  await c.sendAndWait(K.gardenOp, 'maintenance_renew', { dedicationId: legacy.id, year: 2027, paymentRef: 'PLG-MNT-2027-0001' });
  ok(`${legacy.id} (Legacy package) prepaid maintenance for 2027`);

  const g = await c.get(`/api/garden/${GARDEN_ID}`);
  log(`\nLegacy Garden ready: ${g.stats.subscriptions} subscriptions, ${g.stats.planted} trees planted, ${g.stats.awaiting} waiting for the next batch.`);
}
