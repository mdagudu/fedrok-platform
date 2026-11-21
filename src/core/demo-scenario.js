// End-to-end demo scenario shared by `npm run demo` and the in-browser node:
//   accredit green Bitcoin miners -> generators stake and link -> Proof of
//   Green takes over block production -> auditors tokenise carbon credits ->
//   developers list them for stablecoin -> a buyer pays in fUSD and retires.
import { addressFromPrivate, signRecoverable, btcLinkMessage } from './crypto.js';
import { fdk, stable, tonnesToKg, formatFdk, formatStable } from './units.js';

/**
 * @param c         FedrokClient
 * @param K         keys: gov, auditor, issuer, faucet, g1..g3, buyer, devPng, devKenya, devPeru, ownAurora, ownAndes, ownHighlands
 * @param simMiners simulated Bitcoin miners (with keys) from the simulator
 * @param log       line logger
 */
export async function runDemoScenario(c, K, simMiners, log = console.log) {
  const addr = (k) => addressFromPrivate(k);
  const step = (m) => log(`\n▸ ${m}`);
  const ok = (m) => log(`  ✓ ${m}`);
  // Submit sequentially (so nonces are assigned in order), then wait for all.
  const all = async (thunks) => {
    const sent = [];
    for (const t of thunks) sent.push(await t());
    return Promise.all(sent.map((s) => c.wait(s.hash)));
  };
  const st = await c.status();
  log(`Connected to ${st.node} (${st.network}, EVM chain id ${st.chainId}) at height ${st.height}, mode: ${st.schedule.mode}`);

  step('Funding participant wallets with FDK for network fees (devnet faucet)');
  const fund = [K.devPng, K.devKenya, K.devPeru, K.ownAurora, K.ownAndes, K.ownHighlands].filter(Boolean);
  await all(fund.map((k) => () => c.send(K.faucet, 'transfer', { to: addr(k), asset: 'FDK', amount: fdk('25').toString() })));
  ok(`${fund.length} wallets funded with 25 FDK each`);

  step('Stablecoin issuer mints fUSD against reserve attestation');
  await c.sendAndWait(K.issuer, 'stable_mint', { to: addr(K.buyer), amount: stable('250000').toString(), reserveRef: 'Reserve attestation 2026-11 #0042 (devnet)' });
  ok('250,000 fUSD minted to the demo buyer');

  step('Auditor accredits green Bitcoin miners (Bitcoin ownership proven by signature)');
  const owners = [K.ownAurora, K.ownAndes, K.ownHighlands];
  const minerIds = [];
  const accredit = [];
  const status = await c.status();
  for (const [i, m] of simMiners.filter((x) => x.units > 0).entries()) {
    const existing = (await c.get('/api/miners')).find((x) => x.btcAddress === m.address && x.active);
    if (existing) { minerIds.push(existing.id); continue; }
    const owner = addr(owners[i]);
    const btcSig = signRecoverable(btcLinkMessage(m.address, owner, status.chainId, status.contracts.ProofOfGreen), m.privKey);
    accredit.push(() => c.send(K.auditor, 'miner_accredit', {
      name: m.name, btcAddress: m.address, btcPubKey: m.pubKey, btcSig, owner, units: m.units, auditDays: 365,
      site: m.site, energy: m.energy, reportRef: `ISO 14064-3 verification report FDK-AUD-2026-${String(i + 1).padStart(3, '0')}`,
      publicGenerators: i !== 0, generatorShareBps: 1500,
    }));
  }
  const accredited = await all(accredit);
  for (const r of accredited) {
    const ev = r.events[0];
    minerIds.push(ev.minerId);
    ok(`${ev.minerId} accredited, ${ev.units} S9-equivalent units, Piggy Bank pre-filled with ${formatFdk(ev.piggyBankPrefill)} FDK`);
  }
  const miners = await c.get('/api/miners');
  const byName = (s) => miners.find((m) => m.name.startsWith(s) && m.active);
  const aurora = byName('Aurora'), andes = byName('Andes'), highlands = byName('Highlands');

  step('Block generators stake FDK and link to green miners');
  if (!aurora.approved.includes(addr(K.g1))) {
    await all([
      () => c.send(K.ownAurora, 'generator_approve', { minerId: aurora.id, generator: addr(K.g1) }),
      () => c.send(K.ownAurora, 'generator_approve', { minerId: aurora.id, generator: addr(K.g2) }),
    ]);
    ok('Aurora (private) approved generators 1 and 2');
  }
  const gens = await c.get('/api/generators');
  const reg = [];
  for (const [k, name] of [[K.g1, 'Zurich generator'], [K.g2, 'Geneva generator'], [K.g3, 'Zug generator']]) {
    if (!gens.find((g) => g.address === addr(k))) reg.push(() => c.send(k, 'generator_register', { stake: fdk('1000').toString(), name }));
  }
  await all(reg);
  ok('3 generators registered with 1,000 FDK stake each');
  const links = [[K.g1, aurora], [K.g2, aurora], [K.g2, andes], [K.g3, andes], [K.g3, highlands], [K.g1, highlands]];
  const linkTx = [];
  for (const [k, m] of links) if (!m.generators.includes(addr(k))) linkTx.push(() => c.send(k, 'generator_link', { minerId: m.id }));
  await all(linkTx);
  ok('generators linked: Aurora ← G1,G2 · Andes ← G2,G3 · Highlands ← G3,G1');

  step('Auditor tokenises verified carbon credits');
  const projects = [
    { dev: K.devPng, project: 'Kikori Rainforest Restoration', country: 'Papua New Guinea', registry: 'Verra VCS', methodology: 'VM0047 Afforestation, Reforestation and Revegetation', projectType: 'Reforestation', vintage: 2024, serial: 'DEMO-VCS-4821-2024-0001-12000', tonnes: '12000', price: '24.50', description: 'Community-led reforestation of degraded lowland forest with local landowner revenue sharing.' },
    { dev: K.devKenya, project: 'Rift Valley Clean Cookstoves', country: 'Kenya', registry: 'Gold Standard', methodology: 'GS TPDDTEC v3.1', projectType: 'Clean cooking', vintage: 2025, serial: 'DEMO-GS-11934-2025-0001-8000', tonnes: '8000', price: '17.80', description: 'Efficient cookstoves for 6,000 households, cutting fuelwood use and indoor air pollution.' },
    { dev: K.devPeru, project: 'Tumbes Mangrove Blue Carbon', country: 'Peru', registry: 'Verra VCS', methodology: 'VM0033 Tidal Wetland and Seagrass Restoration', projectType: 'Blue carbon', vintage: 2024, serial: 'DEMO-VCS-5530-2024-0001-5000', tonnes: '5000', price: '31.00', description: 'Restoration and protection of coastal mangroves with fisher co-operatives.' },
  ];
  const batches = await c.get('/api/batches');
  const issue = [];
  for (const p of projects) {
    if (batches.find((b) => b.serial === p.serial)) continue;
    issue.push(() => c.send(K.auditor, 'credit_issue', { to: addr(p.dev), project: p.project, country: p.country, registry: p.registry, methodology: p.methodology, projectType: p.projectType, vintage: p.vintage, serial: p.serial, quantityKg: tonnesToKg(p.tonnes).toString(), description: p.description }));
  }
  for (const r of await all(issue)) ok(`${r.events[0].batchId} issued: ${Number(r.events[0].quantityKg) / 1000} t`);

  step('Project developers list credits on the marketplace, priced in fUSD');
  const fresh = await c.get('/api/batches');
  const listings = await c.get('/api/listings');
  const list = [];
  for (const p of projects) {
    const b = fresh.find((x) => x.serial === p.serial);
    if (listings.find((l) => l.batchId === b.id)) continue;
    list.push(() => c.send(p.dev, 'market_list', { batchId: b.id, quantityKg: tonnesToKg(String(Number(p.tonnes) * 0.6)).toString(), pricePerTonne: stable(p.price).toString() }));
  }
  for (const r of await all(list)) ok(`${r.events[0].listingId}: ${Number(r.events[0].quantityKg) / 1000} t at ${formatStable(r.events[0].pricePerTonne)} fUSD/t`);

  step('Buyer pays in fUSD stablecoin and retires credits');
  const open = await c.get('/api/listings');
  const buys = [];
  for (const l of open.slice(0, 2)) buys.push(() => c.send(K.buyer, 'market_buy', { listingId: l.id, quantityKg: tonnesToKg('500').toString(), maxPricePerTonne: l.pricePerTonne }));
  for (const r of await all(buys)) ok(`bought ${Number(r.events[0].quantityKg) / 1000} t of ${r.events[0].batchId}, paid ${formatStable(r.events[0].paid)} ${r.events[0].currency}`);
  const acct = await c.account(addr(K.buyer));
  const holding = acct.credits[0];
  if (holding) {
    const r = await c.sendAndWait(K.buyer, 'credit_retire', { batchId: holding.batchId, quantityKg: tonnesToKg('250').toString(), beneficiary: 'Fedrok AG', reason: '2026 operational emissions (Scope 1 and 2)' });
    ok(`${r.events[0].retirementId}: 250 t retired on behalf of Fedrok AG`);
  }

  step('Auditor back-mints FDK utility tokens against locked credits');
  const audAcct = await c.account(addr(K.auditor));
  if (!audAcct.history.find((h) => h.tx?.type === 'fdk_back_mint')) {
    const r = await c.sendAndWait(K.auditor, 'credit_issue', { project: 'Fedrok Backing Reserve – Swiss Forest Carbon', country: 'Switzerland', registry: 'Gold Standard', methodology: 'GS A/R Requirements v2', projectType: 'Forest management', vintage: 2025, serial: 'DEMO-GS-RESERVE-2025-0001-2000', quantityKg: tonnesToKg('2000').toString() });
    const m = await c.sendAndWait(K.auditor, 'fdk_back_mint', { batchId: r.events[0].batchId, quantityKg: tonnesToKg('2000').toString() });
    ok(`locked 2,000 t of ${r.events[0].batchId} in the backing vault, minted ${formatFdk(m.events[0].amount)} FDK`);
  }

  const end = await c.status();
  log(`\nDone. Height ${end.height}, consensus mode: ${end.schedule.mode}${end.schedule.miner ? ' (active miner ' + end.schedule.miner + ')' : ''}.`);
}
