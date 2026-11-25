// Geography helpers and Malta reference places for the pilot.
export const MALTA_CENTRE = [35.905, 14.44];

export function distanceM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** Offset a point by metres north/east (good enough at Malta's scale). */
export function offsetM(p, north, east) {
  const lat = p.lat + north / 111320;
  const lon = p.lon + east / (111320 * Math.cos((p.lat * Math.PI) / 180));
  return { lat: round6(lat), lon: round6(lon) };
}

export const round6 = (x) => Math.round(x * 1e6) / 1e6;

/** Approved garages (operator-registered, with geofence radius). */
export const GARAGES = {
  qormi: { name: 'Qormi depot', lat: 35.8771, lon: 14.4727, radiusM: 80 },
  marsa: { name: 'Marsa garage', lat: 35.8794, lon: 14.4946, radiusM: 70 },
  mosta: { name: 'Mosta garage', lat: 35.9101, lon: 14.4262, radiusM: 60 },
  birkirkara: { name: 'Birkirkara garage', lat: 35.8968, lon: 14.4618, radiusM: 60 },
  zabbar: { name: 'Żabbar garage', lat: 35.8765, lon: 14.5378, radiusM: 60 },
  spb: { name: "St Paul's Bay garage", lat: 35.9479, lon: 14.4018, radiusM: 60 },
};

/** Places where cabs pick up, wait or (wrongly) park. */
export const PLACES = {
  valletta: { name: 'Valletta, City Gate', lat: 35.8963, lon: 14.5091 },
  sliema: { name: 'Sliema Ferries', lat: 35.9110, lon: 14.5040 },
  gzira: { name: 'Gżira seafront', lat: 35.9056, lon: 14.4890 },
  stjulians: { name: "St Julian's, Spinola", lat: 35.9186, lon: 14.4893 },
  airport: { name: 'Malta International Airport', lat: 35.8574, lon: 14.4870 },
  mater: { name: 'Mater Dei Hospital', lat: 35.9019, lon: 14.4772 },
  mdina: { name: 'Mdina, Main Gate', lat: 35.8858, lon: 14.4031 },
  mellieha: { name: 'Mellieħa Bay', lat: 35.9676, lon: 14.3632 },
  bugibba: { name: 'Buġibba Square', lat: 35.9516, lon: 14.4164 },
  cirkewwa: { name: 'Ċirkewwa ferry', lat: 35.9874, lon: 14.3290 },
};
