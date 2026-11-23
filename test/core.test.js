// Protocol tests on the EVM: system contracts, Proof of Green block
// production and block validation. Every block is re-executed by an
// independent validator node (see helpers.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, publicKeyOf, btcSimAddressOf, signRecoverable, signDigest, btcLinkMessage } from '../src/core/crypto.js';
import { fdk, stable, tonnesToKg } from '../src/core/units.js';
import { ADDRESSES } from '../src/evm/contracts.js';
import { stripBlock } from '../src/evm/chain.js';
import { schedule } from '../src/node/api-core.js';
import { setup, rejects } from './helpers.js';

const credit = (serial, extra = {}) => ({ project: 'P', country: 'PG', registry: 'Verra VCS', methodology: 'VM0047', vintage: 2024, serial, quantityKg: tonnesToKg('100').toString(), ...extra });

test('stablecoin settles marketplace trades; FDK only pays gas', async () => {
  const c = await setup();
  const { A } = c;
  await c.do('issuer', 'stable_mint', { to: A.bob, amount: stable('10000').toString(), reserveRef: 'att-1' });
  const issued = await c.do('auditor', 'credit_issue', credit('S-1', { to: A.alice }));
  const batchId = issued.events[0].batchId;
  assert.equal(batchId, 'CCB-000001');
  await c.do('alice', 'market_list', { batchId, quantityKg: tonnesToKg('50').toString(), pricePerTonne: stable('20').toString() });
  await c.approve('bob', 'CarbonMarketplace');
  await c.block();
  const fdkBefore = c.state().accounts[A.bob].fdk;
  const buy = await c.do('bob', 'market_buy', { listingId: 'LST-000001', quantityKg: tonnesToKg('10').toString() });
  assert.equal(buy.status, 'ok');
  const s = c.validator.state;
  assert.equal(s.accounts[A.bob].stable, stable('9800'));
  assert.equal(s.accounts[A.alice].stable, stable('199')); // 200 minus 0.5% platform fee
  assert.equal(s.accounts[A.gov].stable, stable('1'));
  assert.equal(s.accounts[A.bob].credits[batchId], tonnesToKg('10'));
  assert.equal(s.listings['LST-000001'].remainingKg, tonnesToKg('40'));
  // Bob's FDK only decreased by gas, which is tiny.
  const gas = fdkBefore - s.accounts[A.bob].fdk;
  assert.ok(gas > 0n && gas < fdk('0.01'), `gas paid ${gas}`);
  assert.equal(BigInt(buy.fee), gas);
});

test('buying without stablecoin fails even with plenty of FDK', async () => {
  const c = await setup();
  await c.do('auditor', 'credit_issue', credit('S-2', { to: c.A.alice, quantityKg: '5000' }));
  await c.do('alice', 'market_list', { batchId: 'CCB-000001', quantityKg: '5000', pricePerTonne: stable('10').toString() });
  await c.approve('bob', 'CarbonMarketplace');
  await c.block();
  await rejects(c.send('bob', 'market_buy', { listingId: 'LST-000001', quantityKg: '1000' }), /insufficient fUSD/);
});

test('a registry serial can only be tokenised once', async () => {
  const c = await setup();
  await c.do('auditor', 'credit_issue', credit('GS-1', { registry: 'Gold Standard' }));
  await rejects(c.send('auditor', 'credit_issue', credit('GS-1', { registry: 'Gold Standard' })), /double counting/);
});

test('only auditors issue credits; retirement burns and records', async () => {
  const c = await setup();
  await rejects(c.send('alice', 'credit_issue', credit('x')), /only an accredited auditor/);
  const r = await c.do('auditor', 'credit_issue', credit('y', { quantityKg: '3000' }));
  const batchId = r.events[0].batchId;
  const ret = await c.do('auditor', 'credit_retire', { batchId, quantityKg: '1000', beneficiary: 'Fedrok AG', reason: 'test' });
  assert.equal(ret.events[0].retirementId, 'RET-000001');
  const s = c.validator.state;
  assert.equal(s.batches[batchId].retiredKg, 1000n);
  assert.equal(s.retirements['RET-000001'].beneficiary, 'Fedrok AG');
  assert.equal(s.supply.creditsRetired, 1000n);
  assert.equal(s.accounts[c.A.auditor].credits[batchId], 2000n);
  // The contract agrees with the indexer.
  assert.equal(await c.producer.view('CarbonRegistry', 'balanceOf', [1, c.A.auditor]), 2000n);
});

test('back-minting locks credits and issues 1 FDK per tonne from the capped reserve', async () => {
  const c = await setup();
  await c.do('auditor', 'credit_issue', credit('R-1', { quantityKg: tonnesToKg('20').toString() }));
  const before = c.state().supply.fdkMinted;
  const r = await c.do('auditor', 'fdk_back_mint', { batchId: 'CCB-000001', quantityKg: tonnesToKg('20').toString(), to: c.A.alice });
  assert.equal(r.events[0].amount, fdk('20'));
  const s = c.validator.state;
  assert.equal(s.supply.fdkMinted - before, fdk('20'));
  assert.equal(s.backingVault['CCB-000001'], tonnesToKg('20'));
  assert.equal(s.accounts[c.A.alice].fdk, fdk('1020'));
  await rejects(c.send('alice', 'fdk_back_mint', { batchId: 'CCB-000001', quantityKg: '1' }), /only an accredited auditor/);
});

