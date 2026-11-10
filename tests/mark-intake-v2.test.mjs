import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Explicit isolated engine path; never reads credentials or contacts a backend.
if (!process.env.MARK_TEST_PGLITE) throw new Error('Set MARK_TEST_PGLITE to the isolated @electric-sql/pglite dist/index.js');
const { PGlite } = await import(pathToFileURL(process.env.MARK_TEST_PGLITE));
const source = await fs.readFile(new URL('../functions/api/mark-request.js', import.meta.url), 'utf8');
const api = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const migration = await fs.readFile(new URL('../supabase/migrations/20261107_mark_intake_v2.sql', import.meta.url), 'utf8');
const env = { MARK_INTAKE_API_KEY: 'local-test-only', MARK_INTAKE_RPC_TOKEN: 'local-scoped-test-only', MARK_INTAKE_GATE: 'local-gate-test-only',
  SUPABASE_SERVICE_KEY: 'must-not-be-used', MARK_PAYMENTS_ENABLED: 'true', PAY_LINK: 'https://example.invalid/pay' };
const input = (cert = '109863355', grader = 'PSA', email = 'test@example.invalid') => ({ cert, grader, email });
const request = body => new Request('https://example.invalid/api/mark-request', { method: 'POST', body: JSON.stringify(body) });
const post = (handler, body = input(), config = env) => handler.onRequestPost({ request: request(body), env: config });

async function fixture() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  await db.exec(migration);
  const calls = [];
  const fetcher = async (url, opts) => {
    assert.equal(opts.headers.Authorization, 'Bearer local-scoped-test-only');
    assert.equal(opts.headers.apikey, 'local-test-only');
    const name = url.split('/').at(-1);
    assert.ok(['claim_mark_v2', 'mark_intake_status_v2'].includes(name));
    const b = JSON.parse(opts.body); calls.push({ name, body: b });
    try {
      const result = name === 'claim_mark_v2'
        ? await db.query('select public.claim_mark_v2($1,$2,$3) as d', [b.p_grader, b.p_cert, b.p_email])
        : await db.query('select public.mark_intake_status_v2() as d');
      return Response.json(result.rows[0].d);
    } catch (e) { return Response.json({ error: 'private database detail' }, { status: e.code === 'PT409' ? 409 : 500 }); }
  };
  const handler = api.createMarkIntake({ reviewed: true, fetcher });
  const approve = async (used = 0) => db.query(`update mark_intake_private.policy set approved=true,
    legacy_reconciled=true, scope='global', used=$1, approval_reference='LOCAL FIXTURE ONLY'`, [used]);
  return { db, handler, calls, approve };
}

test('real migration starts closed; neither environment nor RPC defaults open acceptance', async () => {
  const f = await fixture();
  try {
    assert.equal((await post(f.handler)).status, 503);
    assert.equal((await f.db.query('select count(*)::int n from mark_intake_private.requests')).rows[0].n, 0);
    // The exported handler's source gate is open (owner-approved 2026-11-07), so it would
    // reach the production RPC. Stub transport: no production call, and an unreachable
    // backend must fail closed (no accepted request, no payment link).
    const oldFetch = globalThis.fetch, urls = [];
    globalThis.fetch = async url => { urls.push(String(url)); throw new Error('network forbidden in tests'); };
    try {
      const r = await post(api);
      const d = await r.json();
      assert.ok(r.status >= 500, 'unreachable backend must not accept');
      assert.equal(d.ok, false); assert.notEqual(d.intakeStatus, 'accepted');
      assert.equal(d.payUrl, null); assert.equal(d.paymentStatus, 'inactive');
      assert.ok(urls.every(u => u.endsWith('/rest/v1/rpc/claim_mark_v2')), 'only the stubbed intake RPC');
    } finally { globalThis.fetch = oldFetch; }
  } finally { await f.db.close(); }
});

