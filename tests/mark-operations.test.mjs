import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { planCutover } from '../scripts/mark-cutover.mjs';
const source = await readFile(new URL('../functions/api/mark-request.js', import.meta.url), 'utf8');
const api = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
// All three scoped bindings are required since the intake gate token was added; without
// MARK_INTAKE_GATE the handler returns 503 before transport and the bounds below go untested.
const env = { MARK_INTAKE_RPC_TOKEN: 'synthetic', MARK_INTAKE_API_KEY: 'synthetic', MARK_INTAKE_GATE: 'synthetic' };
const body = JSON.stringify({ grader: 'PSA', cert: '123456', email: 'synthetic@example.invalid' });
const post = (handler, data = body) => handler.onRequestPost({ env, request: new Request('https://example.invalid', {
  method: 'POST', body: data, duplex: 'half'
}) });

test('absolute body deadline cancels stalled request without awaiting stuck cancellation', async () => {
  let cancelled = false;
  const handler = api.createMarkIntake({ reviewed: true, timeoutMs: 20, fetcher() { assert.fail('no RPC'); } });
  const stream = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
  const result = await post(handler, stream);
  assert.equal(result.status, 400); assert.equal(cancelled, true);
});

test('bounded chunks reject zero-byte endless request streams', async () => {
  let cancelled = false, chunks = 0;
  const stream = new ReadableStream({ pull(c) { chunks++; c.enqueue(new Uint8Array()); }, cancel() { cancelled = true; } });
  assert.equal((await post(api.createMarkIntake({ reviewed: true }), stream)).status, 400);
  assert.ok(chunks <= 258); assert.equal(cancelled, true);
});

test('RPC headers, response body and oversized response are bounded with generic errors', async () => {
  for (const fetcher of [() => new Promise(() => {}), async () => new Response(new ReadableStream()),
    async () => new Response('x'.repeat(4097)), async () => new Response(new Uint8Array([255]))]) {
    const handler = api.createMarkIntake({ reviewed: true, timeoutMs: 20, fetcher });
    const r = await post(handler);
    assert.equal(r.status, 502); assert.doesNotMatch(await r.text(), /synthetic|Body|Deadline/);
    assert.equal((await handler.onRequestGet({ env })).status, 503);
  }
});

const manifest = () => ({ contract: 'mark-legacy-reconciliation-v1',
  snapshot: { reference: 'SYNTHETIC-SNAPSHOT', sha256: 'a'.repeat(64), complete: true, rowCount: 1 },
  historicalUsed: 14, usageReference: 'SYNTHETIC-USAGE', records: [{ legacyId: 'legacy-1',
    targetId: '00000000-0000-0000-0000-000000000001', grader: 'PSA', cert: '123456', status: 'requested',
    free: true, disposition: 'import-requested', reference: 'SYNTHETIC-MAPPING' }],
  approvals: Object.fromEntries(['schemaReview','policy','identityContactRules','legacyWriteFreeze',
    'legacyGrantClosure','contactOperations','abuseControls','gatewayPrivileges','stagingRehearsal'].map(k => [k, null])) });

test('reconciliation preserves explicit history and mapping; evidence is not launch approval', () => {
  const m = manifest(), plan = planCutover(m);
  assert.equal(plan.historicalUsed, 14); assert.deepEqual(plan.mapping, m.records);
  assert.equal(plan.blockers.length, 9); assert.equal(plan.evidenceComplete, false);
  for (const key of Object.keys(m.approvals)) m.approvals[key] = 'SYNTHETIC-OWNER-REF';
  const complete = planCutover(m);
  assert.equal(complete.evidenceComplete, true);
  assert.equal(complete.activationAuthorized, false);
  assert.equal(complete.publicIntakeEnabled, false); assert.equal(complete.paymentsEnabled, false);
});

test('unknown usage, incomplete export, ambiguous mapping and contact-bearing inputs fail closed', () => {
  const mutations = [m => { m.historicalUsed = null; }, m => { m.historicalUsed = 0; },
    m => { m.snapshot.complete = false; }, m => { m.snapshot.rowCount = 0; },
    m => { m.records[0].grader = 'UNKNOWN'; }, m => { m.records[0].cert = 123456; }, m => { m.records[0].free = null; },
    m => { m.records[0].status = 'fulfilled'; }, m => { m.records[0].email = 'private@example.invalid'; },
    m => { m.records.push({ ...m.records[0], legacyId: 'legacy-2' }); m.snapshot.rowCount++; },
    m => { m.usageReference = null; }, m => { m.approvals.policy = true; }];
  for (const mutate of mutations) { const m = manifest(); mutate(m); assert.throws(() => planCutover(m)); }
  const empty = manifest(); empty.records = []; empty.snapshot.rowCount = 0; empty.historicalUsed = null;
  assert.throws(() => planCutover(empty), /VERIFIED_USAGE_REQUIRED/);
});

test('retained historical statuses never become requested or silently permit cutover', () => {
  const m = manifest(); Object.assign(m.records[0], { status: 'fulfilled', disposition: 'retain-legacy', targetId: null });
  const plan = planCutover(m);
  assert.equal(plan.mapping[0].status, 'fulfilled'); assert.equal(plan.retained, 1);
  assert.ok(plan.blockers.includes('RETAINED_IDENTITIES_NEED_APPROVED_EXCLUSION_MAPPING'));
});

