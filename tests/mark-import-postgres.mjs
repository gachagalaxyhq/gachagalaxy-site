// Opt-in, ONLY creates its own disposable PostgreSQL; no external target input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { planCutover } from '../scripts/mark-cutover.mjs';
import { syntheticManifest, rehearsalTransaction, withSyntheticTarget, main } from '../scripts/mark-import-rehearsal.mjs';

const bin = process.env.MARK_TEST_POSTGRES_BIN;
const manifest = syntheticManifest();
const digest = planCutover(manifest).inputSha256;
const local = fn => withSyntheticTarget(bin, fn);

test('synthetic boundary rejects arbitrary data, invalid inputs and missing exclusion approval before SQL', async () => {
  const changes = [m => { m.historicalUsed = null; }, m => { m.snapshot.complete = false; },
    m => { m.records[0].email = 'private@example.invalid'; },
    m => { m.records[1].cert = m.records[0].cert; m.records[1].grader = m.records[0].grader; },
    m => { m.records[0].targetId = null; }, m => { m.records[0].free = false; }];
  for (const change of changes) {
    const m = structuredClone(manifest); change(m);
    assert.throws(() => rehearsalTransaction(m, digest, '{}'));
  }
  assert.throws(() => rehearsalTransaction(manifest, '0'.repeat(64), '{}'), /MANIFEST_DIGEST_MISMATCH/);
  const retained = syntheticManifest({ retained: true });
  const plan = planCutover(retained);
  assert.ok(plan.blockers.includes('RETAINED_IDENTITIES_NEED_APPROVED_EXCLUSION_MAPPING'));
  assert.equal(plan.mapping[1].status, 'fulfilled');
  assert.throws(() => rehearsalTransaction(retained, plan.inputSha256, '{}'), /UNAPPROVED_EXCLUSION/);
  for (const args of [[], ['--apply'], ['--synthetic', '--database-url', 'postgres://example.invalid']]) {
    await assert.rejects(main(args), /SYNTHETIC_USAGE_ONLY/);
  }
});

test('transaction preserves explicit IDs/free/status/usage, null preconditions and closed gates; exact replay is a no-op', () => local(async ({ query, state }) => {
  const initial = await state();
  assert.equal(JSON.parse(initial).policy[0].used, null);
  await query(rehearsalTransaction(manifest, digest, initial));
  const committed = await state();
  const s = JSON.parse(committed);
  assert.deepEqual(s.requests.map(r => [r.id, r.grader, r.cert, r.status, r.free]),
    manifest.records.map(r => [r.targetId, r.grader, r.cert, r.status, r.free]));
  assert.ok(s.requests.every(r => r.email.endsWith('@example.invalid') && r.created_at.startsWith('2000-01-01')));
  assert.equal(s.policy[0].used, 14); // NOT number of free fixture rows (1), and NOT clamped to ten.
  assert.equal(s.policy[0].approved, false); assert.equal(s.policy[0].legacy_reconciled, false);
  assert.equal(s.policy[0].scope, null); assert.equal(s.policy[0].approval_reference, null);
  assert.equal(s.receipts[0].manifest_sha256, digest);
  assert.deepEqual(s.receipts[0].mapping, manifest.records);
  assert.equal(s.audit.length, 0);
  await query(rehearsalTransaction(manifest, digest, committed));
  assert.equal(await state(), committed);
  await assert.rejects(query(`select public.claim_mark_v2('PSA','980001','replacement@example.invalid')`), /Intake approval required/);
  await assert.rejects(query(rehearsalTransaction(manifest, digest, initial)), /STALE_TARGET_PRECONDITION/);
  assert.equal(await state(), committed);
}));

test('late receipt-write failure rolls back requests AND historical usage; retry commits once', () => local(async ({ query, state }) => {
  const before = await state();
  await query(`create function mark_rehearsal.fail_receipt() returns trigger language plpgsql as
    'begin raise exception ''SYNTHETIC_RECEIPT_FAILURE''; end';
    create trigger fail_receipt before insert on mark_rehearsal.receipts for each row
    execute function mark_rehearsal.fail_receipt();`);
  await assert.rejects(query(rehearsalTransaction(manifest, digest, before)), /SYNTHETIC_RECEIPT_FAILURE/);
  assert.equal(await state(), before);
  await query('drop trigger fail_receipt on mark_rehearsal.receipts');
  await query(rehearsalTransaction(manifest, digest, before));
  const after = await state();
  await query(rehearsalTransaction(manifest, digest, after));
  assert.equal(await state(), after);
}));

