// Compliance checks against the Transport Malta rules in force since 29 July 2026:
// one driver one account, max 12 driving hours in any 24, a weekly rest day,
// in-date driver tag and licence, and overnight parking in the approved garage.
// Hours are computed from the ledger's sign-in and sign-out events, so they are
// counted per person, whichever car (or app) the person drove for.
export const H = 3600_000;
export const DAY = 24 * H;
export const MAX_HOURS_24 = 12;
export const TZ = 'Europe/Malta';

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
export const maltaDay = (ts) => dayFmt.format(new Date(ts));

const overlap = (s, e, a, b) => Math.max(0, Math.min(e, b) - Math.max(s, a));

export function shiftsOf(net, ref, now) {
  const l = net.ledger;
  const out = l.shifts.filter((s) => s.driverRef === ref).map((s) => ({ ...s, open: false }));
  const v = l.driverOpen.get(ref);
  if (v) { const s = l.openShifts.get(v); out.push({ ...s, end: Math.max(now, s.start), open: true }); }
  return out.sort((a, b) => a.start - b.start);
}

/** Worst rolling-24-hour total. The maximum is reached at a shift end or 24h after a shift start. */
export function worst24(shifts, from = -Infinity, now = Date.now()) {
  let best = { ms: 0, end: null };
  const ends = new Set([now]);
  for (const s of shifts) { ends.add(s.end); ends.add(s.start + DAY); }
  for (const t of ends) {
    if (t < from || t > now) continue;
    const ms = shifts.reduce((acc, s) => acc + overlap(s.start, s.end, t - DAY, t), 0);
    if (ms > best.ms) best = { ms, end: t };
  }
  return best;
}

export function driverSummary(net, ref, now = net.now()) {
  const d = net.driver(ref);
  const shifts = shiftsOf(net, ref, now);
  const last24 = shifts.reduce((a, s) => a + overlap(s.start, s.end, now - DAY, now), 0);
  const last7 = shifts.reduce((a, s) => a + overlap(s.start, s.end, now - 7 * DAY, now), 0);
  const w = worst24(shifts, now - 7 * DAY, now);
  const worked = new Set();
  for (const s of shifts) for (let t = s.start; t < s.end; t += H / 2) worked.add(maltaDay(t));
  const days = [];
  for (let i = 7; i >= 1; i--) days.push(maltaDay(now - i * DAY)); // the last 7 complete days
  const restDays = days.filter((k) => !worked.has(k));
  const exp = (iso) => (iso ? Math.floor((Date.parse(iso + 'T23:59:59Z') - now) / DAY) : null);
  return {
    ref, driver: d, shifts,
    onShift: net.ledger.driverOpen.get(ref) || null,
    last24h: last24 / H, last7d: last7 / H,
    worst24h: w.ms / H, worst24hEnd: w.end,
    days: days.map((k) => ({ day: k, worked: worked.has(k) })),
    restDayOk: restDays.length > 0,
    licenceDays: exp(d?.licenceExpiry), tagDays: exp(d?.tagExpiry),
  };
}