test('concurrent duplicate submissions, grader separation, original contact and atomic ten-free boundary', async () => {
  const f = await fixture();
  try {
    await f.approve(8); // historical usage retained, NOT ten newly allocated slots
    const results = await Promise.all(Array.from({ length: 12 }, () => post(f.handler, input()).then(r => r.json())));
    assert.equal(results.filter(d => !d.existing).length, 1);
    assert.equal(new Set(results.map(d => d.id)).size, 1);
    for (const d of results) { assert.equal(d.ok, true); assert.equal(d.free, true); assert.equal(d.remaining, 1); }
    const cgc = await (await post(f.handler, input('109863355', 'CGC'))).json();
    assert.equal(cgc.free, true); assert.equal(cgc.remaining, 0); assert.notEqual(cgc.id, results[0].id);
    const old = await (await post(f.handler, input('109863355', 'PSA', 'different@example.invalid'))).json();
    assert.equal(old.free, true); assert.equal(old.existing, true);
    assert.equal((await f.db.query(`select email from mark_intake_private.requests where grader='PSA'`)).rows[0].email, 'test@example.invalid');
    const exhausted = await Promise.all(Array.from({ length: 12 }, (_, i) => post(f.handler, input(String(200000 + i))).then(r => r.json())));
    for (const d of exhausted) { assert.equal(d.free, false); assert.equal(d.remaining, 0); assert.equal(d.payUrl, null); assert.equal(d.paymentStatus, 'inactive'); }
    assert.equal((await f.db.query('select used from mark_intake_private.policy')).rows[0].used, 10);
    assert.deepEqual(Object.keys(f.calls[0].body).sort(), ['p_cert', 'p_email', 'p_grader', 'p_token']);
  } finally { await f.db.close(); }
});

test('distinct concurrent requests cannot exceed last remaining complimentary slot', async () => {
  const f = await fixture();
  try {
    await f.approve(9);
    const ds = await Promise.all(Array.from({ length: 20 }, (_, i) => post(f.handler, input(String(300000 + i))).then(r => r.json())));
    assert.equal(ds.filter(d => d.free).length, 1);
    assert.equal(ds.filter(d => !d.free).length, 19);
  } finally { await f.db.close(); }
});

test('insert failure rolls back allowance; retry succeeds and lost-response retry deduplicates', async () => {
  const f = await fixture();
  try {
    await f.approve(9);
    await f.db.exec(`create function mark_intake_private.test_fail() returns trigger language plpgsql as $$
      begin raise exception 'forced failure'; end $$;
      create trigger force_failure after insert on mark_intake_private.requests
      for each row execute function mark_intake_private.test_fail();`);
    assert.equal((await post(f.handler)).status, 502);
    assert.equal((await f.db.query('select used from mark_intake_private.policy')).rows[0].used, 9);
    await f.db.exec('drop trigger force_failure on mark_intake_private.requests');
    await f.db.exec(`create trigger force_counter_failure after update on mark_intake_private.policy
      for each row execute function mark_intake_private.test_fail();`);
    assert.equal((await post(f.handler)).status, 502);
    assert.equal((await f.db.query('select used from mark_intake_private.policy')).rows[0].used, 9);
    assert.equal((await f.db.query('select count(*)::int n from mark_intake_private.requests')).rows[0].n, 0);
    await f.db.exec('drop trigger force_counter_failure on mark_intake_private.policy');
    let accepted;
    const lostResponse = api.createMarkIntake({ reviewed: true, fetcher: async (url, opts) => {
      // Commit in the embedded DB, then simulate transport loss before delivery.
      const b = JSON.parse(opts.body);
      accepted = (await f.db.query('select public.claim_mark_v2($1,$2,$3) as d', [b.p_grader,b.p_cert,b.p_email])).rows[0].d;
      throw new Error('simulated lost response');
    } });
    assert.equal((await post(lostResponse)).status, 502);
    const retry = await (await post(f.handler)).json();
    assert.equal(accepted.free, true); assert.equal(retry.id, accepted.id); assert.equal(retry.existing, true);
    assert.equal((await f.db.query('select used from mark_intake_private.policy')).rows[0].used, 10);
  } finally { await f.db.close(); }
});