test('Proof of Green: accredited miner block switches production to its generators, with rewards', async () => {
  const c = await setup();
  const { A, k } = c;
  const btcKey = generatePrivateKey();
  const btcPub = publicKeyOf(btcKey);
  const btcAddress = btcSimAddressOf(btcPub);
  const btcSig = signRecoverable(btcLinkMessage(btcAddress, A.owner, c.genesis.chainId, ADDRESSES.ProofOfGreen), btcKey);
  const acc = await c.do('auditor', 'miner_accredit', { btcAddress, btcPubKey: btcPub, btcSig, owner: A.owner, units: 10, auditDays: 365, publicGenerators: true, generatorShareBps: 2000 });
  const minerId = acc.events[0].minerId;
  assert.match(minerId, /^MNR-[0-9A-F]{8}$/);
  assert.equal(c.validator.state.miners[minerId].btcAddress, btcAddress, 'the contract derived the same Bitcoin address');
  assert.equal(c.validator.state.piggyBank, fdk('230'));
  await c.send('gen', 'generator_register', { stake: fdk('100').toString(), name: 'G' });
  await c.send('gen', 'generator_link', { minerId });
  await c.block();
  assert.equal(schedule(c.validator.state).mode, 'fallback');

  // An accredited miner wins a Bitcoin block -> green mode: only its generator may produce.
  const h1 = c.btc(btcAddress);
  assert.equal(await c.producer.produce({ timestamp: c.t + 1000, btcHeaders: [h1], privKey: k.fallback }), null, 'fallback validator lost its slot');
  const ownerBefore = c.validator.state.accounts[A.owner].fdk;
  const b = await c.block({ btcHeaders: [h1], key: k.gen });
  assert.equal(b.header.mode, 'green');
  assert.equal(b.header.activeMiner, minerId);
  assert.ok(BigInt(b.header.reward) > 0n);
  assert.ok(c.validator.state.accounts[A.owner].fdk > ownerBefore, 'miner owner received its share');
  assert.equal(c.validator.state.miners[minerId].greenBlocks, 1);

  // No green blocks for greenWindow Bitcoin blocks -> fallback validator resumes.
  const hs = [c.btc('bcsim1dirty'), c.btc('bcsim1dirty'), c.btc('bcsim1dirty')];
  const fb = await c.block({ btcHeaders: hs, key: k.fallback });
  assert.equal(fb.header.mode, 'fallback');
  assert.equal(c.validator.state.pog.anchorHeight, 4);
});

test('forged Bitcoin ownership proof is rejected on-chain', async () => {
  const c = await setup();
  const btcKey = generatePrivateKey();
  const btcPub = publicKeyOf(btcKey);
  const btcAddress = btcSimAddressOf(btcPub);
  const btcSig = signRecoverable(btcLinkMessage(btcAddress, c.A.alice, c.genesis.chainId, ADDRESSES.ProofOfGreen), btcKey); // signed for alice
  await rejects(c.send('auditor', 'miner_accredit', { btcAddress, btcPubKey: btcPub, btcSig, owner: c.A.owner, units: 1 }), /ownership proof/);
});

test('forged Bitcoin headers are rejected by every node', async () => {
  const c = await setup();
  const h = c.btc('bcsim1x');
  const bad = { ...h, nonce: h.nonce + 1 };
  await rejects(c.producer.produce({ timestamp: c.t + 1000, btcHeaders: [bad], privKey: c.k.fallback }), /hash mismatch/);
});

test('tampered blocks and transactions are rejected by validators', async () => {
  const c = await setup();
  await c.send('alice', 'transfer', { to: c.A.bob, asset: 'FDK', amount: '1' });
  const good = stripBlock(await c.producer.produce({ timestamp: c.t + 1000, btcHeaders: [], privKey: c.k.fallback }));
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

test('governance-only actions are enforced', async () => {
  const c = await setup();
  await rejects(c.send('alice', 'gov_add_auditor', { auditor: c.A.alice, name: 'me' }), /governance only/);
  await rejects(c.send('alice', 'stable_mint', { to: c.A.alice, amount: '1', reserveRef: 'x' }), /only the stablecoin issuer/);
  const ok = await c.do('gov', 'gov_set_param', { key: 'greenWindow', value: 9 });
  assert.equal(ok.status, 'ok');
  assert.equal(c.validator.state.params.greenWindow, 9);
  await rejects(c.send('gov', 'gov_set_param', { key: 'greenWindow', value: 0 }), /invalid value/);
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
  // eth_call into a system contract
  const { IFACE } = await import('../src/evm/contracts.js');
  const out = await rpc.call('eth_call', [{ to: ADDRESSES.FedrokGovernance, data: IFACE.FedrokGovernance.encodeFunctionData('admin') }]);
  assert.equal(IFACE.FedrokGovernance.decodeFunctionResult('admin', out)[0].toLowerCase(), c.A.gov);
});