test('database independently verifies manifest digest even if compiled SQL is tampered', () => local(async ({ query, state }) => {
  const before = await state();
  // Keep the JS validator intact, replace only the expected SQL digest.
  const transaction = rehearsalTransaction(manifest, digest, before).replaceAll(digest, '0'.repeat(64));
  await assert.rejects(query(transaction), /MANIFEST_DIGEST_MISMATCH/);
  assert.equal(await state(), before);
}));

test('changed policy or colliding target fails stale and refreshed empty-target preconditions without writes', () => local(async ({ query, state }) => {
  const before = await state();
  await query('update mark_intake_private.policy set used=0');
  const changed = await state();
  await assert.rejects(query(rehearsalTransaction(manifest, digest, before)), /STALE_TARGET_PRECONDITION/);
  await assert.rejects(query(rehearsalTransaction(manifest, digest, changed)), /EMPTY_UNRECONCILED_TARGET_REQUIRED/);
  assert.equal(await state(), changed);
  await query(`update mark_intake_private.policy set used=null;
    insert into mark_intake_private.requests(id,grader,cert,email,free)
    values('${manifest.records[0].targetId}','PSA','980001','other@example.invalid',false)`);
  const collision = await state();
  await assert.rejects(query(rehearsalTransaction(manifest, digest, before)), /STALE_TARGET_PRECONDITION/);
  await assert.rejects(query(rehearsalTransaction(manifest, digest, collision)), /EMPTY_UNRECONCILED_TARGET_REQUIRED/);
  assert.equal(await state(), collision);
}));

test('replay rejects drift even with refreshed precondition; roles cannot access receipts', () => local(async ({ query, state }) => {
  await query(rehearsalTransaction(manifest, digest, await state()));
  const committed = await state();
  for (const patch of ["update mark_intake_private.requests set free=not free where grader='PSA'",
    "update mark_intake_private.requests set email=null where grader='PSA'",
    'update mark_intake_private.policy set used=15']) {
    // Independently exercise each drift, rather than inheriting earlier damage.
    await query(`update mark_intake_private.requests set free=true,email='synthetic-980001@example.invalid' where grader='PSA';
      update mark_intake_private.policy set used=14;`);
    await query(patch);
    const drift = await state();
    await assert.rejects(query(rehearsalTransaction(manifest, digest, committed)), /STALE_TARGET_PRECONDITION/);
    await assert.rejects(query(rehearsalTransaction(manifest, digest, drift)), /REPLAY_STATE_MISMATCH/);
    assert.equal(await state(), drift);
  }
  for (const role of ['anon', 'authenticated', 'service_role', 'mark_intake_rpc']) {
    await assert.rejects(query(`set role ${role}; select * from mark_rehearsal.receipts`), /permission denied/);
  }
}));

test('missing singleton or an approved target is rejected without changing gates', () => local(async ({ query, state }) => {
  await query('delete from mark_intake_private.policy');
  const absent = await state();
  await assert.rejects(query(rehearsalTransaction(manifest, digest, absent)), /query returned no rows/);
  assert.equal(await state(), absent);
  await query(`insert into mark_intake_private.policy(singleton,approved,legacy_reconciled,scope,used,approval_reference)
    values(true,true,true,'global',14,'SYNTHETIC-NOT-AUTHORIZATION')`);
  const approved = await state();
  await assert.rejects(query(rehearsalTransaction(manifest, digest, approved)), /CLOSED_TARGET_REQUIRED/);
  assert.equal(await state(), approved);
}));

test('independent transactions with the same precondition serialize; only one commits', () => local(async ({ query, state }) => {
  const before = await state();
  const transaction = rehearsalTransaction(manifest, digest, before);
  const results = await Promise.allSettled([query(transaction), query(transaction)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /STALE_TARGET_PRECONDITION/);
  const s = JSON.parse(await state());
  assert.equal(s.requests.length, 2); assert.equal(s.receipts.length, 1); assert.equal(s.policy[0].used, 14);
}));

test('CLI creates disposable local target and reports only synthetic verification', async () => {
  const { stdout } = await promisify(execFile)(process.execPath,
    [new URL('../scripts/mark-import-rehearsal.mjs', import.meta.url).pathname, '--synthetic', '--postgres-bin', bin],
    { env: { PATH: '/usr/bin:/bin' }, timeout: 30000 });
  assert.deepEqual(JSON.parse(stdout), { syntheticOnly: true, imported: 2, historicalUsed: 14,
    replayUnchanged: true, publicIntakeEnabled: false, paymentsEnabled: false, liveVerified: false });
});