test('database validates fields, preserves imported free/nonfree decisions and over-limit history', async () => {
  const f = await fixture();
  try {
    for (const args of [['OTHER','123456','a@example.invalid'], ['PSA','000000','a@example.invalid'],
      ['PSA','123456','bad'], ['PSA','123456','A@EXAMPLE.INVALID'], [null,'123456','a@example.invalid']]) {
      await assert.rejects(f.db.query('select public.claim_mark_v2($1,$2,$3)', args), /Invalid intake fields/);
    }
    await f.db.exec(`insert into mark_intake_private.requests(grader,cert,email,free) values
      ('PSA','123456','original@example.invalid',true), ('PSA','123457','original@example.invalid',false)`);
    await f.approve(14);
    for (const [cert, free] of [['123456', true], ['123457', false]]) {
      const d = await (await post(f.handler, input(cert))).json();
      assert.equal(d.free, free); assert.equal(d.existing, true); assert.equal(d.remaining, 0);
    }
    assert.equal((await f.db.query('select used from mark_intake_private.policy')).rows[0].used, 14);
  } finally { await f.db.close(); }
});

test('least privilege: scoped role can only execute intake RPCs; public roles cannot execute or read', async () => {
  const f = await fixture();
  try {
    await f.approve();
    for (const role of ['anon', 'authenticated', 'service_role', 'mark_intake_rpc']) {
      await f.db.exec(`set role ${role}`);
      await assert.rejects(f.db.query('select * from mark_intake_private.requests'), /permission denied/);
      await assert.rejects(f.db.query('update mark_intake_private.policy set approved=true'), /permission denied/);
      if (role === 'mark_intake_rpc') {
        const d = (await f.db.query(`select public.claim_mark_v2('PSA','123456','a@example.invalid') as d`)).rows[0].d;
        assert.equal(d.free, true);
        assert.equal((await f.db.query('select public.mark_intake_status_v2() as d')).rows[0].d.remaining, 9);
      } else await assert.rejects(f.db.query('select public.mark_intake_status_v2()'), /permission denied/);
      if (role !== 'mark_intake_rpc') await assert.rejects(f.db.query(`select public.claim_mark_v2('PSA','123456','a@example.invalid')`), /permission denied/);
      await f.db.exec('reset role');
    }
    assert.equal((await f.db.query(`select count(*)::int n from pg_policies where schemaname='mark_intake_private'`)).rows[0].n, 0);
    const rls = await f.db.query(`select relrowsecurity from pg_class where oid in ('mark_intake_private.requests'::regclass,'mark_intake_private.policy'::regclass)`);
    assert.ok(rls.rows.every(r => r.relrowsecurity));
  } finally { await f.db.close(); }
});

test('handler bounds inputs, normalizes formatted identity and refuses unsafe responses without disclosure', async () => {
  const f = await fixture();
  try {
    await f.approve();
    const d = await (await post(f.handler, input(' 00109-863-355 ', ' psa ', ' TEST@EXAMPLE.INVALID '))).json();
    assert.equal(d.cert, '109863355'); assert.equal(d.grader, 'PSA');
    for (const b of [null, [], input('000000'), input('123456abc'), input('123456', 'OTHER'), input('123456','PSA','x\ny@example.invalid')]) {
      assert.equal((await post(f.handler, b)).status, 400);
    }
    assert.equal((await post(f.handler, { ...input(), padding: 'x'.repeat(4096) })).status, 413);
    assert.equal((await post(f.handler, input(), { SUPABASE_SERVICE_KEY: 'no-fallback' })).status, 503);
    for (const fetcher of [async () => { throw new Error('private detail'); }, async () => Response.json({ private: 'detail' }, {status: 500}),
      async () => Response.json({}), async () => Response.json({...d, contract:'mark-intake-v2', policy_scope:'global', freeLimit:10, grader:'CGC'})]) {
      const r = await post(api.createMarkIntake({reviewed:true, fetcher}));
      assert.equal(r.status, 502); assert.doesNotMatch(await r.text(), /private|Bearer|detail/);
    }
    const status = await (await f.handler.onRequestGet({env})).json();
    assert.equal(status.freeLeft, 9); assert.equal(status.paymentStatus, 'inactive'); assert.equal(status.payUrl, null);
  } finally { await f.db.close(); }
});

