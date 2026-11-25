// Demo scenario: a 12-driver, 8-car pilot fleet with the last seven days of
// shifts, including the cases the rules are designed to catch.
import { FleetNetwork } from './network.js';
import { GARAGES, PLACES, offsetM } from './geo.js';
import { rng } from './crypto.js';
import { TZ, DAY, H } from './compliance.js';

export const DRIVERS = [
  { employeeNo: 'FT-1001', name: 'Joseph Camilleri', licenceNo: 'TL-40211', licenceExpiry: '2028-03-31', tagNo: 'DT-7781', tagExpiry: '2027-06-30' },
  { employeeNo: 'FT-1002', name: 'Maria Borg', licenceNo: 'TL-40377', licenceExpiry: '2027-11-30', tagNo: 'DT-7790', tagExpiry: '2027-09-30' },
  { employeeNo: 'FT-1003', name: 'Karl Vella', licenceNo: 'TL-40412', licenceExpiry: '2028-01-31', tagNo: 'DT-7802', tagExpiry: '2027-05-31' },
  { employeeNo: 'FT-1004', name: 'Daniela Farrugia', licenceNo: 'TL-40519', licenceExpiry: '2027-08-31', tagNo: 'DT-7815', tagExpiry: '2027-08-31' },
  { employeeNo: 'FT-1005', name: 'Mark Zammit', licenceNo: 'TL-40620', licenceExpiry: '2028-06-30', tagNo: 'DT-7821', tagExpiry: '2027-12-31' },
  { employeeNo: 'FT-1006', name: 'Rita Galea', licenceNo: 'TL-40733', licenceExpiry: '2027-10-31', tagNo: 'DT-7836', tagExpiry: '2026-12-15' },
  { employeeNo: 'FT-1007', name: 'Clayton Grech', licenceNo: 'TL-40845', licenceExpiry: '2028-02-29', tagNo: 'DT-7840', tagExpiry: '2027-07-31' },
  { employeeNo: 'FT-1008', name: 'Elena Micallef', licenceNo: 'TL-40958', licenceExpiry: '2026-12-07', tagNo: 'DT-7853', tagExpiry: '2027-04-30' },
  { employeeNo: 'FT-1009', name: 'Ryan Attard', licenceNo: 'TL-41066', licenceExpiry: '2028-09-30', tagNo: 'DT-7867', tagExpiry: '2027-10-31' },
  { employeeNo: 'FT-1010', name: 'Nadia Spiteri', licenceNo: 'TL-41172', licenceExpiry: '2027-12-31', tagNo: 'DT-7874', tagExpiry: '2027-03-31' },
  { employeeNo: 'FT-1011', name: 'Jean Pisani', licenceNo: 'TL-41289', licenceExpiry: '2028-04-30', tagNo: 'DT-7888', tagExpiry: '2027-11-30' },
  { employeeNo: 'FT-1012', name: 'Luke Cassar', licenceNo: 'TL-41390', licenceExpiry: '2028-05-31', tagNo: 'DT-7895', tagExpiry: '2027-02-28' },
].map((d) => ({ ...d, handSeed: `hand:${d.employeeNo}` }));

export const VEHICLES = [
  { vehicleId: 'V01', plate: 'FDK 101', model: 'Toyota Corolla Touring Hybrid', garage: GARAGES.qormi },
  { vehicleId: 'V02', plate: 'FDK 102', model: 'Toyota Corolla Touring Hybrid', garage: GARAGES.qormi },
  { vehicleId: 'V03', plate: 'FDK 103', model: 'Kia Niro EV', garage: GARAGES.marsa },
  { vehicleId: 'V04', plate: 'FDK 104', model: 'Kia Niro EV', garage: GARAGES.birkirkara },
  { vehicleId: 'V05', plate: 'FDK 105', model: 'Hyundai Ioniq 5', garage: GARAGES.mosta },
  { vehicleId: 'V06', plate: 'FDK 106', model: 'Skoda Octavia Estate', garage: GARAGES.zabbar },
  { vehicleId: 'V07', plate: 'FDK 107', model: 'Skoda Octavia Estate', garage: GARAGES.spb },
  { vehicleId: 'V08', plate: 'FDK 108', model: 'Mercedes-Benz Vito', garage: GARAGES.marsa },
];

