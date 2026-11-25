// In-car unit: palm-vein reader, Galileo receiver and secure chip.
//
// Palm data never leaves the car. At enrolment the depot reader extracts a
// template; the car keeps the template (in the real unit, inside the secure
// element) and only a salted SHA-256 commitment of it is registered on the
// ledger. At each scan the live sample is compared with the stored template in
// the car, the sample is discarded, and only the match result, score and the
// template commitment go into the record.
import { bytesToHex, hexToBytes, sha256Hex, utf8ToBytes, hashObject, sign, rng } from './crypto.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { distanceM, round6 } from './geo.js';

export const TEMPLATE_BITS = 512;
export const MATCH_THRESHOLD = 0.82;
const BYTES = TEMPLATE_BITS / 8;

/** The vein pattern of a person's hand (simulated, derived from a private seed). */
export function veinPattern(handSeed) {
  const out = new Uint8Array(BYTES);
  for (let i = 0; i < BYTES; i += 32) out.set(sha256(utf8ToBytes(`vein:${handSeed}:${i}`)).slice(0, Math.min(32, BYTES - i)), i);
  return out;
}

/** A reader capture: the true pattern with sensor noise (a fraction of bits flipped). */
export function capture(pattern, noise, rand) {
  const out = new Uint8Array(pattern);
  for (let bit = 0; bit < TEMPLATE_BITS; bit++) {
    if (rand() < noise) out[bit >> 3] ^= 1 << (bit & 7);
  }
  return out;
}

export function similarity(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i];
    while (x) { diff += x & 1; x >>= 1; }
  }
  return 1 - diff / TEMPLATE_BITS;
}

export const templateCommit = (salt, templateHex) => sha256Hex(`${salt}:${templateHex}`);
export const driverRefFor = (operatorId, employeeNo) => sha256Hex(`driver:${operatorId}:${employeeNo}`);

/** Enrol at the depot reader. Returns what the car stores and what goes on the ledger. */
export function enrolTemplate(handSeed, salt, rand) {
  const template = bytesToHex(capture(veinPattern(handSeed), 0.02, rand));
  return { template, salt, commit: templateCommit(salt, template) };
}

export class InCarUnit {
  constructor({ unitId, vehicleId, key, templates = {} }) {
    this.unitId = unitId;
    this.vehicleId = vehicleId;
    this.key = key; // { secret, pub } - the secure chip's signing key
    this.templates = new Map(Object.entries(templates)); // driverRef -> { template, salt, commit }
  }

  storeTemplate(driverRef, t) { this.templates.set(driverRef, t); }

  /**
   * Scan the palm placed on the reader and match it, in the car, against the
   * template of the account being used. `handSeed` is whoever is physically
   * presenting their hand, which is how a borrowed account is caught.
   */
  scanPalm(handSeed, claimedDriverRef, rand = Math.random) {
    const stored = this.templates.get(claimedDriverRef);
    if (!stored) return { result: 'no-template', score: 0, threshold: MATCH_THRESHOLD, liveness: true, templateRef: null };
    const sample = capture(veinPattern(handSeed), 0.04 + rand() * 0.03, rand);
    const score = Math.round(similarity(sample, hexToBytes(stored.template)) * 1000) / 1000;
    sample.fill(0); // the live sample is discarded immediately
    return {
      result: score >= MATCH_THRESHOLD ? 'match' : 'no-match',
      score,
      threshold: MATCH_THRESHOLD,
      liveness: true, // near-infrared vein imaging needs blood flow in a live hand
      templateRef: stored.commit,
      reader: 'Palm-vein reader (near-infrared)',
    };
  }

  /**
   * A satellite fix. Galileo OSNMA authenticates the navigation message, so a
   * GPS-spoofing app or transmitter cannot produce an authenticated fix. The fix
   * is cross-checked with the mobile network's cell location and vehicle speed.
   */
  fix(point, { spoof = false } = {}, rand = Math.random) {
    if (spoof) {
      return {
        lat: round6(point.lat), lon: round6(point.lon), accuracyM: 4,
        source: 'GNSS (unauthenticated)', osnmaAuthenticated: false,
        networkCheckM: 2400 + Math.round(rand() * 4000), speedKmh: 0,
      };
    }
    return {
      lat: round6(point.lat), lon: round6(point.lon), accuracyM: 2 + Math.round(rand() * 3),
      source: 'Galileo OSNMA', osnmaAuthenticated: true,
      networkCheckM: 40 + Math.round(rand() * 160), speedKmh: 0,
    };
  }

  /** Seal: the secure chip signs the record hash, binding driver, position and event together. */
  seal(record) {
    const hash = hashObject(record);
    return { hash, seal: { unitPub: this.key.pub, sig: sign(this.key.secret, hash) } };
  }

  export() {
    return { unitId: this.unitId, vehicleId: this.vehicleId, key: this.key, templates: Object.fromEntries(this.templates) };
  }
}

export function locationFlags(loc) {
  const flags = [];
  if (!loc.osnmaAuthenticated) flags.push('location-unauthenticated');
  if (loc.networkCheckM > 500) flags.push('location-network-mismatch');
  return flags;
}

export function parkedCheck(loc, garage) {
  const d = distanceM(loc, garage);
  return { garage: garage.name, distanceM: d, inApprovedGarage: d <= garage.radiusM };
}

export { rng };
