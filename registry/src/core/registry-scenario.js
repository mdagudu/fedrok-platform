// Project registry demo data, shared by `npm run demo` and the in-browser node:
//   project owners get FDK for network fees -> they register or propose
//   environmental projects -> some add their full details and lock & submit
//   (permanently read-only) -> one proposal is retired -> others stay drafts.
//
// Projects and organisations below are fictional sample data.
import { addressFromPrivate } from './crypto.js';
import { fdk } from './units.js';
import { projectContentHash } from '../evm/actions.js';

const PROJECTS = [
  {
    owner: 'png', kind: 'registered', projectType: 'Reforestation & afforestation', lock: true,
    name: 'Kikori Basin Rainforest Restoration',
    summary: 'Community-led restoration of 1,200 hectares of degraded lowland rainforest in the Kikori river basin, using native seedlings from village nurseries.',
    location: 'Kikori District, Gulf Province', country: 'Papua New Guinea',
    details: {
      objectives: 'Restore 1,200 ha of degraded lowland forest, reconnect two forest fragments for wildlife and create nursery jobs in six villages.',
      activities: 'Village nurseries raise 40 native species; assisted natural regeneration on 700 ha and enrichment planting on 500 ha; fire breaks maintained by ranger teams.',
      startDate: '2024-03', duration: '30 years', area: '1,200 hectares', coordinates: '-7.4190, 144.2500',
      beneficiaries: 'Six clan groups (about 2,400 people) who own the land under customary tenure; 60 nursery and ranger jobs, half held by women.',
      expectedImpact: 'About 310,000 tCO₂e removed over 30 years; habitat for the Pesquet\'s parrot and tree kangaroos restored.',
      metrics: ['Hectares under restoration', 'Seedling survival rate at 12 and 36 months', 'Canopy cover from satellite imagery', 'Jobs created'],
      monitoringPlan: 'Annual field plots (120 permanent plots) plus quarterly satellite canopy analysis; results published on this record every year.',
      methodology: 'VM0047 Afforestation, Reforestation and Revegetation',
      landTenure: 'Customary land; free, prior and informed consent signed by all six clans in 2023, registered with the provincial lands office.',
      partners: ['Kikori Clans Land Trust (landowners)', 'Gulf Province Forestry Office', 'Highlands Seed Bank'],
      budget: 'USD 4.2 million over the first 10 years, funded by a climate fund grant and forward sales of removal units.',
      risks: 'Fire in El Niño years (fire breaks, ranger patrols); permanence (20% buffer area left unclaimed); land disputes (grievance committee).',
      sdgs: ['SDG 13 Climate action', 'SDG 15 Life on land', 'SDG 8 Decent work'],
      website: 'https://example.org/kikori',
    },
  },
  {
    owner: 'kenya', kind: 'registered', projectType: 'Clean cookstoves', lock: true,
    name: 'Lake Victoria Clean Cookstoves',
    summary: 'Distribution of 12,000 efficient biomass cookstoves to households around Kisumu, cutting firewood use and indoor smoke.',
    location: 'Kisumu and Siaya counties', country: 'Kenya',
    details: {
      objectives: 'Halve household firewood use and indoor air pollution for 12,000 families.',
      activities: 'Local assembly of improved stoves, door-to-door sales with micro-payments, training and two follow-up visits per household.',
      startDate: '2025-01', duration: '7 years', area: '12,000 households',
      beneficiaries: 'About 60,000 people, mostly women and children who spend hours collecting firewood; 45 local assembly and sales jobs.',
      expectedImpact: 'Roughly 25,000 tCO₂e avoided per year and less pressure on nearby woodland.',
      metrics: ['Stoves in use (annual survey)', 'Firewood use per household (kitchen tests)', 'Indoor PM2.5 in sample homes'],
      monitoringPlan: 'Annual usage survey of a 10% sample; kitchen performance tests every two years by an independent assessor.',
      methodology: 'Gold Standard TPDDTEC',
      partners: ['Kisumu Women Stove Makers Cooperative', 'County Department of Energy'],
      budget: 'USD 1.1 million; stoves sold at a subsidised price, the rest from impact finance.',
      risks: 'Stoves abandoned (follow-up visits, repair service); price changes (micro-payments).',
      sdgs: ['SDG 7 Affordable and clean energy', 'SDG 3 Good health', 'SDG 5 Gender equality'],
    },
  },
  {
    owner: 'peru', kind: 'proposed', projectType: 'Peatland & wetland restoration', lock: false,
    name: 'Andean Bofedales Wetland Revival',
    summary: 'Proposal to re-wet and protect high-Andean peat wetlands (bofedales) that store carbon and supply water to alpaca-herding communities.',
    location: 'Ayacucho highlands', country: 'Peru',
    details: {
      objectives: 'Re-wet 350 ha of drained bofedales and agree rotational grazing with herders.',
      activities: 'Small stone check-dams, closing drainage ditches, rotational grazing plans, community water committees.',
      area: '350 hectares',
      beneficiaries: 'Four alpaca-herding communities downstream.',
    },
  },
  {
    owner: 'zurich', kind: 'registered', projectType: 'Solar energy', lock: false,
    name: 'Zurich Rooftop Solar Cooperative',
    summary: 'A citizens\' cooperative installing solar panels on school and community rooftops in Zurich.',
    location: 'Zurich', country: 'Switzerland',
    details: {},
  },
  {
    owner: 'png', kind: 'proposed', projectType: 'Mangrove & coastal restoration', retire: 'Merged into the Kikori Basin Rainforest Restoration project (PRJ-000001), which now covers the estuary.',
    name: 'Kikori Delta Mangrove Belt',
    summary: 'Proposal to replant mangroves along 15 km of eroding coastline in the Kikori delta.',
    location: 'Kikori delta', country: 'Papua New Guinea',
    details: { area: '15 km of coastline', objectives: 'Protect villages from storm surges and restore fish nurseries.' },
  },
  {
    owner: 'kenya', kind: 'registered', projectType: 'Waste reduction & recycling', lock: true,
    name: 'Kisumu Plastic Recovery Hub',
    summary: 'A collection and sorting hub that pays waste pickers fair prices for plastics and sells sorted material to recyclers.',
    location: 'Kisumu', country: 'Kenya',
    details: {
      objectives: 'Recover 1,500 tonnes of plastic a year from streets and the lake shore.',
      activities: 'Buy-back centre, sorting and baling line, shoreline clean-ups, school education days.',
      startDate: '2025-06', duration: 'Ongoing', area: '1,500 tonnes per year',
      beneficiaries: 'About 300 registered waste pickers paid at posted prices; lake-shore fishing communities.',
      expectedImpact: '1,500 t of plastic a year kept out of Lake Victoria.',
      metrics: ['Tonnes collected per material', 'Payments to waste pickers', 'Shoreline litter counts'],
      monitoringPlan: 'Every bale weighed and logged; quarterly shoreline litter surveys.',
      partners: ['Kisumu Waste Pickers Association', 'County Environment Office'],
      budget: 'USD 380,000 set-up; running costs covered by material sales.',
      risks: 'Plastic price swings (minimum price fund).',
      sdgs: ['SDG 12 Responsible consumption', 'SDG 14 Life below water'],
    },
  },
];