test('production gates never touch credentials or transport, including status and webhook', async () => {
  const forbiddenEnv = new Proxy({}, { get() { throw new Error('credential access forbidden'); } });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network forbidden'); };
  try {
    // Source intake gate is open (INTAKE_AVAILABLE = true, owner-approved 2026-11-07), so the
    // handler now reads its scoped bindings for both PSA and CGC (grader-scoped v2 storage); an
    // unreadable environment must still fail closed with no transport, no accepted request and
    // no payment link (502 "uncertain", previously 503 "unavailable" while the gate was closed).
    for (const grader of ['PSA', 'CGC']) {
      const r = await post(api, input('123456', grader), forbiddenEnv);
      assert.equal(r.status, 502);
      const d = await r.json();
      assert.equal(d.ok, false); assert.notEqual(d.intakeStatus, 'accepted');
      assert.equal(d.payUrl, null); assert.equal(d.paymentStatus, 'inactive');
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await api.onRequestGet({ env: forbiddenEnv })).status, 503);
    const webhookSource = await fs.readFile(new URL('../functions/api/stripe-webhook.js', import.meta.url), 'utf8');
    const webhook = await import('data:text/javascript;base64,' + Buffer.from(webhookSource).toString('base64'));
    assert.equal((await webhook.onRequestPost({ env: forbiddenEnv,
      request: { text() { throw new Error('body access forbidden'); } } })).status, 503);
  } finally { globalThis.fetch = oldFetch; }
});

test('reviewed handler rejects malformed status/claim contracts and missing scoped credentials', async () => {
  const valid = {contract:'mark-intake-v2', policy_scope:'global', freeLimit:10, remaining:0,
    id:'00000000-0000-0000-0000-000000000001', grader:'PSA', cert:'109863355', status:'requested', free:false, existing:false};
  for (const patch of [{contract:'legacy'}, {policy_scope:'per_user'}, {freeLimit:11}, {remaining:-1},
    {remaining:11}, {remaining:0.5}, {remaining:null}]) {
    const handler = api.createMarkIntake({reviewed:true, fetcher:async () => Response.json({...valid,...patch})});
    assert.equal((await post(handler)).status, 502);
    assert.equal((await handler.onRequestGet({env})).status, 503);
  }
  for (const patch of [{id:1}, {id:'invalid'}, {status:'paid'}, {cert:'123456'}, {free:1}, {existing:null}]) {
    const handler = api.createMarkIntake({reviewed:true, fetcher:async () => Response.json({...valid,...patch})});
    assert.equal((await post(handler)).status, 502);
  }
  for (const config of [{}, {MARK_INTAKE_API_KEY:'only'}, {MARK_INTAKE_RPC_TOKEN:'only'},
    {SUPABASE_SERVICE_KEY:'forbidden-fallback'}]) {
    const handler = api.createMarkIntake({reviewed:true, fetcher:async () => assert.fail('must not contact gateway')});
    assert.equal((await post(handler, input(), config)).status, 503);
    assert.equal((await handler.onRequestGet({env:config})).status, 503);
  }
});

test('streamed bytes override false content length; invalid UTF-8 and broken streams never reach RPC', async () => {
  const handler = api.createMarkIntake({reviewed:true, fetcher:async () => assert.fail('must not reach RPC')});
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2048)); controller.enqueue(new Uint8Array(2049)); },
    cancel() { cancelled = true; }
  });
  const r = await handler.onRequestPost({env, request:new Request('https://example.invalid', {
    method:'POST', body:stream, duplex:'half', headers:{'content-length':'1'}
  })});
  assert.equal(r.status, 413); assert.equal(cancelled, true);
  for (const body of [new Uint8Array([0xff]), '{', new ReadableStream({start(c) {c.error(new Error('synthetic stream failure'));}})]) {
    const r = await handler.onRequestPost({env, request:new Request('https://example.invalid', {
      method:'POST', body, duplex:'half'
    })});
    assert.equal(r.status, 400);
  }
});
