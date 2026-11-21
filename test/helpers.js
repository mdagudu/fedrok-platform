// Test harness: a producer chain and an independent validator chain that
// re-executes every block, both running the real EVM and system contracts.
import assert from 'node:assert/strict';
import { generatePrivateKey, addressFromPrivate, sha256Hex } from '../src/core/crypto.js';
import { btcHeaderHash, meetsDifficulty } from '../src/core/btc.js';
import { fdk } from '../src/core/units.js';
import { Chain, stripBlock } from '../src/evm/chain.js';
import { encodeAction } from '../src/evm/actions.js';
import { signEvmTx } from '../src/evm/signer.js';

export const DIFF = 1;
export function mineHeader(prev, minerAddress) {
  for (let nonce = 0; ; nonce++) {
    const h = { height: prev.height + 1, prevHash: prev.hash, time: Date.now(), nonce, minerAddress, merkle: sha256Hex(String(prev.height)) };
    const hash = btcHeaderHash(h);
    if (meetsDifficulty(hash, DIFF)) return { ...h, hash };
  }
}

const memStorage = () => ({ blocks: [], load() { return this.blocks; }, append(b) { this.blocks.push(b); }, rewrite(bs) { this.blocks = bs; } });
const quiet = { info() {}, warn() {} };

export async function setup(names = [], { extraAlloc = {}, noFdk = [] } = {}) {
  const all = ['gov', 'auditor', 'issuer', 'fallback', 'alice', 'bob', 'gen', 'owner', ...names];
  const k = Object.fromEntries(all.map((n) => [n, generatePrivateKey()]));
  const A = Object.fromEntries(Object.entries(k).map(([n, v]) => [n, addressFromPrivate(v)]));
  const btc0 = { height: 0, prevHash: '0x' + '0'.repeat(64), time: 0, nonce: 0, minerAddress: 'genesis', merkle: '0x00' };
  btc0.hash = btcHeaderHash(btc0);
  const now = Math.floor(Date.now() / 1000) * 1000 - 3_600_000;
  const genesis = {
    network: 'fedrok-test', chainId: 7799, timestamp: now, admin: A.gov, stableIssuer: A.issuer,
    stable: { symbol: 'fUSD', name: 'test', decimals: 6 }, fallbackValidator: A.fallback,
    btc: { anchorHeight: 0, anchorHash: btc0.hash, difficulty: DIFF }, fdkCap: fdk('1000000000').toString(),
    params: { blockTimeMs: 1000, minGasPrice: '1000000000', minGeneratorStake: fdk('100').toString(), fdkPerUnitYear: fdk('23').toString(), greenWindow: 3, maxGeneratorsPerMiner: 21, marketFeeBps: 50, maxTxPerBlock: 500 },
    auditors: [{ address: A.auditor, name: 'Test auditor' }],
    alloc: all.filter((n) => n !== 'fallback' && !noFdk.includes(n)).map((n) => ({ address: A[n], fdk: fdk(extraAlloc[n] || '1000').toString() })),
  };
  const producer = new Chain(genesis, memStorage(), quiet);
  const validator = new Chain(genesis, memStorage(), quiet);
  await producer.load();
  await validator.load();
  const c = { k, A, genesis, producer, validator, chain: producer, t: now, btcTip: btc0 };
  c.state = () => producer.state;
  /** Sign and submit an action; resolves to the tx hash, or rejects with the node's reason. */
  c.send = async (who, type, payload, opts = {}) => {
    const call = encodeAction(type, payload, { from: A[who] });
    const { raw } = signEvmTx({ chainId: genesis.chainId, nonce: producer.nextNonce(A[who]), to: call.to, data: call.data, value: call.value, gasLimit: opts.gasLimit || 6_000_000n, minGasPrice: genesis.params.minGasPrice }, k[who]);
    return (await producer.addTx(raw)).hash;
  };
  c.approve = (who, contract) => c.send(who, 'stable_approve', { spender: producer.state.contracts[contract], amount: ((1n << 256n) - 1n).toString() });
  c.block = async ({ btcHeaders = [], key } = {}) => {
    c.t += 1000;
    const b = await producer.produce({ timestamp: c.t, btcHeaders, privKey: key || k.fallback });
    assert.ok(b, 'block was not produced');
    await validator.addBlock(JSON.parse(JSON.stringify(stripBlock(b)))); // independent re-execution
    assert.equal(validator.state.tipHash, producer.state.tipHash);
    return b;
  };
  /** Submit and mine; returns the receipt view. */
  c.do = async (who, type, payload, opts) => {
    const hash = await c.send(who, type, payload, opts);
    await c.block(opts);
    return c.tx(hash);
  };
  c.tx = (hash) => {
    const i = producer.txIndex.get(hash);
    return i ? { ...i.receipt, height: i.height } : null;
  };
  c.btc = (minerAddress) => {
    c.btcTip = mineHeader(c.btcTip, minerAddress);
    return c.btcTip;
  };
  return c;
}

export async function rejects(promise, re) {
  await assert.rejects(promise, (e) => {
    assert.match(e.message, re);
    return true;
  });
}
