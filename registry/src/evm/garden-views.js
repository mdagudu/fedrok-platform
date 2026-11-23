// Read-side helpers for the Legacy Garden (the rules themselves are enforced
// by contracts/LegacyGarden.sol).
export const PACKAGES = {
  standard: 'Standard tree',
  family: 'Family tree',
  memorial: 'Memorial tree',
  legacy: 'Legacy tree',
  corporate: 'Corporate grove tree',
};

export function gardenView(s) {
  return s.garden;
}

export function isSteward(g, a) {
  return a === g.operator || Boolean(g.stewards[a]?.active);
}

export function maintenanceStatus(d, now = Date.now()) {
  const year = new Date(now).getUTCFullYear();
  const firstYear = d.payment.paidOn ? Number(d.payment.paidOn.slice(0, 4)) : new Date(d.subscribedAt).getUTCFullYear();
  const paid = d.renewals.map((r) => r.year);
  if (year === firstYear || paid.includes(year)) return { active: true, label: year === firstYear && !paid.includes(year) ? `Included for ${year}` : `Paid for ${year}`, year };
  return { active: false, label: `Due for ${year}`, year };
}

export function gardenStats(s, gardenId) {
  const G = gardenView(s);
  const ded = Object.values(G.dedications).filter((d) => d.gardenId === gardenId);
  const trees = Object.values(G.trees).filter((t) => t.gardenId === gardenId);
  const alive = trees.filter((t) => t.status === 'alive').length;
  const everPlanted = trees.reduce((n, t) => n + t.plantings.length, 0);
  const died = trees.reduce((n, t) => n + t.plantings.filter((p) => p.diedOn).length, 0);
  const replaced = trees.reduce((n, t) => n + t.plantings.length - 1, 0);
  const species = {};
  for (const t of trees) species[t.species] = (species[t.species] || 0) + 1;
  const withGps = trees.filter((t) => t.plantings.every((p) => p.gps)).length;
  return {
    subscriptions: ded.length,
    planted: trees.length,
    alive,
    dead: trees.length - alive,
    plantingsTotal: everPlanted,
    died,
    replaced,
    survivalPct: everPlanted ? Math.round(((everPlanted - died) / everPlanted) * 1000) / 10 : null,
    gpsPct: trees.length ? Math.round((withGps / trees.length) * 100) : null,
    speciesCount: Object.keys(species).length,
    species,
    awaiting: ded.filter((d) => !d.treeId).length,
  };
}
