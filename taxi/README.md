# Fedrok Taxi Integrity (Malta pilot)

A permissioned-ledger application for Fedrok's taxi business. For every shift it records:

1. **Palm-vein sign-in**: the driver's palm is matched in the car against their enrolled template.
2. **Palm-vein sign-out**: the same palm has to end the shift.
3. **Where the car is parked** at sign-out: a Galileo OSNMA-authenticated fix, checked against the car's approved garage geofence.

Live demo: https://mdagudu.github.io/fedrok-platform/taxi/

## How it works

| Step | What happens | Code |
|---|---|---|
| Identify | Palm-vein scan matched **in the car**. The live sample is discarded. Only the result, score and the template's salted hash leave the reader. | `src/core/incar.js` |
| Locate | Galileo OSNMA fix, cross-checked with the mobile network's location. A spoofed fix is flagged. | `src/core/incar.js` |
| Seal | The in-car unit's secure chip (Ed25519) signs the record hash. | `src/core/incar.js` |
| Anchor | The full record goes to the EU record store. Its SHA-256 hash goes on the ledger, in a block signed by 2 of 3 validators (Fedrok AG, Transport Malta observer, independent auditor). | `src/core/ledger.js`, `src/core/network.js` |
| Verify | Anyone with access recomputes the hash and checks the chip seal and the ledger anchor. | `FleetNetwork.verifyRecord` |

**Privacy.** Raw palm data never leaves the car. The ledger holds only record hashes, pseudonymous driver refs (salted hashes), shift times and flags: no names, no coordinates, no biometrics. Personal records can be erased from the EU store (`record.erase`). The hash stays, so the history remains provable.

**Rules checked** (`src/core/compliance.js`): one driver per account (a palm that doesn't match is refused and logged), 12 hours in any 24 counted per person across cars, a weekly rest day, licence and driver tag expiry, parking in the approved garage, and locations that can't be authenticated.

**Ledger rules** (`src/core/ledger.js`): only the fleet operator key can register cars and enrol drivers. Only a car's own fitted unit can write sign-in and sign-out events for that car. A driver can't be signed in to two cars at once. A sign-out must come from the signed-in driver's palm. Blocks chain by hash and carry a Merkle root of their transactions. Importing a chain re-validates every block.

## Run

```bash
cd taxi
npm install
npm test          # ledger, palm matching, flags, tamper detection, GDPR erasure
npm run demo      # build the 7-day demo fleet and print hours and alerts
npm run build     # dist/fedrok-taxi.html, one self-contained page
```

The web app runs the whole network in the browser: three validators, the EU store and eight in-car units, with simulated palm scans and satellite fixes. Your actions are saved in your browser's local storage.
