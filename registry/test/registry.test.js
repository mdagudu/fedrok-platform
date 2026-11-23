// Project registry: contracts/ProjectRegistry.sol rules, end to end on the EVM.
// The lock is enforced by the contract, so it holds for every signer:
// the owner, governance, and any software acting with the owner's key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectContentHash } from '../src/evm/actions.js';
import { setup, rejects } from './helpers.js';

const base = { kind: 'registered', projectType: 'Reforestation & afforestation', name: 'Hillside Forest', summary: 'Native forest on degraded pasture.', location: 'Valais', country: 'Switzerland' };
const P = (c) => c.validator.state.projects;

async function withProject(extra = {}) {
  const c = await setup(['owner', 'stranger']);
  const r = await c.do('owner', 'project_create', { ...base, ...extra });
  assert.equal(r.status, 'ok');
  c.id = r.events[0].projectId;
  c.update = (who, changes) => {
    const p = P(c)[c.id];
    return c.send(who, 'project_update', { projectId: c.id, name: p.name, summary: p.summary, location: p.location, country: p.country, details: p.details, ...changes });
  };
  return c;
}

test('anyone can register or propose a project of a listed type', async () => {
  const c = await withProject();
  assert.equal(c.id, 'PRJ-000001');
  const p = P(c)[c.id];
  assert.equal(p.status, 'draft');
  assert.equal(p.kind, 'registered');
  assert.equal(p.owner, c.A.owner);
  const prop = await c.do('stranger', 'project_create', { ...base, kind: 'proposed', projectType: 'Solar energy', name: 'Village solar' });
  assert.equal(P(c)[prop.events[0].projectId].kind, 'proposed');
  await rejects(c.send('stranger', 'project_create', { ...base, projectType: 'Carbon credit trading' }), /choose a listed environmental project type/);
  await rejects(c.send('stranger', 'project_create', { ...base, name: 'x' }), /3-120 characters/);
});

test('the owner edits a draft; every edit is a revision on-chain; others cannot edit', async () => {
  const c = await withProject();
  await c.update('owner', { details: { objectives: 'Restore 40 ha', area: '40 ha' } });
  await c.block();
  await c.update('owner', { summary: 'Native mixed forest on 40 ha of degraded pasture.' });
  await c.block();
  const p = P(c)[c.id];
  assert.equal(p.revision, 2);
  assert.equal(p.details.area, '40 ha');
  assert.deepEqual(p.history.map((h) => h.action), ['created', 'updated', 'updated']);
  assert.deepEqual(p.history[2].changed, ['summary']);
  await rejects(c.update('stranger', { name: 'Hijacked' }), /only the project owner/);
  await rejects(c.update('gov', { name: 'Hijacked' }), /only the project owner/);
});

test('lock & submit freezes the project for everyone, forever', async () => {
  const c = await withProject();
  await c.update('owner', { details: { objectives: 'Restore 40 ha' } });
  await c.block();
  // The owner must lock exactly the content they reviewed.
  await rejects(c.send('owner', 'project_lock', { projectId: c.id, contentHash: projectContentHash({ ...P(c)[c.id], name: 'Other' }) }), /changed since you reviewed it/);
  await rejects(c.send('stranger', 'project_lock', { projectId: c.id, contentHash: projectContentHash(P(c)[c.id]) }), /only the project owner/);
  const r = await c.do('owner', 'project_lock', { projectId: c.id, contentHash: projectContentHash(P(c)[c.id]) });
  assert.equal(r.status, 'ok');
  const p = P(c)[c.id];
  assert.equal(p.status, 'locked');
  assert.equal(p.lockedHash, projectContentHash(p));
  // No further changes from anyone, including the owner's own key (which an AI assistant would use).
  await rejects(c.update('owner', { summary: 'changed' }), /locked and submitted: it can no longer be changed/);
  await rejects(c.update('stranger', { summary: 'changed' }), /only the project owner/);
  await rejects(c.send('owner', 'project_lock', { projectId: c.id, contentHash: p.lockedHash }), /already locked/);
  // On-chain record matches.
  const onchain = await c.producer.view('ProjectRegistry', 'project', [1]);
  assert.equal(Number(onchain.status), 1);
  assert.equal(onchain.lockedHash, p.lockedHash);
});

test('a draft cannot be locked before it has a summary and details', async () => {
  const c = await withProject({ summary: '' });
  await rejects(c.send('owner', 'project_lock', { projectId: c.id, contentHash: projectContentHash(P(c)[c.id]) }), /add a summary/);
  await c.update('owner', { summary: 'Now with a summary' });
  await c.block();
  await rejects(c.send('owner', 'project_lock', { projectId: c.id, contentHash: projectContentHash(P(c)[c.id]) }), /add the project details/);
});

test('a locked project can still be retired by its owner; content stays unchanged', async () => {
  const c = await withProject();
  await c.update('owner', { details: { objectives: 'Restore 40 ha' } });
  await c.block();
  await c.do('owner', 'project_lock', { projectId: c.id, contentHash: projectContentHash(P(c)[c.id]) });
  const lockedHash = P(c)[c.id].lockedHash;
  await rejects(c.send('stranger', 'project_retire', { projectId: c.id, reason: 'spite' }), /only the project owner/);
  await rejects(c.send('owner', 'project_retire', { projectId: c.id, reason: '' }), /reason is required/);
  await c.do('owner', 'project_retire', { projectId: c.id, reason: 'Land sold; project ended' });
  const p = P(c)[c.id];
  assert.equal(p.status, 'retired');
  assert.equal(p.retiredAfterLock, true);
  assert.equal(projectContentHash(p), lockedHash);
  await rejects(c.update('owner', { summary: 'changed' }), /locked and submitted/);
  await rejects(c.send('owner', 'project_retire', { projectId: c.id, reason: 'again' }), /already retired/);
  assert.equal(c.validator.state.counters.retired, 1);
});

test('governance can add project types', async () => {
  const c = await setup();
  await rejects(c.send('alice', 'gov_add_project_type', { projectType: 'Seagrass restoration' }), /governance only/);
  await c.do('gov', 'gov_add_project_type', { projectType: 'Seagrass restoration' });
  assert.ok(c.validator.state.projectTypes.includes('Seagrass restoration'));
  await c.do('alice', 'project_create', { ...base, projectType: 'Seagrass restoration' });
});

test('profiles: an account names itself; project views show the owner', async () => {
  const c = await setup(['alice', 'bob']);
  await rejects(c.send('alice', 'profile_set', { name: 'A', organisation: '' }), /2-80/);
  await c.do('alice', 'profile_set', { name: 'Alice Moyo', organisation: 'Green Valley Trust' });
  assert.deepEqual({ ...c.validator.state.profiles[c.A.alice], updatedAt: 0 }, { name: 'Alice Moyo', organisation: 'Green Valley Trust', updatedAt: 0 });
  assert.equal(c.validator.state.profiles[c.A.bob], undefined);
});
