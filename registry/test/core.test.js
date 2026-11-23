// Protocol tests on the EVM: Proof of Authority block production, block
// validation, governance and the settlement stablecoin. Every block is
// re-executed by an independent validator node (see helpers.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { signDigest } from '../src/core/crypto.js';
import { fdk, stable } from '../src/core/units.js';
import { ADDRESSES } from '../src/evm/contracts.js';
import { stripBlock } from '../src/evm/chain.js';
import { setup, rejects } from './helpers.js';

test('no carbon registry, marketplace or Proof of Green contracts are deployed', async () => {
  assert.deepEqual(Object.keys(ADDRESSES), ['FedrokGovernance', 'FDKIssuer', 'FUSD', 'ProjectRegistry', 'LegacyGarden']);
  const c = await setup();
  for (const name of ['CarbonRegistry', 'CarbonMarketplace', 'ProofOfGreen']) assert.equal(c.state().contracts[name], undefined);
});

test('Proof of Authority: validators take turns and nobody else can seal a block', async () => {
  const c = await setup(['mallory'], { validators: ['v1', 'v2', 'v3'] });
  const seen = new Set();
  for (let i = 0; i < 6; i++) seen.add((await c.block()).header.validator);
  assert.deepEqual([...seen].sort(), [c.A.v1, c.A.v2, c.A.v3].sort());
  assert.equal(c.validator.state.validatorInfo[c.A.v1].blocks, 2);
  // Out of turn: the next slot's leader is someone else.
  const t = c.t + 1000;
  const wrong = [c.k.v1, c.k.v2, c.k.v3].find((k) => k !== c.leaderKey(t));
  assert.equal(await c.producer.produce({ timestamp: t, privKey: wrong }), null);
  assert.equal(await c.producer.produce({ timestamp: t, privKey: c.k.mallory }), null);
});

test('tampered blocks and transactions are rejected by validators', async () => {
  const c = await setup();
  await c.send('alice', 'transfer', { to: c.A.bob, asset: 'FDK', amount: '1' });
  const good = stripBlock(await c.producer.produce({ timestamp: c.t + 1000, privKey: c.k.val }));
  const forged = structuredClone(good);
  forged.txs[0].raw = forged.txs[0].raw.slice(0, -2) + (forged.txs[0].raw.endsWith('00') ? '01' : '00');
  await rejects(c.validator.addBlock(forged), /txRoot|signature|invalid/);
  const wrongSigner = structuredClone(good);
  wrongSigner.sig = signDigest(wrongSigner.hash, c.k.alice);
  await rejects(c.validator.addBlock(wrongSigner), /signature/);
  const wrongRoot = structuredClone(good);
  wrongRoot.header.stateRoot = '0x' + '1'.repeat(64);
  await rejects(c.validator.addBlock(wrongRoot), /hash mismatch/);
  await c.validator.addBlock(good); // the untouched block is fine
  assert.equal(c.validator.state.tipHash, c.producer.state.tipHash);
});

test('a block sealed by a non-validator is rejected even when well signed', async () => {
  const c = await setup(['mallory']);
  const { Chain } = await import('../src/evm/chain.js');
  // Mallory runs her own producer with a doctored genesis that lists her as validator.
  const fake = new Chain({ ...c.genesis, validators: [{ address: c.A.mallory, name: 'me' }] }, { blocks: [], load() { return []; }, append() {}, rewrite() {} }, { info() {}, warn() {} });
  await fake.load();
  const b = await fake.produce({ timestamp: c.t + 1000, privKey: c.k.mallory });
  const forged = { ...stripBlock(b), header: { ...b.header, prevHash: c.validator.state.tipHash } };
  await rejects(c.validator.addBlock(forged), /hash mismatch|validator|slot|prevHash/);
});

test('governance manages validators and parameters; others cannot', async () => {
  const c = await setup(['newval']);
  await rejects(c.send('alice', 'gov_add_validator', { validator: c.A.alice, name: 'me' }), /governance only/);
  await rejects(c.send('alice', 'stable_mint', { to: c.A.alice, amount: '1', reserveRef: 'x' }), /only the stablecoin issuer/);
  await c.do('gov', 'gov_add_validator', { validator: c.A.newval, name: 'Validator Basel' });
  assert.deepEqual(c.validator.state.validators, [c.A.val, c.A.newval]);
  // The new validator now gets its own slots.
  const sealers = new Set();
  for (let i = 0; i < 4; i++) sealers.add((await c.block()).header.validator);
  assert.ok(sealers.has(c.A.newval));
  await c.do('gov', 'gov_remove_validator', { validator: c.A.newval });
  assert.deepEqual(c.validator.state.validators, [c.A.val]);
  await rejects(c.send('gov', 'gov_remove_validator', { validator: c.A.val }), /at least one validator/);
  const ok = await c.do('gov', 'gov_set_param', { key: 'maxTxPerBlock', value: 900 });
  assert.equal(ok.status, 'ok');
  assert.equal(c.validator.state.params.maxTxPerBlock, 900);
  await rejects(c.send('gov', 'gov_set_param', { key: 'greenWindow', value: 3 }), /unknown parameter/);
});

test('stablecoin transfers; FDK only pays gas', async () => {
  const c = await setup();
  await c.do('issuer', 'stable_mint', { to: c.A.bob, amount: stable('100').toString(), reserveRef: 'att-1' });
  const before = c.state().accounts[c.A.bob].fdk;
  const r = await c.do('bob', 'transfer', { to: c.A.alice, asset: 'STABLE', amount: stable('40').toString() });
  assert.equal(r.status, 'ok');
  assert.equal(c.validator.state.accounts[c.A.alice].stable, stable('40'));
  const gas = before - c.validator.state.accounts[c.A.bob].fdk;
  assert.ok(gas > 0n && gas < fdk('0.01'));
});

test('standard Ethereum JSON-RPC works against the node', async () => {
  const c = await setup();
  const { EthRpc } = await import('../src/node/eth-rpc.js');
  const rpc = new EthRpc(c.producer);
  assert.equal(await rpc.call('eth_chainId'), '0x' + (7799).toString(16));
  const hash = await c.send('alice', 'transfer', { to: c.A.bob, asset: 'FDK', amount: fdk('1').toString() });
  await c.block();
  const rcpt = await rpc.call('eth_getTransactionReceipt', [hash]);
  assert.equal(rcpt.status, '0x1');
  assert.equal(rcpt.gasUsed, '0x5208'); // 21000
  assert.equal(BigInt(await rpc.call('eth_getBalance', [c.A.bob])), fdk('1001'));
  const block = await rpc.call('eth_getBlockByNumber', ['latest', true]);
  assert.equal(block.transactions[0].hash, hash);
  const { IFACE } = await import('../src/evm/contracts.js');
  const out = await rpc.call('eth_call', [{ to: ADDRESSES.FedrokGovernance, data: IFACE.FedrokGovernance.encodeFunctionData('admin') }]);
  assert.equal(IFACE.FedrokGovernance.decodeFunctionResult('admin', out)[0].toLowerCase(), c.A.gov);
});