/**
 * @param c   FedrokClient
 * @param K   keys: faucet, png, kenya, peru, zurich
 * @param log line logger
 */
export async function runRegistryScenario(c, K, log = console.log) {
  const addr = (k) => addressFromPrivate(k);
  const step = (m) => log(`\n▸ ${m}`);
  const ok = (m) => log(`  ✓ ${m}`);
  const all = async (thunks) => {
    const sent = [];
    for (const t of thunks) sent.push(await t());
    return Promise.all(sent.map((s) => c.wait(s.hash)));
  };
  const st = await c.status();
  log(`Connected to ${st.node} (${st.network}, EVM chain id ${st.chainId}) at height ${st.height}, ${st.consensus.validators.length} authority validators`);

  step('Funding project owners with FDK for network fees (devnet faucet)');
  const owners = ['png', 'kenya', 'peru', 'zurich'];
  await all(owners.map((o) => () => c.send(K.faucet, 'transfer', { to: addr(K[o]), asset: 'FDK', amount: fdk('25').toString() })));
  ok(`${owners.length} project owners funded`);

  step('Registering and proposing environmental projects');
  const created = [];
  for (const p of PROJECTS) {
    const r = await c.sendAndWait(K[p.owner], 'project_create', { kind: p.kind, projectType: p.projectType, name: p.name, summary: p.summary, location: p.location, country: p.country });
    const id = r.events.find((e) => e.event === 'ProjectCreated').projectId;
    created.push({ ...p, id });
    ok(`${id} ${p.kind === 'proposed' ? 'proposed' : 'registered'}: ${p.name}`);
  }

  step('Owners add project details');
  for (const p of created) {
    if (!Object.keys(p.details).length) continue;
    await c.sendAndWait(K[p.owner], 'project_update', { projectId: p.id, name: p.name, summary: p.summary, location: p.location, country: p.country, details: p.details });
    ok(`${p.id} details recorded (${Object.keys(p.details).length} fields)`);
  }

  step('Lock & submit: finished projects become permanently read-only');
  for (const p of created.filter((x) => x.lock)) {
    await c.sendAndWait(K[p.owner], 'project_lock', { projectId: p.id, contentHash: projectContentHash(p) });
    ok(`${p.id} locked and submitted`);
  }

  step('Retiring a proposal that was merged into another project');
  for (const p of created.filter((x) => x.retire)) {
    await c.sendAndWait(K[p.owner], 'project_retire', { projectId: p.id, reason: p.retire });
    ok(`${p.id} retired`);
  }
  log('\nProject registry demo ready.');
  return created;
}
