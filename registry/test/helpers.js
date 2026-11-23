// Test harness: a producer chain and an independent validator chain that
// re-executes every block, both running the real EVM and system contracts.
import assert from 'node:assert/strict';
import { generatePrivateKey, addressFromPrivate } from '../src/core/crypto.js';
import { fdk } from '../src/core/units.js';
import { PROJECT_TYPES } from '../src/core/genesis.js';
import { Chain, stripBlock, leaderFor } from '../src/evm/chain.js';
import { encodeAction } from '../src/evm/actions.js';
import { signEvmTx } from '../src/evm/signer.js';

const memStorage = () => ({ blocks: [], load() { return this.blocks; }, append(b) { this.blocks.push(b); }, rewrite(bs) { this.blocks = bs; } });
const quiet = { info() {}, warn() {} };

/** validators: names of the authority validators (default: one, "val"). */
export async function setup(names = [], { extraAlloc = {}, noFdk = [], validators = ['val'] } = {}) {
  const all = [...new Set(['gov', 'issuer', 'alice', 'bob', ...validators, ...names])];
  const k = Object.fromEntries(all.map((n) => [n, generatePrivateKey()]));
  const A = Object.fromEntries(Object.entries(k).map(([n, v]) => [n, addressFromPrivate(v)]));
  const now = Math.floor(Date.now() / 1000) * 1000 - 3_600_000;
  const genesis = {
    network: 'fedrok-test', chainId: 7799, timestamp: now, admin: A.gov, stableIssuer: A.issuer,
    stable: { symbol: 'fUSD', name: 'test', decimals: 6 },
    validators: validators.map((v) => ({ address: A[v], name: `Validator ${v}` })),
    projectTypes: PROJECT_TYPES,
    fdkCap: fdk('1000000000').toString(),
    params: { blockTimeMs: 1000, minGasPrice: '1000000000', maxTxPerBlock: 500 },
    alloc: all.filter((n) => !noFdk.includes(n)).map((n) => ({ address: A[n], fdk: fdk(extraAlloc[n] || '1000').toString() })),
  };
  const producer = new Chain(genesis, memStorage(), quiet);
  const validator = new Chain(genesis, memStorage(), quiet);
  await producer.load();
  await validator.load();
  const c = { k, A, genesis, producer, validator, chain: producer, t: now };
  c.state = () => producer.state;
  /** Private key of the validator that leads the slot of timestamp t. */
  c.leaderKey = (t) => {
    const lead = leaderFor(producer.state.validators, Math.floor(t / producer.state.params.blockTimeMs));
    return k[Object.keys(A).find((n) => A[n] === lead)];
  };
  /** Sign and submit an action; resolves to the tx hash, or rejects with the node's reason. */
  c.send = async (who, type, payload, opts = {}) => {
    const call = encodeAction(type, payload, { from: A[who] });
    const { raw } = signEvmTx({ chainId: genesis.chainId, nonce: producer.nextNonce(A[who]), to: call.to, data: call.data, value: call.value, gasLimit: opts.gasLimit || 15_000_000n, minGasPrice: genesis.params.minGasPrice }, k[who]);
    return (await producer.addTx(raw)).hash;
  };
  c.approve = (who, contract) => c.send(who, 'stable_approve', { spender: producer.state.contracts[contract], amount: ((1n << 256n) - 1n).toString() });
  c.block = async ({ key } = {}) => {
    c.t += 1000;
    const b = await producer.produce({ timestamp: c.t, privKey: key || c.leaderKey(c.t) });
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
  return c;
}

export async function rejects(promise, re) {
  await assert.rejects(promise, (e) => {
    assert.match(e.message, re);
    return true;
  });
}
