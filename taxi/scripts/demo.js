#!/usr/bin/env node
// Builds the demo fleet and prints a summary: blocks, shifts, alerts, a verified record.
import { buildDemo } from '../src/core/scenario.js';
import { alerts, driverSummary } from '../src/core/compliance.js';

const t0 = Date.now();
const net = buildDemo();
console.log(`built ${net.ledger.height} blocks, ${net.ledger.shifts.length} closed shifts, ${net.ledger.openShifts.size} open, in ${Date.now() - t0} ms`);
for (const ref of net.ledger.drivers.keys()) {
  const s = driverSummary(net, ref);
  console.log(`${s.driver.name.padEnd(18)} 24h ${s.last24h.toFixed(1).padStart(5)}  7d ${s.last7d.toFixed(1).padStart(5)}  worst24 ${s.worst24h.toFixed(1).padStart(5)}  rest ${s.restDayOk ? 'ok' : 'NO'}  ${s.onShift ? 'on shift ' + s.onShift : ''}`);
}
console.log('\nalerts:');
for (const a of alerts(net)) console.log(` [${a.sev}] ${a.title}`);
const last = net.ledger.shifts.at(-1);
const h = net.ledger.getTx(last.signoutTx).tx.body.recordHash;
console.log('\nverify last sign-out:', net.verifyRecord(h).reason);
const t1 = Date.now();
const json = JSON.stringify(net.export());
const { FleetNetwork } = await import('../src/core/network.js');
FleetNetwork.import(JSON.parse(json));
console.log(`export ${(json.length / 1024).toFixed(0)} KB, re-validated import in ${Date.now() - t1} ms`);
