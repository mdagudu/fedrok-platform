// Simulated Bitcoin miners used by devnets (green ones have units > 0).
export const MINER_PROFILES = [
  { name: 'Aurora Geothermal Mining (Iceland)', share: 18, energy: 'Geothermal', site: 'Reykjanes, Iceland', units: 120 },
  { name: 'Andes Hydro Pool (Paraguay)', share: 16, energy: 'Hydro', site: 'Itaipú region, Paraguay', units: 90 },
  { name: 'Highlands Flare-Gas Capture (Canada)', share: 10, energy: 'Captured flare gas', site: 'Alberta, Canada', units: 60 },
  { name: 'Generic Pool Alpha', share: 30, energy: 'Mixed grid', site: 'Undisclosed', units: 0 },
  { name: 'Generic Pool Beta', share: 26, energy: 'Coal-heavy grid', site: 'Undisclosed', units: 0 },
];