export function alerts(net, now = net.now()) {
  const out = [];
  const name = (ref) => net.driver(ref)?.name || 'Unknown account';
  const plate = (id) => net.vehicle(id)?.plate || id;
  for (const ref of net.ledger.drivers.keys()) {
    const s = driverSummary(net, ref, now);
    if (s.worst24h > MAX_HOURS_24) out.push({ sev: 'high', kind: 'hours', title: `${name(ref)} drove ${s.worst24h.toFixed(1)} h in 24 h`, detail: `Limit is ${MAX_HOURS_24} h in any 24 h, counted across all cars and apps.`, driverRef: ref, ts: s.worst24hEnd });
    if (!s.restDayOk) out.push({ sev: 'high', kind: 'rest', title: `${name(ref)} has had no rest day in 7 days`, detail: 'A weekly rest day is required.', driverRef: ref, ts: now });
    if (s.licenceDays !== null && s.licenceDays < 0) out.push({ sev: 'high', kind: 'licence', title: `${name(ref)}: licence expired`, detail: `Expired ${s.driver.licenceExpiry}. Sign-in is blocked.`, driverRef: ref, ts: now });
    else if (s.licenceDays !== null && s.licenceDays <= 30) out.push({ sev: 'low', kind: 'licence', title: `${name(ref)}: licence expires in ${s.licenceDays} days`, detail: `Expiry ${s.driver.licenceExpiry}.`, driverRef: ref, ts: now });
    if (s.tagDays !== null && s.tagDays <= 30) out.push({ sev: s.tagDays < 0 ? 'high' : 'low', kind: 'tag', title: `${name(ref)}: driver tag ${s.tagDays < 0 ? 'expired' : `expires in ${s.tagDays} days`}`, detail: `Tag expiry ${s.driver.tagExpiry}.`, driverRef: ref, ts: now });
  }
  for (const sh of net.ledger.shifts) {
    if (sh.flags.includes('parked-outside-garage')) {
      const tx = net.ledger.getTx(sh.signoutTx).tx;
      const rec = net.store.get(tx.body.recordHash)?.record;
      out.push({ sev: 'medium', kind: 'garage', title: `${plate(sh.vehicleId)} parked outside its approved garage`, detail: rec ? `${(rec.parked.distanceM / 1000).toFixed(1)} km from ${rec.parked.garage}. Fine range €100 to €500.` : 'Record erased; flag kept on ledger.', vehicleId: sh.vehicleId, driverRef: sh.driverRef, ts: sh.end, txId: sh.signoutTx, recordHash: tx.body.recordHash });
    }
    if (sh.flags.some((f) => f.startsWith('location-'))) {
      out.push({ sev: 'high', kind: 'spoof', title: `${plate(sh.vehicleId)}: location could not be authenticated`, detail: 'No Galileo OSNMA authentication and the mobile network places the car elsewhere. Likely a GPS-spoofing app.', vehicleId: sh.vehicleId, driverRef: sh.driverRef, ts: sh.end, txId: sh.signoutTx });
    }
  }
  for (const s of net.ledger.openShifts.values()) {
    if (now - s.start > MAX_HOURS_24 * H) out.push({ sev: 'high', kind: 'hours', title: `${name(s.driverRef)} has been signed in for ${((now - s.start) / H).toFixed(1)} h`, detail: `${plate(s.vehicleId)} is still on shift.`, driverRef: s.driverRef, vehicleId: s.vehicleId, ts: now });
  }
  for (const { tx } of net.ledger.denied) {
    const why = tx.body.flags[0]?.replace('denied:', '') || '';
    const title = why.includes('palm-mismatch')
      ? `Palm did not match ${name(tx.body.claimedDriverRef)}'s account in ${plate(tx.body.vehicleId)}`
      : `Sign-in refused in ${plate(tx.body.vehicleId)}`;
    const detail = why.includes('palm-mismatch') ? 'Someone tried to drive on an account that is not theirs. The car stayed locked to that account.' : why.replace(/^rule:/, '');
    out.push({ sev: 'high', kind: 'denied', title, detail, vehicleId: tx.body.vehicleId, driverRef: tx.body.claimedDriverRef, ts: tx.ts, txId: tx.id, recordHash: tx.body.recordHash });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.sev] - rank[b.sev] || (b.ts || 0) - (a.ts || 0));
}

/** Working and rest log for one driver, ready to hand to Transport Malta on demand. */
export function workingLog(net, ref, now = net.now()) {
  const s = driverSummary(net, ref, now);
  return s.shifts.map((sh) => {
    const inTx = net.ledger.getTx(sh.signinTx);
    const outTx = sh.signoutTx ? net.ledger.getTx(sh.signoutTx) : null;
    const outRec = outTx ? net.store.get(outTx.tx.body.recordHash)?.record : null;
    return {
      driver: s.driver?.name, employeeNo: s.driver?.employeeNo, vehicle: net.vehicle(sh.vehicleId)?.plate,
      signIn: new Date(sh.start).toISOString(), signOut: sh.open ? null : new Date(sh.end).toISOString(),
      hours: Math.round(((sh.end - sh.start) / H) * 100) / 100,
      parkedAt: outRec ? `${outRec.location.lat},${outRec.location.lon}` : null,
      inApprovedGarage: outRec ? outRec.parked.inApprovedGarage : null,
      flags: sh.flags.join(' '),
      signInRecordHash: inTx.tx.body.recordHash, signInBlock: inTx.height,
      signOutRecordHash: outTx?.tx.body.recordHash ?? null, signOutBlock: outTx?.height ?? null,
    };
  });
}