/** Someone who is not an enrolled driver (used for the borrowed-account attempt). */
export const STRANGER_HAND = 'hand:not-enrolled-person';

function offsetOf(ts) {
  const part = new Intl.DateTimeFormat('en', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(ts)).find((p) => p.type === 'timeZoneName').value;
  const m = part.match(/([+-])(\d{2}):?(\d{2})?/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) * 60000 : 0;
}

/** Local-time timestamp in Malta for a day offset from today's date and an hour (fractional). */
export function maltaTime(now, dayOffset, hour) {
  const d = new Date(now + dayOffset * DAY);
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const utcMidnight = Date.parse(ymd + 'T00:00:00Z');
  const guess = utcMidnight + hour * H;
  return guess - offsetOf(guess);
}

export function buildDemo(now = Date.now()) {
  const net = new FleetNetwork({ genesisTs: now - 9 * DAY });
  const r = rng(424242);
  let t = now - 9 * DAY + 60000;
  const refs = DRIVERS.map((d) => net.enrolDriver(d, (t += 60000)));
  for (const v of VEHICLES) net.registerVehicle(v, (t += 60000));

  const near = (p, m = 25) => offsetM(p, (r() - 0.5) * m, (r() - 0.5) * m);
  // Rota: V01-V04 have a day and an evening driver; V05-V08 a day driver.
  const rota = [
    { v: 'V01', d: 0, kind: 'day', off: [-5] }, { v: 'V01', d: 1, kind: 'eve', off: [-3] },
    { v: 'V02', d: 6, kind: 'day', off: [-2] }, { v: 'V02', d: 2, kind: 'eve', off: [] }, // Karl Vella: no rest day
    { v: 'V03', d: 3, kind: 'day', off: [-4, -1] }, { v: 'V03', d: 7, kind: 'eve', off: [-6] },
    { v: 'V04', d: 8, kind: 'day', off: [-3] }, { v: 'V04', d: 9, kind: 'eve', off: [-5, 0] },
    { v: 'V05', d: 4, kind: 'day', off: [-6] }, { v: 'V06', d: 5, kind: 'day', off: [-4] },
    { v: 'V07', d: 10, kind: 'day', off: [-2, 0] }, { v: 'V08', d: 11, kind: 'day', off: [-1] },
  ];
  const events = [];
  for (const slot of rota) {
    const veh = VEHICLES.find((x) => x.vehicleId === slot.v);
    for (let day = -7; day <= 0; day++) {
      if (slot.off.includes(day)) continue;
      let start = slot.kind === 'day' ? 6 + r() * 0.75 : 15.5 + r() * 0.75;
      let len = slot.kind === 'day' ? 7.5 + r() * 1 : 6.5 + r() * 1;
      if (slot.d === 4 && day === -3) { start = 5.4; len = 13.6; } // Mark Zammit: over 12 h
      const s = maltaTime(now, day, start);
      const e = maltaTime(now, day, start + len);
      const sig = { type: 'in', ts: s, vehicleId: slot.v, ref: refs[slot.d], point: near(veh.garage) };
      const out = { type: 'out', ts: e, vehicleId: slot.v, ref: refs[slot.d], point: near(veh.garage) };
      if (slot.v === 'V05' && day === -2) out.point = near(PLACES.stjulians, 30); // parked on the street
      if (slot.v === 'V06' && day === -1) { out.point = near(veh.garage, 10); out.spoof = true; } // GPS-spoofing app
      if (slot.v === 'V03' && day === -4 && slot.kind === 'eve') {
        events.push({ type: 'in', ts: s - 9 * 60000, vehicleId: slot.v, ref: refs[slot.d], hand: STRANGER_HAND, point: near(veh.garage) });
      }
      events.push(sig);
      if (e < now - 5 * 60000) events.push(out);
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  for (const ev of events) {
    if (ev.ts >= now) continue;
    if (ev.type === 'in') net.signIn({ vehicleId: ev.vehicleId, driverRef: ev.ref, handSeed: ev.hand, point: ev.point, ts: ev.ts });
    else net.signOut({ vehicleId: ev.vehicleId, point: ev.point, spoof: ev.spoof, ts: ev.ts });
  }
  return net;
}