test('CLI is dry-run only, redacts output, refuses symlinks and never leaks parser excerpts', async () => {
  const root = await mkdtemp('/tmp/opencode/mark-cutover-cli-');
  const cli = new URL('../scripts/mark-cutover.mjs', import.meta.url).pathname;
  const run = args => promisify(execFile)(process.execPath, [cli, ...args], {
    env: { PATH: '/usr/bin:/bin' }, timeout: 5000
  }).then(value => ({ code: 0, ...value }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
  try {
    const file = root + '/synthetic.json';
    await writeFile(file, JSON.stringify(manifest()));
    const blocked = await run(['--dry-run', file]);
    assert.equal(blocked.code, 2);
    assert.doesNotMatch(blocked.stdout + blocked.stderr, /123456|legacy-1|targetId|example.invalid/);
    assert.equal(JSON.parse(blocked.stdout).historicalUsed, 14);
    const m = manifest();
    for (const key of Object.keys(m.approvals)) m.approvals[key] = 'SYNTHETIC';
    await writeFile(file, JSON.stringify(m));
    const complete = await run(['--dry-run', file]);
    assert.equal(complete.code, 0); assert.equal(JSON.parse(complete.stdout).activationAuthorized, false);
    assert.equal((await run(['--apply', file])).code, 1);
    await symlink(file, root + '/symlink');
    assert.equal((await run(['--dry-run', root + '/symlink'])).code, 1);
    await writeFile(file, '{"email":"DO-NOT-DISCLOSE@example.invalid", broken');
    const bad = await run(['--dry-run', file]);
    assert.equal(bad.code, 1); assert.equal(bad.stdout, '');
    assert.doesNotMatch(bad.stderr, /DO-NOT-DISCLOSE|example.invalid|synthetic.json/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('owner-only contact access/erasure is audited, atomic and never refunds or repopulates contact', async () => {
  assert.ok(process.env.MARK_TEST_PGLITE, 'Explicit isolated MARK_TEST_PGLITE required');
  const { PGlite } = await import(pathToFileURL(process.env.MARK_TEST_PGLITE));
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role;');
    for (const name of ['20261107_mark_intake_v2.sql', '20261107_mark_contact_ops.sql']) {
      await db.exec(await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8'));
    }
    await db.exec(`update mark_intake_private.policy set approved=true, legacy_reconciled=true,
      scope='global', used=9, approval_reference='SYNTHETIC';`);
    const first = (await db.query(`select public.claim_mark_v2('PSA','123456','original@example.invalid') d`)).rows[0].d;
    const id = first.id;
    await db.query(`update mark_intake_private.requests set created_at='2020-01-01' where id=$1`, [id]);
    for (const role of ['anon', 'authenticated', 'service_role', 'mark_intake_rpc']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query(`select mark_intake_private.read_contact($1,'SYNTHETIC')`, [id]), /permission denied/);
      await assert.rejects(db.query(`select mark_intake_private.erase_contacts(array[$1::uuid],now(),'SYNTHETIC')`, [id]), /permission denied/);
      await assert.rejects(db.query(`select * from mark_intake_private.contact_audit`), /permission denied/);
      await db.exec('reset role');
    }
    await assert.rejects(db.query(`select mark_intake_private.read_contact($1,' ')`, [id]), /reference required/);
    const read = await db.query(`select mark_intake_private.read_contact($1,'SYNTHETIC-ACCESS') contact`, [id]);
    assert.equal(read.rows[0].contact, 'original@example.invalid');
    // First erasure must roll back when a later selected identity is absent.
    await assert.rejects(db.query(`select mark_intake_private.erase_contacts(
      array[$1::uuid,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid],'2021-01-01','SYNTHETIC')`, [id]), /selection mismatch/);
    assert.equal((await db.query(`select email from mark_intake_private.requests where id=$1`, [id])).rows[0].email, 'original@example.invalid');
    for (const selection of ['null::uuid[]', 'array[]::uuid[]', 'array[null::uuid]', `array['${id}'::uuid,'${id}'::uuid]`]) {
      await assert.rejects(db.query(`select mark_intake_private.erase_contacts(${selection},now(),'SYNTHETIC')`), /bounded erasure/);
    }
    await assert.rejects(db.query(`select mark_intake_private.erase_contacts(array[$1::uuid],'2019-01-01','SYNTHETIC')`, [id]), /selection mismatch/);
    const erase = () => db.query(`select mark_intake_private.erase_contacts(array[$1::uuid],'2021-01-01','SYNTHETIC-RETENTION') n`, [id]);
    assert.equal((await erase()).rows[0].n, 1);
    assert.equal((await erase()).rows[0].n, 0);
    const retry = (await db.query(`select public.claim_mark_v2('PSA','123456','replacement@example.invalid') d`)).rows[0].d;
    assert.equal(retry.id, id); assert.equal(retry.free, true); assert.equal(retry.existing, true);
    assert.equal((await db.query(`select email from mark_intake_private.requests where id=$1`, [id])).rows[0].email, null);
    assert.equal((await db.query('select used from mark_intake_private.policy')).rows[0].used, 10);
    const audits = (await db.query('select * from mark_intake_private.contact_audit order by event_id')).rows;
    assert.deepEqual(audits.map(a => a.action), ['read', 'erase']);
    assert.ok(audits.every(a => a.actor && a.reference && !('email' in a)));
  } finally { await db.close(); }
});
